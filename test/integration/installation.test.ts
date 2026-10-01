import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  setupWorkspace,
  uninstallWorkspace,
  verifyWorkspace,
} from "../../src/setup/installation";
import { workspaceUris } from "../../src/workspace-paths";

const mock = vscode as typeof vscode & {
  __reset(): void;
  __readText(uri: vscode.Uri): Promise<string>;
  __writeText(uri: vscode.Uri, text: string): Promise<void>;
  __setWorkspaceFolders(folders: vscode.WorkspaceFolder[]): void;
  __setTrusted(trusted: boolean): void;
  __setEntryType(uri: vscode.Uri, type: vscode.FileType): void;
  __failRenameContaining(pattern: string, action?: () => Promise<void>): void;
};

const folder: vscode.WorkspaceFolder = {
  uri: vscode.Uri.parse("vscode-remote://ssh-remote/workspace"),
  name: "workspace",
  index: 0,
};

const context = {
  asAbsolutePath(relative: string) {
    return join(process.cwd(), relative);
  },
  extension: { packageJSON: { version: "0.2.0" } },
} as unknown as vscode.ExtensionContext;

beforeEach(() => {
  mock.__reset();
  mock.__setWorkspaceFolders([folder]);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterEach(() => vi.restoreAllMocks());

describe("workspace installation transaction", () => {
  it("sets up, verifies, upgrades idempotently, and uninstalls without touching unrelated settings", async () => {
    const uris = workspaceUris(folder);
    await mock.__writeText(
      uris.settingsFile,
      `{
        // keep this comment
        "permissions": {"allow": ["Bash(git status)"]},
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "other"}]}]}
      }\n`,
    );
    await mock.__writeText(uris.gitignoreFile, "build/\n");

    const first = await setupWorkspace(context, folder);
    expect(first.ok).toBe(true);
    const installed = await mock.__readText(uris.settingsFile);
    expect(installed).toContain("keep this comment");
    expect(installed).toContain("Bash(git status)");
    expect(installed).toContain('"command": "other"');
    expect(first.managedHookCount).toBe(4);
    expect(await mock.__readText(uris.gitignoreFile)).toContain(
      ".claude/claude-remote-notifier/",
    );

    const second = await setupWorkspace(context, folder);
    expect(second.ok).toBe(true);
    expect(second.managedHookCount).toBe(4);
    expect((await verifyWorkspace(context, folder)).ok).toBe(true);

    const removed = await uninstallWorkspace(context, folder);
    expect(removed.issues).toEqual([]);
    expect(removed.removedRuntime).toBe(true);
    const finalSettings = await mock.__readText(uris.settingsFile);
    expect(finalSettings).toContain("Bash(git status)");
    expect(finalSettings).toContain('"command": "other"');
    expect(finalSettings).not.toContain("claude-remote-notifier");
    expect(await mock.__readText(uris.gitignoreFile)).toBe("build/\n");
  });
  it("retains a modified runtime while removing managed hook references", async () => {
    const uris = workspaceUris(folder);
    await setupWorkspace(context, folder);
    await mock.__writeText(uris.hookFile, "// user-modified hook\n");
    const removed = await uninstallWorkspace(context, folder);
    expect(removed.removedRuntime).toBe(false);
    expect(removed.issues.join(" ")).toMatch(/modified/);
    expect(await mock.__readText(uris.hookFile)).toContain("user-modified");
    expect(await mock.__readText(uris.settingsFile)).not.toContain(
      "claude-remote-notifier",
    );
  });

  it("blocks setup in an untrusted workspace and rejects managed symlinks", async () => {
    mock.__setTrusted(false);
    await expect(setupWorkspace(context, folder)).rejects.toThrow(
      /Workspace Trust/,
    );
    mock.__setTrusted(true);
    const uris = workspaceUris(folder);
    mock.__setEntryType(uris.managedRoot, vscode.FileType.SymbolicLink);
    await expect(setupWorkspace(context, folder)).rejects.toThrow(
      /symbolic link/,
    );
  });

  it("rejects an unknown pre-existing managed runtime", async () => {
    const uris = workspaceUris(folder);
    mock.__setEntryType(uris.managedRoot, vscode.FileType.Directory);
    await expect(setupWorkspace(context, folder)).rejects.toThrow(
      /compatible install manifest/,
    );
  });

  it("retains runtime when the installed hook is missing", async () => {
    const uris = workspaceUris(folder);
    await setupWorkspace(context, folder);
    await vscode.workspace.fs.delete(uris.hookFile);
    const removed = await uninstallWorkspace(context, folder);
    expect(removed.removedRuntime).toBe(false);
    expect(removed.issues.join(" ")).toMatch(/hook is missing/);
    expect(await mock.__readText(uris.installFile)).toContain(
      "claude-remote-notifier",
    );
    expect(await mock.__readText(uris.settingsFile)).not.toContain(
      "claude-remote-notifier",
    );
  });

  it("preserves a user-authored matching gitignore rule", async () => {
    const uris = workspaceUris(folder);
    await mock.__writeText(
      uris.gitignoreFile,
      ".claude/claude-remote-notifier/\nother-user-rule/\n",
    );
    await setupWorkspace(context, folder);
    await uninstallWorkspace(context, folder);
    const finalGitignore = await mock.__readText(uris.gitignoreFile);
    expect(finalGitignore).toContain(".claude/claude-remote-notifier/");
    expect(finalGitignore).toContain("other-user-rule/");
    expect(finalGitignore).not.toContain("# Claude Remote Notifier runtime");
  });

  it("rolls back hook registration when post-commit verification fails", async () => {
    const uris = workspaceUris(folder);
    await mock.__writeText(
      uris.settingsFile,
      '{"permissions":{"allow":["Bash(git status)"]}}\n',
    );
    mock.__failRenameContaining(".verify-", async () => {
      const current = JSON.parse(await mock.__readText(uris.settingsFile));
      current.env = { CONCURRENT_EDIT: "preserve-me" };
      await mock.__writeText(
        uris.settingsFile,
        JSON.stringify(current, null, 2),
      );
    });
    await expect(setupWorkspace(context, folder)).rejects.toThrow(
      /Setup verification failed/,
    );
    const settings = await mock.__readText(uris.settingsFile);
    expect(settings).toContain("Bash(git status)");
    expect(settings).toContain("CONCURRENT_EDIT");
    expect(settings).not.toContain("claude-remote-notifier");
  });

  it("reports an invalid installation id during verification", async () => {
    const uris = workspaceUris(folder);
    await setupWorkspace(context, folder);
    const manifest = JSON.parse(await mock.__readText(uris.installFile));
    manifest.installationId = "broken";
    await mock.__writeText(uris.installFile, JSON.stringify(manifest));
    const result = await verifyWorkspace(context, folder);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/install.json is incompatible/);
  });

  it("rejects malformed settings before writing runtime or gitignore files", async () => {
    const uris = workspaceUris(folder);
    await mock.__writeText(uris.settingsFile, '{"hooks":');
    await mock.__writeText(uris.gitignoreFile, "user-rule/\n");
    await expect(setupWorkspace(context, folder)).rejects.toThrow(
      /invalid JSONC/,
    );
    await expect(
      vscode.workspace.fs.stat(uris.managedRoot),
    ).rejects.toMatchObject({
      code: "FileNotFound",
    });
    expect(await mock.__readText(uris.gitignoreFile)).toBe("user-rule/\n");
  });

  it("does not recreate a deleted settings file during uninstall", async () => {
    const uris = workspaceUris(folder);
    await setupWorkspace(context, folder);
    await vscode.workspace.fs.delete(uris.settingsFile);
    const removed = await uninstallWorkspace(context, folder);
    expect(removed.removedRuntime).toBe(true);
    await expect(
      vscode.workspace.fs.stat(uris.settingsFile),
    ).rejects.toMatchObject({ code: "FileNotFound" });
  });
});
