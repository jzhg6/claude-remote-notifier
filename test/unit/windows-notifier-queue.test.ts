import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsNotificationQueue } from "../../src/notification/windows-notifier";

class FakeChild extends EventEmitter {
  public stderr = new EventEmitter();
  public pid = 42;
  public kill = vi.fn();
}

afterEach(() => vi.restoreAllMocks());

describe("Windows notification queue", () => {
  it("serializes notification processes and passes a minimal environment", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.SHOULD_NOT_LEAK_TO_CHILD = "secret";
    let active = 0;
    let maxActive = 0;
    const environments: NodeJS.ProcessEnv[] = [];
    const fakeSpawn = vi.fn((...args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      active += 1;
      maxActive = Math.max(maxActive, active);
      environments.push((args[2]?.env ?? {}) as NodeJS.ProcessEnv);
      queueMicrotask(() => {
        active -= 1;
        child.emit("exit", 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const queue = new WindowsNotificationQueue(() => {}, fakeSpawn);
    const [first, second] = await Promise.all([
      queue.enqueue({ title: "one", message: "first" }),
      queue.enqueue({ title: "two", message: "second" }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(environments[0]!.SHOULD_NOT_LEAK_TO_CHILD).toBeUndefined();
    expect(environments[0]!.CLAUDE_REMOTE_NOTIFIER_TITLE).toHaveLength(3);
    expect(environments[1]!.CLAUDE_REMOTE_NOTIFIER_MESSAGE).toBe("second");
    delete process.env.SHOULD_NOT_LEAK_TO_CHILD;
  });

  it("retries one failed process before succeeding", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let calls = 0;
    const fakeSpawn = vi.fn(() => {
      const child = new FakeChild();
      calls += 1;
      queueMicrotask(() => child.emit("exit", calls === 1 ? 1 : 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const queue = new WindowsNotificationQueue(() => {}, fakeSpawn);
    expect((await queue.enqueue({ title: "test", message: "test" })).ok).toBe(
      true,
    );
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
  });

  it("bounds NotifyIcon title and body lengths", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let environment: NodeJS.ProcessEnv = {};
    const fakeSpawn = vi.fn((...args: Parameters<typeof spawn>) => {
      environment = (args[2]?.env ?? {}) as NodeJS.ProcessEnv;
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;
    const queue = new WindowsNotificationQueue(() => {}, fakeSpawn);
    await queue.enqueue({ title: "t".repeat(200), message: "m".repeat(900) });
    expect(environment.CLAUDE_REMOTE_NOTIFIER_TITLE).toHaveLength(63);
    expect(environment.CLAUDE_REMOTE_NOTIFIER_MESSAGE).toHaveLength(240);
  });

  it("does not retry while a timed-out process may still be exiting", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const fakeSpawn = vi.fn(
      () => new FakeChild() as unknown as ReturnType<typeof spawn>,
    ) as unknown as typeof spawn;
    const queue = new WindowsNotificationQueue(() => {}, fakeSpawn);
    const resultPromise = queue.enqueue({ title: "test", message: "test" });
    await vi.advanceTimersByTimeAsync(12_100);
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
