# Changelog

All notable changes are documented here.

## 0.2.0 - 2026-09-30

Initial public release.

### Added

- Local Windows UI extension for VS Code Remote-SSH.
- Port-free, per-event remote workspace spool.
- Atomic pending/inflight/ack processing with at-least-once crash semantics.
- Local named-pipe single-owner election and multi-window focus aggregation.
- Managed setup, verification, cleanup, legacy migration, and uninstall commands.
- Workspace Trust enforcement and managed-path symbolic-link checks.
- `Stop`, `StopFailure`, `PermissionRequest`, and `AskUserQuestion` notifications.
- Optional `SubagentStop` notifications.
- Minimal privacy-preserving event protocol with bounded resource usage.
- Windows `NotifyIcon` notification queue with timeout, one retry, and diagnostics.
- Unit, hook-process, CI, package-audit, and GitHub Release automation.
