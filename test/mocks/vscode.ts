import { posix } from "node:path";

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class Uri {
  public constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
  ) {}

  public static parse(value: string): Uri {
    const parsed = new URL(value);
    return new Uri(
      parsed.protocol.slice(0, -1),
      decodeURIComponent(parsed.host),
      parsed.pathname,
    );
  }

  public static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(
      base.scheme,
      base.authority,
      posix.normalize(posix.join(base.path, ...parts)),
    );
  }

  public toString(): string {
    return `${this.scheme}://${encodeURIComponent(this.authority)}${this.path}`;
  }
}

export class RelativePattern {
  public constructor(
    public readonly base: Uri,
    public readonly pattern: string,
  ) {}
}

function disposable(): { dispose(): void } {
  return { dispose() {} };
}

export class FileSystemError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }

  public static FileNotFound(uri?: Uri): FileSystemError {
    return new FileSystemError(uri?.toString() ?? "not found", "FileNotFound");
  }
}

interface Entry {
  type: FileType;
  bytes?: Uint8Array;
  mtime: number;
}

const entries = new Map<string, Entry>();
const config = new Map<string, unknown>();
let renameFailurePattern = "";
let renameFailureAction: (() => Promise<void>) | undefined;
let renameActionPattern = "";
let renameAction: (() => Promise<void>) | undefined;
let watcherCount = 0;

function key(uri: Uri): string {
  return uri.toString();
}

function parent(uri: Uri): Uri {
  return new Uri(uri.scheme, uri.authority, posix.dirname(uri.path));
}

async function createDirectory(uri: Uri): Promise<void> {
  if (uri.path !== "/") await createDirectory(parent(uri));
  entries.set(key(uri), { type: FileType.Directory, mtime: Date.now() });
}

export const workspace = {
  isTrusted: true,
  workspaceFolders: [] as WorkspaceFolder[],
  fs: {
    async stat(uri: Uri) {
      const entry = entries.get(key(uri));
      if (!entry) throw FileSystemError.FileNotFound(uri);
      return {
        type: entry.type,
        ctime: entry.mtime,
        mtime: entry.mtime,
        size: entry.bytes?.length ?? 0,
      };
    },
    async readFile(uri: Uri) {
      const entry = entries.get(key(uri));
      if (!entry || entry.type !== FileType.File || !entry.bytes)
        throw FileSystemError.FileNotFound(uri);
      return Uint8Array.from(entry.bytes);
    },
    async writeFile(uri: Uri, bytes: Uint8Array) {
      await createDirectory(parent(uri));
      entries.set(key(uri), {
        type: FileType.File,
        bytes: Uint8Array.from(bytes),
        mtime: Date.now(),
      });
    },
    createDirectory,
    async readDirectory(uri: Uri) {
      const directory = entries.get(key(uri));
      if (!directory || directory.type !== FileType.Directory)
        throw FileSystemError.FileNotFound(uri);
      const prefix = key(uri).replace(/\/$/, "") + "/";
      const found = new Map<string, FileType>();
      for (const [entryKey, entry] of entries) {
        if (!entryKey.startsWith(prefix)) continue;
        const rest = entryKey.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        found.set(rest, entry.type);
      }
      return [...found.entries()];
    },
    async rename(from: Uri, to: Uri, options: { overwrite: boolean }) {
      if (renameActionPattern && from.path.includes(renameActionPattern)) {
        renameActionPattern = "";
        const action = renameAction;
        renameAction = undefined;
        if (action) await action();
      }
      if (renameFailurePattern && from.path.includes(renameFailurePattern)) {
        renameFailurePattern = "";
        const action = renameFailureAction;
        renameFailureAction = undefined;
        if (action) await action();
        throw new FileSystemError("injected rename failure", "Unavailable");
      }
      const entry = entries.get(key(from));
      if (!entry) throw FileSystemError.FileNotFound(from);
      if (!options.overwrite && entries.has(key(to)))
        throw new FileSystemError("exists", "FileExists");
      await createDirectory(parent(to));
      entries.set(key(to), entry);
      entries.delete(key(from));
    },
    async delete(uri: Uri, options?: { recursive?: boolean }) {
      const target = key(uri);
      if (!entries.has(target)) throw FileSystemError.FileNotFound(uri);
      if (options?.recursive) {
        for (const entryKey of [...entries.keys()]) {
          if (entryKey === target || entryKey.startsWith(target + "/"))
            entries.delete(entryKey);
        }
      } else entries.delete(target);
    },
  },
  createFileSystemWatcher() {
    watcherCount += 1;
    let disposed = false;
    return {
      onDidCreate() {
        return disposable();
      },
      onDidChange() {
        return disposable();
      },
      onDidDelete() {
        return disposable();
      },
      dispose() {
        if (!disposed) {
          disposed = true;
          watcherCount = Math.max(0, watcherCount - 1);
        }
      },
    };
  },
  getConfiguration(section: string) {
    return {
      get<T>(name: string, fallback: T): T {
        return (config.get(`${section}.${name}`) as T | undefined) ?? fallback;
      },
    };
  },
};

export const env = { remoteName: "ssh-remote" };

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export function __reset(): void {
  entries.clear();
  config.clear();
  renameFailurePattern = "";
  renameFailureAction = undefined;
  renameActionPattern = "";
  renameAction = undefined;
  watcherCount = 0;
  workspace.isTrusted = true;
  workspace.workspaceFolders = [];
  entries.set("vscode-remote://ssh-remote/", {
    type: FileType.Directory,
    mtime: Date.now(),
  });
}

export function __setConfig(name: string, value: unknown): void {
  config.set(name, value);
}

export function __setWorkspaceFolders(folders: WorkspaceFolder[]): void {
  workspace.workspaceFolders = folders;
}

export function __setTrusted(trusted: boolean): void {
  workspace.isTrusted = trusted;
}

export function __setEntryType(uri: Uri, type: FileType): void {
  entries.set(key(uri), { type, mtime: Date.now() });
}

export function __failRenameContaining(
  pattern: string,
  action?: () => Promise<void>,
): void {
  renameFailurePattern = pattern;
  renameFailureAction = action;
}

export function __onRenameContaining(
  pattern: string,
  action: () => Promise<void>,
): void {
  renameActionPattern = pattern;
  renameAction = action;
}

export function __setMtime(uri: Uri, mtime: number): void {
  const entry = entries.get(key(uri));
  if (!entry) throw FileSystemError.FileNotFound(uri);
  entry.mtime = mtime;
}

export function __watcherCount(): number {
  return watcherCount;
}

export async function __readText(uri: Uri): Promise<string> {
  return Buffer.from(await workspace.fs.readFile(uri)).toString("utf8");
}

export async function __writeText(uri: Uri, text: string): Promise<void> {
  await workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
}

export const window = {
  state: { focused: false },
};
