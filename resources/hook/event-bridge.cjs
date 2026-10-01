#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PRODUCT = "claude-remote-notifier";
const PROTOCOL_VERSION = 2;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 4096;
const MAX_PENDING_FILES = 256;
const ALLOWED_KINDS = new Set([
  "stop",
  "stop_failure",
  "permission",
  "question",
  "subagent_stop",
]);

function readBoundedStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    process.stdin.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on("end", () =>
      resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("close", () =>
      resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", () => resolve(null));
    process.stdin.resume();
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOutstandingBackgroundWork(input) {
  return (
    (Array.isArray(input.background_tasks) &&
      input.background_tasks.length > 0) ||
    (Array.isArray(input.session_crons) && input.session_crons.length > 0)
  );
}

function sessionHash(sessionId) {
  return crypto
    .createHash("sha256")
    .update(String(sessionId || "anonymous"))
    .digest("hex")
    .slice(0, 16);
}

function boundedToolName(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 128);
}

function errorKind(input) {
  const raw = JSON.stringify(
    input.error ??
      input.error_type ??
      input.error_details ??
      input.reason ??
      "api_error",
  ).toLowerCase();
  if (raw.includes("overload") || raw.includes("529")) return "overloaded";
  if (raw.includes("rate") || raw.includes("429")) return "rate_limit";
  if (raw.includes("auth") || raw.includes("401") || raw.includes("403")) {
    return "authentication";
  }
  if (raw.includes("max_output_tokens")) return "max_output_tokens";
  if (raw.includes("billing")) return "billing";
  if (raw.includes("timeout")) return "timeout";
  if (raw.includes("server_error") || raw.includes("server error"))
    return "server";
  if (raw.includes("network") || raw.includes("connection")) return "network";
  return "api_error";
}

function assertDirectoryNoSymlink(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("unsafe bridge directory");
  const real = fs.realpathSync(directory);
  if (path.resolve(real) !== path.resolve(directory))
    throw new Error("bridge directory resolves elsewhere");
}

function assertRegularFileNoSymlink(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("unsafe bridge file");
}

function assertSafeInstallation(root, managedRoot, manifest) {
  assertDirectoryNoSymlink(root);
  for (const relative of [
    ".claude",
    ".claude/claude-remote-notifier",
    ".claude/claude-remote-notifier/runtime",
    ".claude/claude-remote-notifier/spool",
    ".claude/claude-remote-notifier/spool/v2",
    ".claude/claude-remote-notifier/spool/v2/pending",
  ]) {
    assertDirectoryNoSymlink(path.join(root, relative));
  }
  if (
    manifest.product !== PRODUCT ||
    manifest.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new Error("incompatible installation manifest");
  }
  if (!/^[a-f0-9-]{32,36}$/i.test(String(manifest.installationId || ""))) {
    throw new Error("invalid installation id");
  }
  const ownHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(__filename))
    .digest("hex");
  if (ownHash !== manifest.hookSha256) throw new Error("hook hash mismatch");
  const realHook = fs.realpathSync(__filename);
  const realRuntime = fs.realpathSync(path.join(managedRoot, "runtime"));
  if (!realHook.startsWith(realRuntime + path.sep))
    throw new Error("hook is outside managed runtime");
}

function withWriterLock(lockPath, action) {
  const deadline = Date.now() + 1200;
  let fd;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") return;
      try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) return;
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      // A hook has a two-second timeout. Wait briefly for the current writer
      // rather than dropping an event, while preserving a bounded exit time.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        5 + Math.floor(Math.random() * 11),
      );
    }
  }
  if (fd === undefined) return;
  try {
    fs.writeFileSync(fd, String(process.pid));
    action();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function writeEvent(pendingDir, event) {
  const body = Buffer.from(JSON.stringify(event), "utf8");
  if (body.length > MAX_EVENT_BYTES)
    throw new Error("event exceeds size limit");
  const uuid = crypto.randomUUID();
  const name = `${event.createdAt}-${event.kind}-${uuid}.json`;
  const temp = path.join(pendingDir, `.${name}.${process.pid}.tmp`);
  const target = path.join(pendingDir, name);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, target);
}

async function main() {
  const kind = process.argv[2];
  if (!ALLOWED_KINDS.has(kind)) return;
  const raw = await readBoundedStdin();
  if (raw === null) return;
  let input;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return;
  }
  if (!isRecord(input) || input.stop_hook_active === true) return;
  if (kind === "stop" && hasOutstandingBackgroundWork(input)) return;

  const rootValue = process.env.CLAUDE_PROJECT_DIR;
  if (!rootValue || !path.isAbsolute(rootValue)) return;
  const root = path.resolve(rootValue);
  const managedRoot = path.join(root, ".claude", "claude-remote-notifier");
  const manifestPath = path.join(managedRoot, "install.json");
  const spoolDir = path.join(managedRoot, "spool", "v2");
  const pendingDir = path.join(spoolDir, "pending");
  const writerLock = path.join(spoolDir, ".writer.lock");

  try {
    assertRegularFileNoSymlink(manifestPath);
    assertRegularFileNoSymlink(__filename);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assertSafeInstallation(root, managedRoot, manifest);
    fs.chmodSync(managedRoot, 0o700);
    fs.chmodSync(pendingDir, 0o700);
    withWriterLock(writerLock, () => {
      const pendingCount = fs
        .readdirSync(pendingDir, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".json"),
        ).length;
      if (pendingCount >= MAX_PENDING_FILES) return;

      const event = {
        schemaVersion: PROTOCOL_VERSION,
        installationId: manifest.installationId,
        eventId: crypto.randomUUID(),
        kind,
        createdAt: Date.now(),
        sessionHash: sessionHash(input.session_id),
      };
      if (kind === "permission") {
        const toolName = boundedToolName(input.tool_name);
        if (toolName) event.toolName = toolName;
      }
      if (kind === "stop_failure") event.errorKind = errorKind(input);
      writeEvent(pendingDir, event);
    });
  } catch {
    // Notifications are best-effort and must never change Claude Code behavior.
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
