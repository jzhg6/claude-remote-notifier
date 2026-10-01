import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  ACK_RETENTION_MS,
  INFLIGHT_RECOVERY_MS,
  MAX_ACKS,
  MAX_DIRECTORY_ENTRIES,
  MAX_EVENT_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RUNTIME_HOOK_BYTES,
  MAX_SCAN_FILES,
  PRODUCT,
  PROTOCOL_VERSION,
} from "../constants";
import { workspaceUris } from "../workspace-paths";
import {
  eventIdHash,
  isCompletionKind,
  notificationText,
  parseBridgeEvent,
  sha256,
} from "../protocol";
import type {
  AckRecord,
  AckStatus,
  DiagnosticState,
  InstallManifest,
} from "../types";
import { WindowsNotificationQueue } from "../notification/windows-notifier";
import { atomicWrite, statOrUndefined } from "../setup/remote-files";
import { WindowLease } from "./window-lease";

export class SpoolConsumer implements vscode.Disposable {
  private readonly uris: ReturnType<typeof workspaceUris>;
  private watcher?: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private lifecycleVersion = 0;
  private polling = false;
  private manifest?: InstallManifest;
  private disposed = false;
  private remoteClockOffsetMs = 0;
  private runtimeVerified = false;
  private lastMaintenanceAt = 0;
  private lastInflightRecoveryAt = 0;
  private eventsSinceMaintenance = 0;
  private state: DiagnosticState = {
    pendingCount: 0,
    inflightCount: 0,
    ackCount: 0,
  };

  public constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly lease: WindowLease,
    private readonly notifications: WindowsNotificationQueue,
    private readonly log: (...parts: string[]) => void,
  ) {
    this.uris = workspaceUris(folder);
  }

  public start(): Promise<void> {
    if (this.disposed || this.watcher) return Promise.resolve();
    if (this.startPromise) return this.startPromise.then(() => this.start());
    const version = this.lifecycleVersion;
    const tracked = this.startInternal(version).finally(() => {
      if (this.startPromise === tracked) this.startPromise = undefined;
    });
    this.startPromise = tracked;
    return tracked;
  }

  private async startInternal(version: number): Promise<void> {
    this.manifest = await this.readManifest();
    if (!this.manifest) {
      this.log(this.folder.name, "is not set up; consumer remains idle");
      return;
    }
    await this.assertSafeRuntimePaths();
    await this.calibrateRemoteClock();
    this.runtimeVerified = true;
    if (this.disposed || version !== this.lifecycleVersion) return;
    const pattern = new vscode.RelativePattern(
      this.folder.uri,
      ".claude/claude-remote-notifier/spool/v2/pending/*.json",
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate(() => void this.poll());
    this.watcher.onDidChange(() => void this.poll());
    const interval = Math.max(
      1000,
      Math.min(
        60_000,
        vscode.workspace
          .getConfiguration("claudeRemoteNotifier", this.folder.uri)
          .get<number>("pollIntervalMs", 5000),
      ),
    );
    this.timer = setInterval(() => void this.poll(), interval);
    await this.recoverInflight();
    await this.cleanupMaintenanceFiles();
    await this.poll();
  }

  public stop(): void {
    this.lifecycleVersion += 1;
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.stop();
  }

  public diagnostics(): DiagnosticState {
    return { ...this.state };
  }

  public async poll(): Promise<void> {
    if (this.polling || this.disposed || !this.lease.isOwner()) return;
    if (!vscode.workspace.isTrusted) return;
    if (
      !vscode.workspace
        .getConfiguration("claudeRemoteNotifier", this.folder.uri)
        .get("enabled", true)
    ) {
      return;
    }
    this.polling = true;
    this.state.lastPollAt = Date.now();
    try {
      if (!this.manifest) this.manifest = await this.readManifest();
      if (!this.manifest) return;
      if (!this.runtimeVerified) {
        await this.assertSafeRuntimePaths();
        this.runtimeVerified = true;
      }
      if (this.remoteNow() - this.lastInflightRecoveryAt >= 30_000) {
        await this.recoverInflight();
      }
      const entries = await vscode.workspace.fs.readDirectory(
        this.uris.pendingDir,
      );
      this.state.pendingCount = entries.length;
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        // Skip claiming but still run maintenance so the directory can shrink.
        this.state.lastError = `pending directory has ${entries.length} entries; not consuming`;
      } else {
        const files = entries
          .filter(
            ([name, type]) =>
              type === vscode.FileType.File && isPendingName(name),
          )
          .map(([name]) => name)
          .sort(priorityCompare)
          .slice(0, MAX_SCAN_FILES);
        await Promise.all(files.map((name) => this.claimAndProcess(name)));
      }
      if (
        this.eventsSinceMaintenance >= 64 ||
        this.remoteNow() - this.lastMaintenanceAt >= 10 * 60 * 1000
      ) {
        await this.cleanupMaintenanceFiles();
      }
    } catch (error) {
      this.recordError(error);
    } finally {
      this.polling = false;
    }
  }

  private async claimAndProcess(name: string): Promise<void> {
    const pending = vscode.Uri.joinPath(this.uris.pendingDir, name);
    const inflight = vscode.Uri.joinPath(
      this.uris.inflightDir,
      `${name}.${this.lease.instanceId}`,
    );
    try {
      const stat = await vscode.workspace.fs.stat(pending);
      if (
        stat.type & vscode.FileType.SymbolicLink ||
        !(stat.type & vscode.FileType.File)
      )
        return;
      if (stat.size > MAX_EVENT_BYTES) {
        await this.claimInvalid(
          pending,
          inflight,
          name,
          "event file exceeds 4 KiB",
        );
        return;
      }
      await vscode.workspace.fs.rename(pending, inflight, { overwrite: false });
    } catch {
      return;
    }

    let status: AckStatus = "invalid";
    let ackKey = sha256(name);
    try {
      const bytes = await vscode.workspace.fs.readFile(inflight);
      const config = vscode.workspace.getConfiguration(
        "claudeRemoteNotifier",
        this.folder.uri,
      );
      const maxAgeMs = config.get<number>("maxEventAgeMs", 600_000);
      const event = parseBridgeEvent(
        bytes,
        this.manifest!.installationId,
        this.remoteNow(),
        maxAgeMs,
      );
      ackKey = eventIdHash(event.eventId);
      const existingAck = await statOrUndefined(
        vscode.Uri.joinPath(this.uris.ackDir, `${ackKey}.json`),
      );
      if (existingAck) {
        if (
          existingAck.type & vscode.FileType.SymbolicLink ||
          !(existingAck.type & vscode.FileType.File)
        ) {
          throw new Error("ack path is not a regular file");
        }
        await this.safeDelete(inflight);
        return;
      }
      this.state.lastEventAt = Date.now();
      if (!eventEnabled(event.kind, config)) {
        status = "suppressed";
      } else if (
        isCompletionKind(event.kind) &&
        this.lease.anyWindowFocused() &&
        !config.get("notifyWhenFocused", false)
      ) {
        status = "suppressed";
      } else {
        const text = notificationText(event.kind, event.toolName);
        const result = await this.notifications.enqueue({
          title: text.title,
          message: `${this.folder.name}: ${text.body}`,
        });
        status = result.ok ? "shown" : "failed";
        if (result.ok) this.state.lastNotificationAt = Date.now();
        else this.state.lastError = result.error;
      }
    } catch (error) {
      status = errorMessage(error).includes("expired") ? "expired" : "invalid";
      this.recordError(error);
    }

    if (status === "failed") {
      // Keep the inflight record so recovery retries it until it ages out and is
      // acknowledged as expired, preserving the documented at-least-once behavior.
      this.state.lastError =
        "notification delivery failed; event retained for retry";
      return;
    }

    try {
      await this.writeAck(ackKey, status);
      this.eventsSinceMaintenance += 1;
      await this.safeDelete(inflight);
    } catch (error) {
      this.recordError(error);
      // Keep inflight for crash recovery when an acknowledgement cannot be committed.
    }
  }

  private async claimInvalid(
    pending: vscode.Uri,
    inflight: vscode.Uri,
    name: string,
    reason: string,
  ): Promise<void> {
    try {
      await vscode.workspace.fs.rename(pending, inflight, { overwrite: false });
      await this.writeAck(sha256(name), "invalid");
      await this.safeDelete(inflight);
      this.state.lastError = reason;
    } catch (error) {
      this.recordError(error);
    }
  }

  private async writeAck(hash: string, status: AckStatus): Promise<void> {
    const record: AckRecord = {
      schemaVersion: 1,
      eventIdHash: hash,
      status,
      processedAt: this.remoteNow(),
    };
    await atomicWrite(
      vscode.Uri.joinPath(this.uris.ackDir, `${hash}.json`),
      Buffer.from(JSON.stringify(record), "utf8"),
    );
  }

  private async recoverInflight(): Promise<void> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        this.uris.inflightDir,
      );
      this.state.inflightCount = entries.length;
      const candidates = entries
        .filter(
          ([name, type]) =>
            type === vscode.FileType.File &&
            /^(.+\.json)\.[a-f0-9-]+$/i.test(name),
        )
        .slice(0, MAX_SCAN_FILES);
      if (candidates.length < entries.length) {
        this.state.lastError = "Unknown inflight entries were retained.";
      }
      for (const [name] of candidates) {
        const uri = vscode.Uri.joinPath(this.uris.inflightDir, name);
        const stat = await vscode.workspace.fs.stat(uri);
        if (this.remoteNow() - stat.mtime < INFLIGHT_RECOVERY_MS) continue;
        const match = name.match(/^(.+\.json)\.[a-f0-9-]+$/i)!;
        try {
          await vscode.workspace.fs.rename(
            uri,
            vscode.Uri.joinPath(this.uris.pendingDir, match[1]!),
            {
              overwrite: false,
            },
          );
        } catch {}
      }
    } catch (error) {
      this.recordError(error);
    } finally {
      this.lastInflightRecoveryAt = this.remoteNow();
    }
  }

  private async cleanupMaintenanceFiles(): Promise<void> {
    await this.cleanupTemporaryFiles();
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uris.ackDir);
      this.state.ackCount = entries.length;
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
          `ack directory has ${entries.length} entries; refusing maintenance`,
        );
      }
      const candidates = entries.filter(
        ([name, type]) =>
          type === vscode.FileType.File && name.endsWith(".json"),
      );
      const files = await mapInBatches(candidates, 32, async ([name]) => {
        const uri = vscode.Uri.joinPath(this.uris.ackDir, name);
        const stat = await vscode.workspace.fs.stat(uri);
        return { uri, mtime: stat.mtime };
      });
      files.sort((a, b) => a.mtime - b.mtime);
      const overLimit = Math.max(0, files.length - MAX_ACKS);
      const expired = files.filter(
        (item, index) =>
          index < overLimit || this.remoteNow() - item.mtime > ACK_RETENTION_MS,
      );
      await mapInBatches(expired, 32, async (item) => {
        await this.safeDelete(item.uri);
      });
      this.lastMaintenanceAt = this.remoteNow();
      this.eventsSinceMaintenance = 0;
    } catch (error) {
      this.recordError(error);
    }
  }

  private async cleanupTemporaryFiles(): Promise<void> {
    for (const directory of [
      this.uris.pendingDir,
      this.uris.inflightDir,
      this.uris.ackDir,
      this.uris.managedRoot,
      this.uris.claudeDir,
    ]) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(directory);
        for (const [name, type] of entries.slice(0, MAX_SCAN_FILES)) {
          if (type !== vscode.FileType.File || !name.endsWith(".tmp")) continue;
          const uri = vscode.Uri.joinPath(directory, name);
          const stat = await vscode.workspace.fs.stat(uri);
          if (this.remoteNow() - stat.mtime > INFLIGHT_RECOVERY_MS) {
            await this.safeDelete(uri);
          }
        }
      } catch {}
    }
  }

  private remoteNow(): number {
    return Date.now() + this.remoteClockOffsetMs;
  }

  private async calibrateRemoteClock(): Promise<void> {
    const probe = vscode.Uri.joinPath(
      this.uris.spoolRoot,
      `.clock-${randomUUID()}.tmp`,
    );
    const before = Date.now();
    try {
      await vscode.workspace.fs.writeFile(probe, Buffer.from("clock", "utf8"));
      const stat = await vscode.workspace.fs.stat(probe);
      const after = Date.now();
      this.remoteClockOffsetMs = stat.mtime - Math.floor((before + after) / 2);
    } finally {
      await this.safeDelete(probe);
    }
  }

  private async assertSafeRuntimePaths(): Promise<void> {
    for (const uri of [
      this.uris.managedRoot,
      this.uris.spoolRoot,
      this.uris.pendingDir,
      this.uris.inflightDir,
      this.uris.ackDir,
    ]) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (
        stat.type & vscode.FileType.SymbolicLink ||
        !(stat.type & vscode.FileType.Directory)
      ) {
        throw new Error(`Unsafe managed directory: ${uri.toString()}`);
      }
    }
  }

  private async readManifest(): Promise<InstallManifest | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(this.uris.installFile);
      if (
        stat.type & vscode.FileType.SymbolicLink ||
        !(stat.type & vscode.FileType.File) ||
        stat.size > MAX_MANIFEST_BYTES
      ) {
        return undefined;
      }
      const raw = await vscode.workspace.fs.readFile(this.uris.installFile);
      const manifest = JSON.parse(
        Buffer.from(raw).toString("utf8"),
      ) as InstallManifest;
      if (
        manifest.product !== PRODUCT ||
        manifest.protocolVersion !== PROTOCOL_VERSION ||
        !/^[a-f0-9-]{36}$/i.test(manifest.installationId) ||
        !/^[a-f0-9]{64}$/i.test(manifest.hookSha256)
      ) {
        return undefined;
      }
      const hookStat = await vscode.workspace.fs.stat(this.uris.hookFile);
      if (
        hookStat.type & vscode.FileType.SymbolicLink ||
        !(hookStat.type & vscode.FileType.File) ||
        hookStat.size > MAX_RUNTIME_HOOK_BYTES
      ) {
        return undefined;
      }
      const hook = await vscode.workspace.fs.readFile(this.uris.hookFile);
      return sha256(hook) === manifest.hookSha256 ? manifest : undefined;
    } catch {
      return undefined;
    }
  }

  private async safeDelete(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {}
  }

  private recordError(error: unknown): void {
    this.state.lastError = errorMessage(error);
    this.log(this.folder.name, this.state.lastError);
  }
}

async function mapInBatches<T, R>(
  values: T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    const batch = values.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

function eventEnabled(
  kind: string,
  config: vscode.WorkspaceConfiguration,
): boolean {
  switch (kind) {
    case "stop":
      return config.get("notifyOnStop", true);
    case "stop_failure":
      return config.get("notifyOnStopFailure", true);
    case "permission":
      return config.get("notifyOnPermission", true);
    case "question":
      return config.get("notifyOnQuestion", true);
    case "subagent_stop":
      return config.get("notifyOnSubagentStop", false);
    default:
      return kind === "probe";
  }
}

function isPendingName(name: string): boolean {
  return /^\d{13}-(stop|stop_failure|permission|question|subagent_stop|probe)-[a-f0-9-]{36}\.json$/i.test(
    name,
  );
}

function priorityCompare(a: string, b: string): number {
  const priority = (name: string): number =>
    /-(permission|question|stop_failure)-/.test(name) ? 0 : 1;
  return priority(a) - priority(b) || a.localeCompare(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
