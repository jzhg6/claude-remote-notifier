export const PRODUCT = "claude-remote-notifier";
export const PROTOCOL_VERSION = 2;
export const MAX_SETTINGS_BYTES = 1024 * 1024;
export const MAX_EVENT_BYTES = 4096;
export const MAX_SCAN_FILES = 512;
export const MAX_DIRECTORY_ENTRIES = 2048;
export const MAX_ACKS = 512;
export const ACK_RETENTION_MS = 24 * 60 * 60 * 1000;
export const INFLIGHT_RECOVERY_MS = 2 * 60 * 1000;
export const NOTIFICATION_TIMEOUT_MS = 10_000;
export const GITIGNORE_LINE = ".claude/claude-remote-notifier/";
export const MANAGED_HOOK_RELATIVE =
  ".claude/claude-remote-notifier/runtime/event-bridge.cjs";
export const MAX_MANIFEST_BYTES = 4096;
export const MAX_RUNTIME_HOOK_BYTES = 64 * 1024;
