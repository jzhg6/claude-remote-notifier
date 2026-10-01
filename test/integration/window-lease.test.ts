import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WindowLease } from "../../src/bridge/window-lease";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "win32")(
  "local named-pipe window lease",
  () => {
    it("elects one owner and lets a follower take over", async () => {
      const uri = `vscode-remote://ssh-remote/workspace-${randomUUID()}`;
      const first = new WindowLease(
        uri,
        () => false,
        () => {},
        () => {},
      );
      const second = new WindowLease(
        uri,
        () => true,
        () => {},
        () => {},
      );
      first.start();
      second.start();
      await wait(1000);
      expect(Number(first.isOwner()) + Number(second.isOwner())).toBe(1);
      const owner = first.isOwner() ? first : second;
      const follower = first.isOwner() ? second : first;
      owner.dispose();
      await wait(1500);
      expect(follower.isOwner()).toBe(true);
      follower.dispose();
    }, 10_000);
  },
);

it("does not leave an orphan owner when disposed before listen completes", async () => {
  const uri = `vscode-remote://ssh-remote/prelisten-${randomUUID()}`;
  const first = new WindowLease(
    uri,
    () => false,
    () => {},
    () => {},
  );
  first.start();
  first.dispose();
  const second = new WindowLease(
    uri,
    () => false,
    () => {},
    () => {},
  );
  second.start();
  await wait(1000);
  expect(second.isOwner()).toBe(true);
  second.dispose();
}, 10_000);
