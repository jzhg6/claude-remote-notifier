# Claude Remote Notifier

[简体中文](README_CN.md)

Reliable native Windows notifications for Claude Code running in a VS Code Remote-SSH workspace, delivered through a **port-free workspace event spool**.

> [!IMPORTANT]
> This project is not the first Claude Code notification tool. It is a deliberately narrow Windows + Remote-SSH implementation focused on reliable event delivery, bounded persistence, precise setup/uninstall, and a small security boundary. See [How it differs](#how-it-differs) and [Related projects](#related-projects).

Claude Remote Notifier is an independent community project. It is not affiliated with, endorsed by, or sponsored by Anthropic. “Claude” and “Claude Code” are trademarks of Anthropic PBC.

## Why this exists

Claude Code hooks run on the remote Linux host. A desktop notification emitted there cannot normally reach the Windows computer running the VS Code UI. Existing solutions commonly use one of these approaches:

- a VS Code-only information message;
- a local daemon plus SSH reverse forwarding;
- a webhook or messaging service;
- a single workspace signal file.

Claude Remote Notifier uses the Remote-SSH file-system channel that VS Code already maintains:

```text
REMOTE HOST                                      WINDOWS CLIENT
Claude Code hook                                 Local UI extension
      │                                                  │
      ├─ atomically writes one JSON per event             │
      ▼                                                  │
.claude/claude-remote-notifier/spool/v2/pending/          │
      │                                                  │
      └──────── vscode.workspace.fs / Remote-SSH ────────┤
                                                         ├─ claim + validate + ack
                                                         └─ PowerShell NotifyIcon notification
```

No listener port, background daemon, webhook, telemetry service, or SSH `RemoteForward` is required.

## Highlights

- **Remote-SSH to local Windows notifications.** The extension is forced into the local VS Code UI Extension Host with `extensionKind: ["ui"]`.
- **One immutable file per event.** Concurrent events do not overwrite a shared signal file.
- **Atomic publication and claiming.** The hook writes a private temporary file and renames it into `pending`; consumers atomically move records to `inflight`.
- **Cross-window ownership.** A local Windows named pipe elects one consumer per remote workspace and aggregates focus state across matching VS Code windows.
- **Remote acknowledgements.** Terminal states are persisted before an inflight record is deleted. Delivery is at-least-once across crash windows rather than falsely claiming exactly-once delivery.
- **Bounded storage.** Input, record size, queue length, event age, acknowledgements, and scan work are capped.
- **Minimal event data.** Records contain event kind, installation ID, event ID, timestamp, a session hash, and at most a bounded tool name or error category. They do not store transcripts, commands, question text, or assistant prose.
- **Workspace Trust boundary.** Setup, consumption, bridge tests, cleanup, and uninstall are disabled in Restricted Mode.
- **Precise JSONC edits.** Setup changes only this extension's exact hooks in `.claude/settings.local.json`, preserving comments, permissions, environment variables, and unrelated hooks.
- **Reversible install.** Uninstall removes hook references first and deletes runtime files only when their installation manifest and hook hash still match.
- **Attention-aware focus policy.** Completion events are suppressed while any related local window is focused; permission, question, and API-failure events still notify.

## Requirements

- Windows 10 or Windows 11 on the local machine.
- VS Code 1.96 or later with Remote-SSH.
- A trusted Remote-SSH workspace.
- A recent Claude Code version with command hooks, `PermissionRequest`, `StopFailure`, and exec-form hook arguments.
- Node.js 18 or later on the remote host for the standalone bridge hook.
- Windows PowerShell with `System.Windows.Forms` and `System.Drawing`.

## Install

### 1. Download the VSIX

Download `claude-remote-notifier-0.2.0.vsix` and its `.sha256` file from the latest [GitHub Release](https://github.com/jzhg6/claude-remote-notifier/releases/latest).

Optionally verify it in Windows PowerShell:

```powershell
(Get-FileHash .\claude-remote-notifier-0.2.0.vsix -Algorithm SHA256).Hash.ToLower()
Get-Content .\claude-remote-notifier-0.2.0.vsix.sha256
```

### 2. Install locally

In the **local Windows VS Code window**:

1. Open the Command Palette.
2. Run **Extensions: Install from VSIX...**.
3. Select the downloaded VSIX.
4. Confirm it appears under **Local - Installed**, not only under `SSH: <host>`.
5. Run **Developer: Reload Window**.

Installing only into the remote extension host cannot create Windows notifications.

### 3. Set up each remote workspace

Open the trusted Remote-SSH workspace and run:

```text
Claude Remote Notifier: Set Up Current Workspace
```

Setup performs a bounded, reviewable installation:

- copies the bundled standalone hook to `.claude/claude-remote-notifier/runtime/`;
- creates the versioned event spool and install manifest;
- merges four exact handlers into `.claude/settings.local.json`;
- adds `.claude/claude-remote-notifier/` to the root `.gitignore`;
- verifies the hook hash, hook count, and remote file-system operations.

It does **not** edit user-level Claude settings, permissions, environment variables, or unrelated hooks.

Start a new Claude Code session after setup so Claude Code reloads hooks.

### 4. Test both halves

Run:

```text
Claude Remote Notifier: Test Windows Notification
Claude Remote Notifier: Test Remote Bridge
Claude Remote Notifier: Verify Setup
```

The local test isolates the Windows backend. The bridge test writes a synthetic probe through the same Remote-SSH workspace spool used by real events.

## Events

| Claude Code hook                        | Notification                      | Focus policy                                   | Default |
| --------------------------------------- | --------------------------------- | ---------------------------------------------- | ------- |
| `Stop`                                  | Current turn stopped              | Suppressed while any related window is focused | On      |
| `StopFailure`                           | API request stopped with an error | Always notify                                  | On      |
| `PermissionRequest`                     | Permission decision is waiting    | Always notify                                  | On      |
| `PreToolUse` matching `AskUserQuestion` | A question is waiting             | Always notify                                  | On      |
| `SubagentStop`                          | Background subagent stopped       | Completion policy                              | Off     |

`Stop` means the Claude Code main agent stopped a turn. It is not a proof that every user-defined long-running objective has finished. When Claude reports active background tasks or session crons, the bridge suppresses that `Stop` event and waits for a later stop.

## Commands

| Command                                                 | Purpose                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Claude Remote Notifier: Set Up Current Workspace`      | Install or upgrade the managed remote bridge and hooks                   |
| `Claude Remote Notifier: Verify Setup`                  | Verify host, trust, hook hash, settings signatures, and spool operations |
| `Claude Remote Notifier: Remove From Current Workspace` | Remove only managed hooks and unmodified runtime files                   |
| `Claude Remote Notifier: Test Windows Notification`     | Test local PowerShell/NotifyIcon delivery                                |
| `Claude Remote Notifier: Test Remote Bridge`            | Send a synthetic event through Remote-SSH                                |
| `Claude Remote Notifier: Diagnose`                      | Show privacy-preserving runtime diagnostics                              |
| `Claude Remote Notifier: Clean Event Spool`             | Delete managed pending, inflight, and acknowledgement records            |

## Settings

Search Settings for **Claude Remote Notifier**.

- `enabled`: consume managed event records.
- `notifyWhenFocused`: also show completion notifications while a related window is focused.
- `notifyOnStop`, `notifyOnStopFailure`, `notifyOnPermission`, `notifyOnQuestion`: per-event switches.
- `notifyOnSubagentStop`: opt into subagent notifications; run Setup again after changing it.
- `pollIntervalMs`: fallback polling cadence. Remote file watchers remain the low-latency path.
- `maxEventAgeMs`: discard stale event records.

## How it differs

Comparison reflects public project documentation checked on **2026-09-30**. Projects evolve; consult their current documentation before choosing.

| Project                                                                       | Main scope                                                                     | Remote delivery                                                   | Trade-off compared with Claude Remote Notifier                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Remote Notifier**                                                    | Windows + VS Code Remote-SSH lifecycle notifications                           | Port-free per-event workspace spool                               | Narrow platform scope; adds atomic claim/ack, cross-window ownership, bounded minimal records, precise setup/uninstall, and `StopFailure`                                                      |
| [Agent Idle Notifier](https://github.com/Global-Step-Inc/agent-idle-notifier) | Cross-platform local notifications for Remote-SSH, WSL, and containers         | Local UI extension watches a workspace JSON signal                | The closest prior architecture and lighter to understand; this project focuses on a multi-record spool, crash recovery, persistent remote acknowledgements, and stricter management boundaries |
| [Claude Notifier](https://github.com/ashmitb95/claude-notifier)               | Broad Claude Code and Codex notifications, sounds, labels, and session context | Optional local daemon and SSH reverse forwarding for remote audio | Much broader and more polished; this project intentionally avoids ports, daemons, reverse forwarding, transcript reads, and detailed message persistence                                       |
| [Claude Code Notifier](https://github.com/kdush/Claude-Code-Notifier)         | Python notification routing, webhooks, and messaging channels                  | Hook process and external channels                                | Better for team/webhook routing; not centered on a local UI-extension Remote-SSH file bridge                                                                                                   |
| [SSH Bridge MCP](https://github.com/k-l-lambda/vscode-ssh-bridge-mcp)         | MCP-based messages, sound, TTS, and browser tools                              | Local SSE service plus SSH reverse tunnel                         | More capabilities; requires a listener and reverse forwarding, while this project only handles automatic lifecycle events                                                                      |
| [WSL Claude Toast](https://github.com/sebastienheyd/wsl-claude-toast)         | WSL2 to Windows notifications without VS Code                                  | WSL binary invokes Windows WinRT Toast                            | Provides a modern standalone Windows Toast path; this project targets general Remote-SSH and depends on an open VS Code connection                                                             |

### The specific niche

The differentiator is not “hooks can trigger notifications” or “a local UI extension can read a remote workspace”; those ideas existed first. The project combines them with a deliberately conservative reliability model:

- per-event immutable records instead of a shared overwrite slot;
- atomic publish, claim, acknowledge, and delete stages;
- at-least-once crash semantics stated explicitly;
- bounded retention and work per scan;
- local single-owner election across VS Code windows;
- no event prose or transcript persistence;
- no listener port, daemon, webhook, or SSH tunnel;
- setup and uninstall that preserve unrelated JSONC settings.

## Security and privacy

- No telemetry or outbound network requests are implemented.
- Remote event files intentionally omit transcript text, commands, questions, and assistant responses.
- Setup refuses symbolic links at managed paths and uses fixed paths derived from the selected workspace.
- The hook validates its own SHA-256 against the install manifest before writing.
- The consumer validates schema, installation ID, filename, size, timestamp, and field bounds before notifying.
- A trusted process that can modify the remote workspace can still tamper with files between Remote-SSH file-system checks. Workspace Trust is the primary boundary; symlink checks and atomic renames are defense in depth, not a claim of immunity to hostile processes in a trusted workspace.
- Windows notifications are created with `System.Windows.Forms.NotifyIcon.ShowBalloonTip`. This is a native NotifyIcon balloon, **not** a registered WinRT Action Center Toast. Windows Focus Assist and system policy may suppress it.

See [SECURITY.md](SECURITY.md) for reporting and the threat model.

## Limitations

- VS Code and the Remote-SSH connection must remain open. Closing either breaks real-time delivery.
- The supported local platform is currently Windows.
- A notification displayed immediately before a crash may be repeated if acknowledgement was not committed. This is the documented at-least-once failure window.
- Separate Windows user sessions or separate client computers do not share the local named-pipe owner. The remote atomic claim still prevents concurrent processing in normal cases.
- The hook is best-effort and always exits successfully so notification problems never block Claude Code.

## Uninstall

For each configured workspace, run:

```text
Claude Remote Notifier: Remove From Current Workspace
```

This removes managed hook entries before deleting runtime files. If the hook was manually modified, its files are retained and reported instead of being deleted. Uninstall the local VS Code extension only after removing workspace integrations.

## Development

```bash
npm ci
npm run check
npm run package
```

The release workflow validates that tag `vX.Y.Z`, `package.json` version, VSIX filename, and checksum agree. GitHub Releases are supported; VS Code Marketplace publishing is intentionally not configured.

## Related projects and acknowledgements

[Agent Idle Notifier](https://github.com/Global-Step-Inc/agent-idle-notifier) established the closest prior public file-bridge architecture and directly informed the problem framing for this project. Its MIT notice is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No GPL-licensed Claude Notifier source is included.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled runtime dependency notices.

## License

MIT. See [LICENSE](LICENSE).
