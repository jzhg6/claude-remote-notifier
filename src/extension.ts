import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { workspaceUris } from "./workspace-paths";
import { WorkspaceManager } from "./bridge/workspace-manager";
import { sha256 } from "./protocol";
import { WindowsNotificationQueue } from "./notification/windows-notifier";
import {
  assertRuntimePreconditions,
  cleanWorkspaceSpool,
  setupWorkspace,
  uninstallWorkspace,
  verifyWorkspace,
} from "./setup/installation";
import { atomicWrite, readTextOrDefault } from "./setup/remote-files";
import type { BridgeEvent, InstallManifest } from "./types";

let output: vscode.OutputChannel;
let manager: WorkspaceManager;
let notifications: WindowsNotificationQueue;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Claude Remote Notifier");
  context.subscriptions.push(output);
  const log = (...parts: string[]): void => {
    output.appendLine(`${new Date().toISOString()}  ${parts.join(" ")}`);
  };
  notifications = new WindowsNotificationQueue(log);
  manager = new WorkspaceManager(notifications, log);
  context.subscriptions.push(manager);

  registerCommands(context, log);
  if (vscode.workspace.isTrusted) manager.start();
  else {
    log(
      "workspace is not trusted; remote setup and event consumption are disabled",
    );
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        log("workspace trust granted; starting workspace manager");
        manager.start();
      }),
    );
  }
  log(
    "activated",
    `version=${String(context.extension.packageJSON.version)}`,
    `platform=${process.platform}`,
    `remoteName=${String(vscode.env.remoteName)}`,
    `trusted=${String(vscode.workspace.isTrusted)}`,
  );
}

export function deactivate(): void {
  // All resources are registered on the extension context and disposed by VS Code.
}

function registerCommands(
  context: vscode.ExtensionContext,
  log: (...parts: string[]) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRemoteNotifier.setup", async () => {
      const folder = await chooseFolder(
        "Set up notifications in which Remote-SSH workspace?",
      );
      if (!folder) return;
      assertRuntimePreconditions(folder);
      const confirm = await vscode.window.showWarningMessage(
        `Install the managed bridge under ${folder.name}/.claude and merge four notification hooks into settings.local.json?`,
        { modal: true },
        "Set Up",
      );
      if (confirm !== "Set Up") return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Setting up ${folder.name}…`,
        },
        async () => {
          const result = await setupWorkspace(context, folder);
          await manager.refresh(folder);
          if (!result.ok) throw new Error(result.issues.join(" "));
        },
      );
      void vscode.window.showInformationMessage(
        `Claude Remote Notifier is set up in ${folder.name}. Start a new Claude Code session so it reloads hooks.`,
      );
    }),
    vscode.commands.registerCommand("claudeRemoteNotifier.verify", async () => {
      const folder = await chooseFolder("Verify which Remote-SSH workspace?");
      if (!folder) return;
      const result = await verifyWorkspace(context, folder);
      output.show(true);
      log(`verify ${folder.name}: ${result.ok ? "OK" : "FAILED"}`);
      for (const issue of result.issues) log(`  - ${issue}`);
      log(
        `  managedHooks=${result.managedHookCount}`,
        `legacyHooks=${String(result.hasLegacy)}`,
      );
      if (result.ok)
        void vscode.window.showInformationMessage(
          `Setup verified for ${folder.name}.`,
        );
      else
        void vscode.window.showErrorMessage(
          `Setup verification failed. See Claude Remote Notifier output.`,
        );
    }),
    vscode.commands.registerCommand(
      "claudeRemoteNotifier.uninstall",
      async () => {
        const folder = await chooseFolder(
          "Remove notifications from which workspace?",
        );
        if (!folder) return;
        const confirm = await vscode.window.showWarningMessage(
          `Remove only Claude Remote Notifier's managed hooks and runtime from ${folder.name}? Other settings and hooks are preserved.`,
          { modal: true },
          "Remove",
        );
        if (confirm !== "Remove") return;
        const result = await uninstallWorkspace(context, folder);
        await manager.refresh(folder);
        if (result.issues.length > 0) {
          output.show(true);
          for (const issue of result.issues) log(`uninstall: ${issue}`);
          void vscode.window.showWarningMessage(
            "Managed hooks were removed, but modified runtime files were retained. See Output.",
          );
        } else {
          void vscode.window.showInformationMessage(
            `Claude Remote Notifier was removed from ${folder.name}.`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "claudeRemoteNotifier.testLocal",
      async () => {
        const version = String(context.extension.packageJSON.version);
        const result = await notifications.enqueue({
          title: "Claude Remote Notifier",
          message: `Local Windows notification test passed to PowerShell (${version}).`,
        });
        if (!result.ok) {
          output.show(true);
          void vscode.window.showErrorMessage(
            `Windows notification failed: ${result.error}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "claudeRemoteNotifier.testBridge",
      async () => {
        const folder = await chooseFolder("Test which Remote-SSH bridge?");
        if (!folder) return;
        assertRuntimePreconditions(folder);
        const uris = workspaceUris(folder);
        const manifest = JSON.parse(
          await readTextOrDefault(uris.installFile, "{}"),
        ) as InstallManifest;
        if (!manifest.installationId)
          throw new Error("Run Setup before testing the bridge.");
        const event: BridgeEvent = {
          schemaVersion: 2,
          installationId: manifest.installationId,
          eventId: randomUUID(),
          kind: "probe",
          createdAt: Date.now(),
          sessionHash: sha256("manual-probe").slice(0, 16),
        };
        const name = `${event.createdAt}-probe-${event.eventId}.json`;
        await atomicWrite(
          vscode.Uri.joinPath(uris.pendingDir, name),
          Buffer.from(JSON.stringify(event), "utf8"),
        );
        await manager.refresh(folder);
        void vscode.window.showInformationMessage(
          "Bridge probe queued. A Windows notification should appear shortly.",
        );
      },
    ),
    vscode.commands.registerCommand(
      "claudeRemoteNotifier.diagnose",
      async () => {
        output.show(true);
        log("--- DIAGNOSE ---");
        log(
          `version=${String(context.extension.packageJSON.version)}`,
          `platform=${process.platform}`,
          `remoteName=${String(vscode.env.remoteName)}`,
          `trusted=${String(vscode.workspace.isTrusted)}`,
          `extensionPath=${context.extensionPath}`,
        );
        log(`notificationQueue=${JSON.stringify(notifications.status())}`);
        for (const state of manager.diagnostics()) log(JSON.stringify(state));
        log("--- END DIAGNOSE ---");
      },
    ),
    vscode.commands.registerCommand(
      "claudeRemoteNotifier.cleanSpool",
      async () => {
        const folder = await chooseFolder("Clean which managed event spool?");
        if (!folder) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete pending, inflight, and acknowledgement records managed by Claude Remote Notifier in ${folder.name}?`,
          { modal: true },
          "Clean",
        );
        if (confirm !== "Clean") return;
        await cleanWorkspaceSpool(folder);
        void vscode.window.showInformationMessage(
          `Managed event records were removed from ${folder.name}.`,
        );
      },
    ),
  );
}

async function chooseFolder(
  placeHolder: string,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "vscode-remote",
  );
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(
      "Open a trusted VS Code Remote-SSH folder first.",
    );
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.toString(),
      folder,
    })),
    { placeHolder },
  );
  return picked?.folder;
}
