import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  GITIGNORE_LINE,
  MAX_MANIFEST_BYTES,
  MAX_SETTINGS_BYTES,
  PRODUCT,
  PROTOCOL_VERSION,
} from "../constants";
import { workspaceUris } from "../workspace-paths";
import { sha256 } from "../protocol";
import type { InstallManifest } from "../types";
import {
  countManagedHooks,
  hasLegacyHooks,
  installHooks,
  managedHookIssues,
  restoreLegacyHooks,
  uninstallHooks,
} from "./settings-editor";
import {
  assertDirectoryOrMissing,
  assertNoSymlink,
  atomicWrite,
  optimisticTextWrite,
  readTextOrDefault,
  statOrUndefined,
} from "./remote-files";

const MANAGED_GITIGNORE_COMMENT = "# Claude Remote Notifier runtime";

export interface VerifyResult {
  ok: boolean;
  issues: string[];
  manifest?: InstallManifest;
  managedHookCount: number;
  hasLegacy: boolean;
}

export async function setupWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<VerifyResult> {
  assertRuntimePreconditions(folder);
  const uris = workspaceUris(folder);
  await assertSafeInstallationPaths(folder);

  // Parse and validate settings before writing any managed runtime or gitignore files.
  const originalSettings = await readSettings(uris.settingsFile);
  const includeSubagent = vscode.workspace
    .getConfiguration("claudeRemoteNotifier", folder.uri)
    .get<boolean>("notifyOnSubagentStop", false);
  const nextSettings = installHooks(originalSettings, {
    includeSubagent,
    removeLegacy: true,
  });

  const hookBytes = fs.readFileSync(
    context.asAbsolutePath("resources/hook/event-bridge.cjs"),
  );
  const hookSha256 = sha256(hookBytes);
  const managedRootStat = await statOrUndefined(uris.managedRoot);
  const existingManifest = await readManifest(uris.installFile);
  if (managedRootStat && !isCompatibleManifest(existingManifest)) {
    throw new Error(
      "The managed runtime directory already exists without a compatible install manifest. Remove or inspect it manually before setup.",
    );
  }
  const manifest: InstallManifest = {
    product: PRODUCT,
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: String(context.extension.packageJSON.version),
    installationId: existingManifest?.installationId ?? randomUUID(),
    hookSha256,
    installedAt: existingManifest?.installedAt ?? new Date().toISOString(),
  };

  for (const directory of [
    uris.claudeDir,
    uris.managedRoot,
    uris.runtimeDir,
    uris.pendingDir,
    uris.inflightDir,
    uris.ackDir,
  ]) {
    await vscode.workspace.fs.createDirectory(directory);
  }

  await atomicWrite(uris.hookFile, hookBytes);
  await atomicWrite(
    vscode.Uri.joinPath(uris.managedRoot, ".gitignore"),
    Buffer.from("*\n!.gitignore\n", "utf8"),
  );
  await atomicWrite(
    uris.installFile,
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
  );

  await updateRootGitignore(uris.gitignoreFile, true);
  // Commit hook registration last so a failed setup leaves only unreferenced runtime files.
  await optimisticTextWrite(uris.settingsFile, originalSettings, nextSettings);
  const verification = await verifyWorkspace(context, folder);
  if (!verification.ok) {
    try {
      const currentSettings = await readSettings(uris.settingsFile);
      const withoutManaged = uninstallHooks(currentSettings);
      const rollbackSettings = restoreLegacyHooks(
        withoutManaged,
        originalSettings,
      );
      await optimisticTextWrite(
        uris.settingsFile,
        currentSettings,
        rollbackSettings,
      );
    } catch (rollbackError) {
      verification.issues.push(
        `Hook rollback failed: ${errorMessage(rollbackError)}`,
      );
    }
    throw new Error(
      `Setup verification failed: ${verification.issues.join(" ")}`,
    );
  }
  return verification;
}

export async function uninstallWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<{ removedRuntime: boolean; issues: string[] }> {
  assertRuntimePreconditions(folder);
  const uris = workspaceUris(folder);
  const issues: string[] = [];
  const settingsStat = await statOrUndefined(uris.settingsFile);
  if (settingsStat) {
    const originalSettings = await readSettings(uris.settingsFile);
    const nextSettings = uninstallHooks(originalSettings);
    if (nextSettings !== originalSettings) {
      await optimisticTextWrite(
        uris.settingsFile,
        originalSettings,
        nextSettings,
      );
    }
  }

  let removedRuntime = false;
  try {
    await assertSafeInstallationPaths(folder);
    const manifest = await readManifest(uris.installFile);
    const hookStat = await statOrUndefined(uris.hookFile);
    if (
      !manifest ||
      manifest.product !== PRODUCT ||
      manifest.protocolVersion !== PROTOCOL_VERSION
    ) {
      issues.push(
        "Managed runtime retained because install.json is missing or incompatible.",
      );
    } else if (hookStat) {
      const hook = await vscode.workspace.fs.readFile(uris.hookFile);
      if (sha256(hook) !== manifest.hookSha256) {
        issues.push(
          "Managed runtime retained because the installed hook was modified.",
        );
      } else {
        await vscode.workspace.fs.delete(uris.managedRoot, { recursive: true });
        removedRuntime = true;
      }
    } else {
      issues.push(
        "Managed runtime retained because the installed hook is missing; no recursive deletion was attempted.",
      );
    }
  } catch (error) {
    issues.push(errorMessage(error));
  }
  if (removedRuntime) await updateRootGitignore(uris.gitignoreFile, false);
  return { removedRuntime, issues };
}

export async function verifyWorkspace(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): Promise<VerifyResult> {
  const uris = workspaceUris(folder);
  const issues: string[] = [];
  let manifest: InstallManifest | undefined;
  let managedHookCount = 0;
  let legacy = false;

  try {
    assertRuntimePreconditions(folder);
    await assertSafeInstallationPaths(folder);
  } catch (error) {
    issues.push(errorMessage(error));
  }
  try {
    manifest = await readManifest(uris.installFile);
    if (!manifest) issues.push("install.json is missing.");
    else {
      if (!isCompatibleManifest(manifest)) {
        issues.push("install.json is incompatible.");
      }
      const expectedHook = fs.readFileSync(
        context.asAbsolutePath("resources/hook/event-bridge.cjs"),
      );
      const actualHook = await vscode.workspace.fs.readFile(uris.hookFile);
      if (
        sha256(actualHook) !== sha256(expectedHook) ||
        sha256(actualHook) !== manifest.hookSha256
      ) {
        issues.push("The remote hook hash does not match this extension.");
      }
    }
  } catch (error) {
    issues.push(`Runtime verification failed: ${errorMessage(error)}`);
  }
  try {
    const settings = await readSettings(uris.settingsFile);
    managedHookCount = countManagedHooks(settings);
    legacy = hasLegacyHooks(settings);
    const includeSubagent = vscode.workspace
      .getConfiguration("claudeRemoteNotifier", folder.uri)
      .get<boolean>("notifyOnSubagentStop", false);
    const expected = includeSubagent ? 5 : 4;
    if (managedHookCount !== expected) {
      issues.push(
        `Expected ${expected} managed hooks, found ${managedHookCount}.`,
      );
    }
    issues.push(...managedHookIssues(settings, includeSubagent));
    if (legacy)
      issues.push("Legacy Agent Attention Companion hooks are still present.");
  } catch (error) {
    issues.push(`Settings verification failed: ${errorMessage(error)}`);
  }
  try {
    const probe = vscode.Uri.joinPath(
      uris.pendingDir,
      `.verify-${randomUUID()}.tmp`,
    );
    const committed = vscode.Uri.joinPath(
      uris.pendingDir,
      `.verify-${randomUUID()}.json`,
    );
    await vscode.workspace.fs.writeFile(probe, Buffer.from("{}", "utf8"));
    await vscode.workspace.fs.rename(probe, committed, { overwrite: false });
    await vscode.workspace.fs.delete(committed);
  } catch (error) {
    issues.push(
      `Spool read/write/rename/delete probe failed: ${errorMessage(error)}`,
    );
  }
  return {
    ok: issues.length === 0,
    issues,
    manifest,
    managedHookCount,
    hasLegacy: legacy,
  };
}

export async function cleanWorkspaceSpool(
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  assertRuntimePreconditions(folder);
  const uris = workspaceUris(folder);
  await assertSafeInstallationPaths(folder);
  for (const directory of [uris.pendingDir, uris.inflightDir, uris.ackDir]) {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    for (const [name, type] of entries) {
      if (type & vscode.FileType.SymbolicLink) continue;
      if (!(type & vscode.FileType.File)) continue;
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(directory, name));
    }
  }
}

export function assertRuntimePreconditions(
  folder: vscode.WorkspaceFolder,
): void {
  if (!vscode.workspace.isTrusted)
    throw new Error("Workspace Trust is required.");
  if (process.platform !== "win32")
    throw new Error("The extension must run in the local Windows UI host.");
  if (
    vscode.env.remoteName !== "ssh-remote" ||
    folder.uri.scheme !== "vscode-remote"
  ) {
    throw new Error("A VS Code Remote-SSH workspace is required.");
  }
}

async function assertSafeInstallationPaths(
  folder: vscode.WorkspaceFolder,
): Promise<void> {
  const uris = workspaceUris(folder);
  await assertNoSymlink(uris.root);
  for (const directory of [
    uris.claudeDir,
    uris.managedRoot,
    uris.runtimeDir,
    uris.spoolRoot,
    uris.pendingDir,
    uris.inflightDir,
    uris.ackDir,
  ]) {
    await assertDirectoryOrMissing(directory);
  }
  for (const file of [
    uris.hookFile,
    uris.installFile,
    uris.settingsFile,
    uris.gitignoreFile,
  ]) {
    await assertNoSymlink(file);
  }
}

function isCompatibleManifest(
  manifest: InstallManifest | undefined,
): manifest is InstallManifest {
  return Boolean(
    manifest &&
      manifest.product === PRODUCT &&
      manifest.protocolVersion === PROTOCOL_VERSION &&
      /^[a-f0-9-]{36}$/i.test(manifest.installationId) &&
      /^[a-f0-9]{64}$/i.test(manifest.hookSha256),
  );
}

async function readManifest(
  uri: vscode.Uri,
): Promise<InstallManifest | undefined> {
  const text = await readTextOrDefault(uri, "", MAX_MANIFEST_BYTES);
  if (!text) return undefined;
  return JSON.parse(text) as InstallManifest;
}

async function readSettings(uri: vscode.Uri): Promise<string> {
  return readTextOrDefault(uri, "{}\n", MAX_SETTINGS_BYTES);
}

async function updateRootGitignore(
  uri: vscode.Uri,
  install: boolean,
): Promise<void> {
  const original = await readTextOrDefault(uri, "", MAX_SETTINGS_BYTES);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  const filtered: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (
      lines[index] === MANAGED_GITIGNORE_COMMENT &&
      lines[index + 1] === GITIGNORE_LINE
    ) {
      index += 1;
      continue;
    }
    filtered.push(lines[index]!);
  }
  if (install) {
    while (filtered.length > 0 && filtered.at(-1) === "") filtered.pop();
    filtered.push(MANAGED_GITIGNORE_COMMENT, GITIGNORE_LINE, "");
  }
  const next = filtered.join(eol);
  if (next !== original) await optimisticTextWrite(uri, original, next, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
