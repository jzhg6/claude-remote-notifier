import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceHook = join(process.cwd(), "resources", "hook", "event-bridge.cjs");
const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  hook: string;
  pending: string;
}> {
  const root = join(tmpdir(), `claude-remote-notifier-${randomUUID()}`);
  roots.push(root);
  const managed = join(root, ".claude", "claude-remote-notifier");
  const runtime = join(managed, "runtime");
  const pending = join(managed, "spool", "v2", "pending");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(pending, { recursive: true, mode: 0o700 });
  await mkdir(join(managed, "spool", "v2", "inflight"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(managed, "spool", "v2", "acks"), {
    recursive: true,
    mode: 0o700,
  });
  const hook = join(runtime, "event-bridge.cjs");
  await cp(sourceHook, hook);
  await chmod(hook, 0o755);
  const hash = createHash("sha256")
    .update(await readFile(hook))
    .digest("hex");
  await writeFile(
    join(managed, "install.json"),
    JSON.stringify({
      product: "claude-remote-notifier",
      protocolVersion: 2,
      installationId: "123e4567-e89b-12d3-a456-426614174000",
      hookSha256: hash,
    }),
  );
  return { root, hook, pending };
}

function invoke(
  hook: string,
  root: string,
  kind: string,
  payload: unknown,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, kind], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      stderr ? reject(new Error(stderr)) : resolve(code),
    );
    child.stdin.end(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("remote event bridge", () => {
  it("writes minimal independent events and suppresses sensitive prose", async () => {
    const { root, hook, pending } = await fixture();
    expect(
      await invoke(hook, root, "permission", {
        session_id: "secret-session",
        tool_name: "Bash",
        tool_input: { command: "curl -H 'Authorization: Bearer secret'" },
      }),
    ).toBe(0);
    const files = await readdir(pending);
    expect(files).toHaveLength(1);
    const event = JSON.parse(await readFile(join(pending, files[0]!), "utf8"));
    expect(event.kind).toBe("permission");
    expect(event.toolName).toBe("Bash");
    expect(JSON.stringify(event)).not.toContain("secret-session");
    expect(JSON.stringify(event)).not.toContain("Authorization");
  });

  it("does not emit a completion event while background work remains", async () => {
    const { root, hook, pending } = await fixture();
    expect(
      await invoke(hook, root, "stop", { background_tasks: [{ id: "task" }] }),
    ).toBe(0);
    expect(await readdir(pending)).toHaveLength(0);
  });

  it("drops oversized input without hanging", async () => {
    const { root, hook, pending } = await fixture();
    expect(await invoke(hook, root, "stop", "x".repeat(70 * 1024))).toBe(0);
    expect(await readdir(pending)).toHaveLength(0);
  });

  it("keeps concurrent events separate", async () => {
    const { root, hook, pending } = await fixture();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        invoke(hook, root, "stop", { session_id: `session-${index}` }),
      ),
    );
    const files = await readdir(pending);
    expect(files).toHaveLength(40);
    expect(new Set(files).size).toBe(40);
  });

  it("refuses a symlinked pending directory", async () => {
    const { root, hook, pending } = await fixture();
    const outside = join(
      tmpdir(),
      `claude-remote-notifier-outside-${randomUUID()}`,
    );
    roots.push(outside);
    await mkdir(outside, { recursive: true });
    await rm(pending, { recursive: true });
    await symlink(outside, pending);
    expect(await invoke(hook, root, "stop", { session_id: "session" })).toBe(0);
    expect(await readdir(outside)).toHaveLength(0);
    expect((await lstat(pending)).isSymbolicLink()).toBe(true);
  });

  it("maps StopFailure details to a non-sensitive error category", async () => {
    const { root, hook, pending } = await fixture();
    expect(
      await invoke(hook, root, "stop_failure", {
        session_id: "session",
        error_details: {
          code: "rate_limit_error",
          message: "Authorization Bearer top-secret rejected with 429",
        },
      }),
    ).toBe(0);
    const file = (await readdir(pending))[0]!;
    const event = JSON.parse(await readFile(join(pending, file), "utf8"));
    expect(event.errorKind).toBe("rate_limit");
    expect(JSON.stringify(event)).not.toContain("top-secret");
  });

  it("refuses a symlinked install manifest", async () => {
    const { root, hook, pending } = await fixture();
    const managed = join(root, ".claude", "claude-remote-notifier");
    const manifest = join(managed, "install.json");
    const outside = join(
      tmpdir(),
      `claude-remote-notifier-manifest-${randomUUID()}`,
    );
    roots.push(outside);
    await mkdir(outside, { recursive: true });
    const outsideManifest = join(outside, "install.json");
    await cp(manifest, outsideManifest);
    await rm(manifest);
    await symlink(outsideManifest, manifest);
    expect(await invoke(hook, root, "stop", { session_id: "session" })).toBe(0);
    expect(await readdir(pending)).toHaveLength(0);
  });

  it("enforces the pending capacity under concurrent hook processes", async () => {
    const { root, hook, pending } = await fixture();
    await Promise.all(
      Array.from({ length: 255 }, (_, index) =>
        writeFile(join(pending, `${index}.json`), "{}"),
      ),
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        invoke(hook, root, "stop", { session_id: `capacity-${index}` }),
      ),
    );
    const files = (await readdir(pending)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files.length).toBeLessThanOrEqual(256);
  });

  it("prefers the normalized StopFailure error field", async () => {
    const { root, hook, pending } = await fixture();
    expect(
      await invoke(hook, root, "stop_failure", {
        session_id: "session",
        error: "max_output_tokens",
        error_details: {
          message: "rate limit text that must not override error",
        },
      }),
    ).toBe(0);
    const file = (await readdir(pending))[0]!;
    const event = JSON.parse(await readFile(join(pending, file), "utf8"));
    expect(event.errorKind).toBe("max_output_tokens");
  });
});
