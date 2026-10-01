import * as vscode from "vscode";
import { WindowsNotificationQueue } from "../notification/windows-notifier";
import { SpoolConsumer } from "./spool-consumer";
import { WindowLease } from "./window-lease";

class WorkspaceController implements vscode.Disposable {
  private readonly lease: WindowLease;
  private readonly consumer: SpoolConsumer;

  public constructor(
    public readonly folder: vscode.WorkspaceFolder,
    notifications: WindowsNotificationQueue,
    private readonly log: (...parts: string[]) => void,
  ) {
    this.lease = new WindowLease(
      folder.uri.toString(),
      () => vscode.window.state.focused,
      (owner) => {
        log(
          folder.name,
          owner ? "became event consumer owner" : "became follower",
        );
        if (owner) void this.startConsumerSafely();
        else this.consumer.stop();
      },
      (...parts) => log(folder.name, ...parts),
    );
    this.consumer = new SpoolConsumer(
      folder,
      this.lease,
      notifications,
      (...parts) => log(folder.name, ...parts),
    );
  }

  public start(): void {
    this.lease.start();
  }

  private async startConsumerSafely(): Promise<void> {
    try {
      await this.consumer.start();
    } catch (error) {
      this.log(
        this.folder.name,
        "consumer start failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async restartConsumer(): Promise<void> {
    this.consumer.stop();
    if (this.lease.isOwner()) await this.consumer.start();
  }

  public focusChanged(): void {
    this.lease.sendFocusUpdate();
  }

  public diagnostics(): Record<string, unknown> {
    return {
      name: this.folder.name,
      uri: this.folder.uri.toString(),
      owner: this.lease.isOwner(),
      anyWindowFocused: this.lease.anyWindowFocused(),
      ...this.consumer.diagnostics(),
    };
  }

  public dispose(): void {
    this.consumer.dispose();
    this.lease.dispose();
  }
}

export class WorkspaceManager implements vscode.Disposable {
  private readonly controllers = new Map<string, WorkspaceController>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly notifications: WindowsNotificationQueue,
    private readonly log: (...parts: string[]) => void,
  ) {}

  public start(): void {
    if (!vscode.workspace.isTrusted) return;
    this.syncFolders();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncFolders()),
      vscode.window.onDidChangeWindowState(() => {
        for (const controller of this.controllers.values())
          controller.focusChanged();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("claudeRemoteNotifier")) {
          for (const controller of this.controllers.values()) {
            void controller
              .restartConsumer()
              .catch((error: unknown) =>
                this.log(
                  controller.folder.name,
                  "consumer restart failed:",
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }
        }
      }),
    );
  }

  public async refresh(folder: vscode.WorkspaceFolder): Promise<void> {
    const controller = this.controllers.get(folder.uri.toString());
    if (controller) await controller.restartConsumer();
    else this.syncFolders();
  }

  public diagnostics(): Record<string, unknown>[] {
    return [...this.controllers.values()].map((controller) =>
      controller.diagnostics(),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
  }

  private syncFolders(): void {
    const folders = new Map(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "vscode-remote")
        .map((folder) => [folder.uri.toString(), folder]),
    );
    for (const [key, controller] of this.controllers) {
      if (!folders.has(key)) {
        controller.dispose();
        this.controllers.delete(key);
      }
    }
    for (const [key, folder] of folders) {
      if (this.controllers.has(key)) continue;
      const controller = new WorkspaceController(
        folder,
        this.notifications,
        this.log,
      );
      this.controllers.set(key, controller);
      controller.start();
    }
  }
}
