import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { optimisticTextWrite } from "../../src/setup/remote-files";

const mock = vscode as typeof vscode & {
  __reset(): void;
  __writeText(uri: vscode.Uri, text: string): Promise<void>;
  __readText(uri: vscode.Uri): Promise<string>;
  __onRenameContaining(pattern: string, action: () => Promise<void>): void;
};

const uri = vscode.Uri.parse(
  "vscode-remote://ssh-remote/workspace/.claude/settings.local.json",
);

beforeEach(() => mock.__reset());

describe("optimistic remote text writes", () => {
  it("does not overwrite content recreated during the final rename", async () => {
    await mock.__writeText(uri, '{"value":"original"}\n');
    mock.__onRenameContaining(".settings.", async () => {
      await mock.__writeText(uri, '{"value":"concurrent"}\n');
    });
    await expect(
      optimisticTextWrite(
        uri,
        '{"value":"original"}\n',
        '{"value":"extension"}\n',
      ),
    ).rejects.toThrow(/recreated|exists/);
    expect(await mock.__readText(uri)).toContain("concurrent");
  });
});
