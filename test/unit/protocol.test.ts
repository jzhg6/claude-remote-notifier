import { describe, expect, it } from "vitest";
import {
  eventIdHash,
  isAttentionKind,
  isCompletionKind,
  notificationText,
  parseBridgeEvent,
} from "../../src/protocol";

const installationId = "123e4567-e89b-12d3-a456-426614174000";
const eventId = "123e4567-e89b-12d3-a456-426614174001";

function bytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      installationId,
      eventId,
      kind: "stop",
      createdAt: 1_000_000,
      sessionHash: "0123456789abcdef",
      ...overrides,
    }),
  );
}

describe("event protocol", () => {
  it("accepts a bounded matching event", () => {
    expect(
      parseBridgeEvent(bytes(), installationId, 1_000_001, 10_000).kind,
    ).toBe("stop");
  });

  it("rejects mismatched installations, future timestamps, and invalid fields", () => {
    expect(() => parseBridgeEvent(bytes(), "other", 1_000_001, 10_000)).toThrow(
      /installationId/,
    );
    expect(() =>
      parseBridgeEvent(
        bytes({ createdAt: 1_000_000 + 5 * 60 * 1000 + 1 }),
        installationId,
        1_000_000,
      ),
    ).toThrow(/future/);
    expect(() =>
      parseBridgeEvent(
        bytes({ sessionHash: "bad" }),
        installationId,
        1_000_001,
      ),
    ).toThrow(/sessionHash/);
  });

  it("classifies attention and completion events", () => {
    expect(isCompletionKind("stop")).toBe(true);
    expect(isCompletionKind("subagent_stop")).toBe(true);
    expect(isAttentionKind("permission")).toBe(true);
    expect(isAttentionKind("question")).toBe(true);
    expect(isAttentionKind("stop_failure")).toBe(true);
  });

  it("uses generic notification text without remote payload prose", () => {
    expect(notificationText("permission", "Bash")).toEqual({
      title: "Claude Code needs permission",
      body: "Waiting to use Bash.",
    });
    expect(notificationText("question").body).not.toContain("undefined");
    expect(eventIdHash(eventId)).toMatch(/^[a-f0-9]{64}$/);
  });
});
