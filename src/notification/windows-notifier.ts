import { spawn } from "node:child_process";
import { NOTIFICATION_TIMEOUT_MS } from "../constants";

const NOTIFY_ICON_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$Title = [string]$env:CLAUDE_REMOTE_NOTIFIER_TITLE",
  "$Message = [string]$env:CLAUDE_REMOTE_NOTIFIER_MESSAGE",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$Notify = New-Object System.Windows.Forms.NotifyIcon",
  "try {",
  "  $Notify.Icon = [System.Drawing.SystemIcons]::Information",
  "  $Notify.Visible = $true",
  "  $Notify.ShowBalloonTip(5000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)",
  "  Start-Sleep -Seconds 6",
  "} finally {",
  "  $Notify.Dispose()",
  "}",
].join("\n");

export interface NotificationRequest {
  title: string;
  message: string;
}

export interface NotificationResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

export type LogFunction = (...parts: string[]) => void;

export class WindowsNotificationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastResult?: NotificationResult;

  public constructor(
    private readonly log: LogFunction,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  public enqueue(request: NotificationRequest): Promise<NotificationResult> {
    this.pending += 1;
    let resolveResult!: (result: NotificationResult) => void;
    const result = new Promise<NotificationResult>(
      (resolve) => (resolveResult = resolve),
    );
    this.tail = this.tail
      .then(async () => {
        const first = await this.show(request);
        const final =
          first.ok || first.retryable === false
            ? first
            : await this.show(request);
        this.lastResult = final;
        resolveResult(final);
      })
      .catch((error: unknown) => {
        const failed = { ok: false, error: errorMessage(error) };
        this.lastResult = failed;
        resolveResult(failed);
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
    return result;
  }

  public status(): { pending: number; lastResult?: NotificationResult } {
    return { pending: this.pending, lastResult: this.lastResult };
  }

  private show(request: NotificationRequest): Promise<NotificationResult> {
    if (process.platform !== "win32") {
      return Promise.resolve({
        ok: false,
        error: "local UI extension host is not Windows",
        retryable: false,
      });
    }
    const title = cleanText(request.title, 63);
    const message = cleanText(request.message, 240);
    return new Promise((resolve) => {
      const child = this.spawnProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-Command",
          NOTIFY_ICON_COMMAND,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: minimalPowerShellEnvironment(title, message),
        },
      );
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const finish = (value: NotificationResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        this.log("notification process timed out");
        child.kill();
        forceTimer = setTimeout(() => {
          child.kill();
          finish({
            ok: false,
            error: "PowerShell notification timed out",
            retryable: false,
          });
        }, 2000);
      }, NOTIFICATION_TIMEOUT_MS);
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString();
      });
      child.on("error", (error) => finish({ ok: false, error: error.message }));
      child.on("exit", (code, signal) => {
        this.log(
          "notification process exited",
          `code=${String(code)}`,
          `signal=${String(signal)}`,
        );
        if (timedOut) {
          finish({
            ok: false,
            error: "PowerShell notification timed out",
            retryable: false,
          });
          return;
        }
        finish(
          code === 0
            ? { ok: true }
            : {
                ok: false,
                error:
                  stderr.trim().slice(0, 4096) || `PowerShell exited ${code}`,
              },
        );
      });
    });
  }
}

function minimalPowerShellEnvironment(
  title: string,
  message: string,
): NodeJS.ProcessEnv {
  const names = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CLAUDE_REMOTE_NOTIFIER_TITLE = title;
  env.CLAUDE_REMOTE_NOTIFIER_MESSAGE = message;
  return env;
}

export function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
