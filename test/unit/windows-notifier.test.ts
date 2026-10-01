import { describe, expect, it } from "vitest";
import { cleanText } from "../../src/notification/windows-notifier";

describe("Windows notification text", () => {
  it("removes control characters, normalizes whitespace, and bounds length", () => {
    expect(cleanText(" hello\u0000\n  world ", 20)).toBe("hello world");
    expect(cleanText("x".repeat(100), 12)).toHaveLength(12);
  });
});
