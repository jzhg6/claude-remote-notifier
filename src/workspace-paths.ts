import * as vscode from "vscode";
import { PRODUCT } from "./constants";
import type { WorkspaceUris } from "./types";

export function workspaceUris(folder: vscode.WorkspaceFolder): WorkspaceUris {
  const root = folder.uri;
  const claudeDir = vscode.Uri.joinPath(root, ".claude");
  const managedRoot = vscode.Uri.joinPath(claudeDir, PRODUCT);
  const runtimeDir = vscode.Uri.joinPath(managedRoot, "runtime");
  const spoolRoot = vscode.Uri.joinPath(managedRoot, "spool", "v2");
  return {
    root,
    claudeDir,
    managedRoot,
    runtimeDir,
    hookFile: vscode.Uri.joinPath(runtimeDir, "event-bridge.cjs"),
    installFile: vscode.Uri.joinPath(managedRoot, "install.json"),
    spoolRoot,
    pendingDir: vscode.Uri.joinPath(spoolRoot, "pending"),
    inflightDir: vscode.Uri.joinPath(spoolRoot, "inflight"),
    ackDir: vscode.Uri.joinPath(spoolRoot, "acks"),
    settingsFile: vscode.Uri.joinPath(claudeDir, "settings.local.json"),
    gitignoreFile: vscode.Uri.joinPath(root, ".gitignore"),
  };
}
