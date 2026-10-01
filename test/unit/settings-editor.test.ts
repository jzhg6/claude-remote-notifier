import { describe, expect, it } from "vitest";
import {
  countManagedHooks,
  hasLegacyHooks,
  installHooks,
  managedHookIssues,
  restoreLegacyHooks,
  uninstallHooks,
} from "../../src/setup/settings-editor";

const base = `{
  // Preserve this comment.
  "permissions": {
    "allow": ["Bash(git status)"]
  },
  "hooks": {
    "Stop": [{
      "hooks": [{"type": "command", "command": "other-tool"}]
    }]
  }
}\n`;

describe("settings editor", () => {
  it("preserves unrelated settings and installs one managed hook per event", () => {
    const result = installHooks(base, {
      includeSubagent: false,
      removeLegacy: true,
    });
    expect(result).toContain("Preserve this comment");
    expect(result).toContain("Bash(git status)");
    expect(result).toContain('"command": "other-tool"');
    expect(countManagedHooks(result)).toBe(4);
    expect(
      installHooks(result, { includeSubagent: false, removeLegacy: true }),
    ).toBe(result);
  });

  it("optionally installs SubagentStop", () => {
    const result = installHooks("{}\n", {
      includeSubagent: true,
      removeLegacy: false,
    });
    expect(countManagedHooks(result)).toBe(5);
    expect(result).toContain('"SubagentStop"');
  });

  it("uninstalls only managed hooks", () => {
    const installed = installHooks(base, {
      includeSubagent: true,
      removeLegacy: true,
    });
    const result = uninstallHooks(installed);
    expect(countManagedHooks(result)).toBe(0);
    expect(result).toContain('"command": "other-tool"');
    expect(result).toContain("Bash(git status)");
  });

  it("removes the exact legacy bridge signature during setup", () => {
    const legacy = `{
      "hooks": {
        "Stop": [{"hooks": [{"type":"command","command":"node","args":["\${CLAUDE_PROJECT_DIR}/tools/agent-attention-companion/hook/event-bridge.cjs","stop"],"timeout":2}]}]
      }
    }`;
    expect(hasLegacyHooks(legacy)).toBe(true);
    const result = installHooks(legacy, {
      includeSubagent: false,
      removeLegacy: true,
    });
    expect(hasLegacyHooks(result)).toBe(false);
    expect(countManagedHooks(result)).toBe(4);
  });

  it("rejects malformed JSONC and duplicate keys", () => {
    expect(() =>
      installHooks('{"hooks":', {
        includeSubagent: false,
        removeLegacy: false,
      }),
    ).toThrow(/invalid JSONC/);
    expect(() =>
      installHooks('{"hooks":{},"hooks":{}}', {
        includeSubagent: false,
        removeLegacy: false,
      }),
    ).toThrow(/duplicate JSON key/);
  });

  it("detects and repairs a managed hook moved to the wrong event", () => {
    const installed = JSON.parse(
      installHooks("{}\n", { includeSubagent: false, removeLegacy: false }),
    );
    installed.hooks.Notification = [installed.hooks.Stop[0]];
    delete installed.hooks.Stop;
    const drifted = JSON.stringify(installed, null, 2);
    expect(managedHookIssues(drifted, false).join(" ")).toMatch(
      /Stop\/stop|Unexpected/,
    );
    const repaired = installHooks(drifted, {
      includeSubagent: false,
      removeLegacy: false,
    });
    expect(managedHookIssues(repaired, false)).toEqual([]);
    expect(countManagedHooks(repaired)).toBe(4);
  });

  it("removes only the managed handler from a mixed hook entry", () => {
    const installed = JSON.parse(
      installHooks("{}\n", { includeSubagent: false, removeLegacy: false }),
    );
    installed.hooks.Stop[0].hooks.push({
      type: "command",
      command: "user-custom-command",
    });
    const mixed = JSON.stringify(installed, null, 2);
    const removed = JSON.parse(uninstallHooks(mixed));
    expect(removed.hooks.Stop).toHaveLength(1);
    expect(removed.hooks.Stop[0].hooks).toEqual([
      { type: "command", command: "user-custom-command" },
    ]);
  });

  it("restores legacy handlers without overwriting concurrent settings", () => {
    const original = `{
      "permissions": {"allow": ["Bash(git status)"]},
      "hooks": {
        "Stop": [{
          "hooks": [
            {"type":"command","command":"node","args":["\${CLAUDE_PROJECT_DIR}/tools/agent-attention-companion/hook/event-bridge.cjs","stop"],"timeout":2},
            {"type":"command","command":"user-custom-command"}
          ]
        }]
      }
    }`;
    const installed = installHooks(original, {
      includeSubagent: false,
      removeLegacy: true,
    });
    const concurrent = JSON.parse(installed);
    concurrent.env = { CONCURRENT_EDIT: "preserve-me" };
    const withoutManaged = uninstallHooks(JSON.stringify(concurrent, null, 2));
    const restored = restoreLegacyHooks(withoutManaged, original);
    expect(restored).toContain("CONCURRENT_EDIT");
    expect(restored).toContain("agent-attention-companion");
    expect(restored.match(/user-custom-command/g)).toHaveLength(1);
  });
});
