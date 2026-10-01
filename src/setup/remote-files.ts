import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { sha256 } from "../protocol";

export async function statOrUndefined(
  uri: vscode.Uri,
): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    )
      return undefined;
    throw error;
  }
}

export async function readTextOrDefault(
  uri: vscode.Uri,
  fallback: string,
  maxBytes?: number,
): Promise<string> {
  const stat = await statOrUndefined(uri);
  if (!stat) return fallback;
  if (stat.type & vscode.FileType.SymbolicLink)
    throw new Error(`${uri.toString()} is a symbolic link`);
  if (!(stat.type & vscode.FileType.File))
    throw new Error(`${uri.toString()} is not a file`);
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new Error(`${uri.toString()} exceeds ${maxBytes} bytes`);
  }
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

export async function assertNoSymlink(uri: vscode.Uri): Promise<void> {
  const stat = await statOrUndefined(uri);
  if (!stat) return;
  if (stat.type & vscode.FileType.SymbolicLink)
    throw new Error(`${uri.toString()} is a symbolic link`);
}

export async function assertDirectoryOrMissing(uri: vscode.Uri): Promise<void> {
  const stat = await statOrUndefined(uri);
  if (!stat) return;
  if (stat.type & vscode.FileType.SymbolicLink)
    throw new Error(`${uri.toString()} is a symbolic link`);
  if (!(stat.type & vscode.FileType.Directory))
    throw new Error(`${uri.toString()} is not a directory`);
}

export async function atomicWrite(
  uri: vscode.Uri,
  bytes: Uint8Array,
): Promise<void> {
  const parent = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(parent);
  const temp = vscode.Uri.joinPath(
    parent,
    `.${uri.path.split("/").at(-1)}.${randomUUID()}.tmp`,
  );
  try {
    await vscode.workspace.fs.writeFile(temp, bytes);
    const roundTrip = await vscode.workspace.fs.readFile(temp);
    if (sha256(roundTrip) !== sha256(bytes))
      throw new Error(`verification failed for ${uri.toString()}`);
    await vscode.workspace.fs.rename(temp, uri, { overwrite: true });
    const finalBytes = await vscode.workspace.fs.readFile(uri);
    if (sha256(finalBytes) !== sha256(bytes))
      throw new Error(`commit verification failed for ${uri.toString()}`);
  } finally {
    try {
      await vscode.workspace.fs.delete(temp);
    } catch {}
  }
}

export async function optimisticTextWrite(
  uri: vscode.Uri,
  original: string,
  next: string,
  missingFallback = "{}\n",
): Promise<void> {
  const current = await readTextOrDefault(uri, missingFallback);
  if (sha256(current) !== sha256(original)) {
    throw new Error(`${uri.toString()} changed while setup was running`);
  }

  const parent = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(parent);
  const token = randomUUID();
  const temp = vscode.Uri.joinPath(parent, `.settings.${token}.tmp`);
  const backup = vscode.Uri.joinPath(parent, `.settings.${token}.backup`);
  const nextBytes = Buffer.from(next, "utf8");
  let backupExists = false;
  let preserveBackup = false;
  try {
    await vscode.workspace.fs.writeFile(temp, nextBytes);
    const tempBytes = await vscode.workspace.fs.readFile(temp);
    if (sha256(tempBytes) !== sha256(nextBytes)) {
      throw new Error(`verification failed for ${uri.toString()}`);
    }

    const targetStat = await statOrUndefined(uri);
    if (!targetStat) {
      await vscode.workspace.fs.rename(temp, uri, { overwrite: false });
      const committed = await vscode.workspace.fs.readFile(uri);
      if (sha256(committed) !== sha256(nextBytes)) {
        throw new Error(`commit verification failed for ${uri.toString()}`);
      }
      return;
    }

    await vscode.workspace.fs.rename(uri, backup, { overwrite: false });
    backupExists = true;
    const displaced = await vscode.workspace.fs.readFile(backup);
    if (sha256(displaced) !== sha256(original)) {
      throw new Error(`${uri.toString()} changed before commit`);
    }
    if (await statOrUndefined(uri)) {
      throw new Error(`${uri.toString()} was recreated during commit`);
    }
    await vscode.workspace.fs.rename(temp, uri, { overwrite: false });
    const committed = await vscode.workspace.fs.readFile(uri);
    if (sha256(committed) !== sha256(nextBytes)) {
      throw new Error(`commit verification failed for ${uri.toString()}`);
    }
  } catch (error) {
    if (backupExists && !(await statOrUndefined(uri))) {
      try {
        await vscode.workspace.fs.rename(backup, uri, { overwrite: false });
        backupExists = false;
      } catch {
        preserveBackup = true;
      }
    }
    throw error;
  } finally {
    try {
      await vscode.workspace.fs.delete(temp);
    } catch {}
    if (backupExists && !preserveBackup) {
      try {
        await vscode.workspace.fs.delete(backup);
      } catch {}
    }
  }
}
