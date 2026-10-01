import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: new URL("./test/mocks/vscode.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 45,
        lines: 50,
      },
    },
  },
});
