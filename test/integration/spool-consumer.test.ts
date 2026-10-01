import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { SpoolConsumer } from "../../src/bridge/spool-consumer";
import type { WindowLease } from "../../src/bridge/window-lease";
import type { WindowsNotificationQueue } from "../../src/notification/windows-notifier";
import { sha256 } from "../../src/protocol";
import type { BridgeEvent } from "../../src/types";
import { workspaceUris } from "../../src/workspace-paths";

const mock = vscode as typeof vscode & {
  __reset(): void;
  __setWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void;
  __setConfig(name: string, value: unknown): void;
  __readText(uri: vscode.Uri): Promise<string>;
  __setMtime(uri: vscode.Uri, mtime: number): void;
  __watcherCount(): number;
};

const folder: vscode.WorkspaceFolder = {
  uri: vscode.Uri.parse("vscode-remote://ssh-remote/workspace"),
  name: "workspace",
  index: 0,
};

async function fixture(
  focused = false,
  onEnqueue?: () => void,
  notifyOk = true,
) {
  const uris = workspaceUris(folder);
  for (const directory of [
    uris.managedRoot,
    uris.runtimeDir,
    uris.pendingDir,
    uris.inflightDir,
    uris.ackDir,
  ]) {
    await vscode.workspace.fs.createDirectory(directory);
  }
  const hook = Buffer.from("// managed hook", "utf8");
  await vscode.workspace.fs.writeFile(uris.hookFile, hook);
  const installationId = "123e4567-e89b-12d3-a456-426614174000";
  await vscode.workspace.fs.writeFile(
    uris.installFile,
    Buffer.from(
      JSON.stringify({
        product: "claude-remote-notifier",
        protocolVersion: 2,
        extensionVersion: "0.2.0",
        installationId,
        hookSha256: sha256(hook),
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    ),
  );
  const notifications: Array<{ title: string; message: string }> = [];
  const queue = {
    async enqueue(request: { title: string; message: string }) {
      onEnqueue?.();
      notifications.push(request);
      return { ok: notifyOk };
    },
  } as WindowsNotificationQueue;
  const lease = {
    instanceId: randomUUID(),
    isOwner: () => true,
    anyWindowFocused: () => focused,
  } as WindowLease;
  const consumer = new SpoolConsumer(folder, lease, queue, () => {});
  return { uris, installationId, notifications, consumer };
}

async function writeEvent(
  pendingDir: vscode.Uri,
  installationId: string,
  kind: BridgeEvent["kind"],
): Promise<void> {
  const event: BridgeEvent = {
    schemaVersion: 2,
    installationId,
    eventId: randomUUID(),
    kind,
    createdAt: Date.now(),
    sessionHash: "0123456789abcdef",
  };
  const name = `${event.createdAt}-${kind}-${event.eventId}.json`;
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(pendingDir, name),
    Buffer.from(JSON.stringify(event), "utf8"),
  );
}

beforeEach(() => {
  mock.__reset();
  mock.__setWorkspaceFolders([folder]);
});

afterEach(() => vi.restoreAllMocks());

describe("spool consumer", () => {
  it("claims, notifies, acknowledges, and deletes an event", async () => {
    const { uris, installationId, notifications, consumer } = await fixture();
    await writeEvent(uris.pendingDir, installationId, "permission");
    await consumer.start();
    expect(notifications).toHaveLength(1);
    expect(
      await vscode.workspace.fs.readDirectory(uris.pendingDir),
    ).toHaveLength(0);
    expect(
      await vscode.workspace.fs.readDirectory(uris.inflightDir),
    ).toHaveLength(0);
    const acks = await vscode.workspace.fs.readDirectory(uris.ackDir);
    expect(acks).toHaveLength(1);
    expect(
      await mock.__readText(vscode.Uri.joinPath(uris.ackDir, acks[0]![0])),
    ).toContain('"status":"shown"');
    consumer.dispose();
  });

  it("suppresses completion while focused but always shows attention events", async () => {
    const { uris, installationId, notifications, consumer } =
      await fixture(true);
    await writeEvent(uris.pendingDir, installationId, "stop");
    await writeEvent(uris.pendingDir, installationId, "question");
    await consumer.start();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toMatch(/waiting/i);
    const acks = await vscode.workspace.fs.readDirectory(uris.ackDir);
    const statuses = await Promise.all(
      acks.map(
        async ([name]) =>
          JSON.parse(
            await mock.__readText(vscode.Uri.joinPath(uris.ackDir, name)),
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual(["shown", "suppressed"]);
    consumer.dispose();
  });

  it("stays idle when the installed hook hash is modified", async () => {
    const { uris, installationId, notifications, consumer } = await fixture();
    await writeEvent(uris.pendingDir, installationId, "permission");
    await vscode.workspace.fs.writeFile(
      uris.hookFile,
      Buffer.from("modified", "utf8"),
    );
    await consumer.start();
    expect(notifications).toHaveLength(0);
    expect(
      await vscode.workspace.fs.readDirectory(uris.pendingDir),
    ).toHaveLength(1);
    consumer.dispose();
  });

  it("creates only one watcher under concurrent start calls", async () => {
    const { consumer } = await fixture();
    await Promise.all([consumer.start(), consumer.start(), consumer.start()]);
    expect(mock.__watcherCount()).toBe(1);
    consumer.dispose();
    expect(mock.__watcherCount()).toBe(0);
  });

  it("periodically recovers an inflight event skipped as too recent at startup", async () => {
    const { uris, installationId, notifications, consumer } = await fixture();
    await writeEvent(uris.pendingDir, installationId, "permission");
    const pendingEntries = await vscode.workspace.fs.readDirectory(
      uris.pendingDir,
    );
    const [name] = pendingEntries[0]!;
    const inflight = vscode.Uri.joinPath(
      uris.inflightDir,
      `${name}.${randomUUID()}`,
    );
    await vscode.workspace.fs.rename(
      vscode.Uri.joinPath(uris.pendingDir, name),
      inflight,
      { overwrite: false },
    );
    await consumer.start();
    expect(notifications).toHaveLength(0);
    mock.__setMtime(inflight, Date.now() - 3 * 60 * 1000);
    (
      consumer as unknown as { lastInflightRecoveryAt: number }
    ).lastInflightRecoveryAt = 0;
    await consumer.poll();
    expect(notifications).toHaveLength(1);
    expect(
      await vscode.workspace.fs.readDirectory(uris.inflightDir),
    ).toHaveLength(0);
    consumer.dispose();
  });

  it("uses the poll start time so queued notifications do not expire each other", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { uris, installationId, notifications, consumer } = await fixture(
      false,
      () => {
        now += 11 * 60 * 1000;
      },
    );
    await writeEvent(uris.pendingDir, installationId, "permission");
    await writeEvent(uris.pendingDir, installationId, "question");
    await consumer.start();
    expect(notifications).toHaveLength(2);
    consumer.dispose();
  });

  it("does not let unknown inflight entries starve a valid recoverable event", async () => {
    const { uris, installationId, notifications, consumer } = await fixture();
    for (let index = 0; index < 512; index += 1) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(uris.inflightDir, `unknown-${index}`),
        Buffer.from("unknown", "utf8"),
      );
    }
    await writeEvent(uris.pendingDir, installationId, "permission");
    const pendingEntries = await vscode.workspace.fs.readDirectory(
      uris.pendingDir,
    );
    const [name] = pendingEntries[0]!;
    const inflight = vscode.Uri.joinPath(
      uris.inflightDir,
      `${name}.${randomUUID()}`,
    );
    await vscode.workspace.fs.rename(
      vscode.Uri.joinPath(uris.pendingDir, name),
      inflight,
      { overwrite: false },
    );
    mock.__setMtime(inflight, Date.now() - 3 * 60 * 1000);
    await consumer.start();
    expect(notifications).toHaveLength(1);
    expect(
      await vscode.workspace.fs.readDirectory(uris.pendingDir),
    ).toHaveLength(0);
    consumer.dispose();
  });

  it("retains a failed notification for retry instead of dropping it", async () => {
    const { uris, installationId, consumer } = await fixture(
      false,
      undefined,
      false,
    );
    await writeEvent(uris.pendingDir, installationId, "permission");
    await consumer.start();
    expect(
      await vscode.workspace.fs.readDirectory(uris.inflightDir),
    ).toHaveLength(1);
    expect(await vscode.workspace.fs.readDirectory(uris.ackDir)).toHaveLength(
      0,
    );
    consumer.dispose();
  });

  it("still runs maintenance when the pending directory exceeds the entry limit", async () => {
    const { uris, consumer } = await fixture();
    const staleAck = vscode.Uri.joinPath(uris.ackDir, "stale.json");
    await vscode.workspace.fs.writeFile(staleAck, Buffer.from("{}", "utf8"));
    mock.__setMtime(staleAck, Date.now() - 25 * 60 * 60 * 1000);
    for (let index = 0; index < 2049; index += 1) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(uris.pendingDir, `junk-${index}`),
        Buffer.from("{}", "utf8"),
      );
    }
    await consumer.start();
    expect(await vscode.workspace.fs.readDirectory(uris.ackDir)).toHaveLength(
      0,
    );
    consumer.dispose();
  });
});
