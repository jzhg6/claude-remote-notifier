# Contributing

Issues and focused pull requests are welcome.

## Development

```bash
npm ci
npm run check
npm run package
```

Use synthetic hook payloads and temporary workspaces in tests. Never add real `.claude/settings*.json`, transcripts, event spool contents, credentials, or local absolute paths.

The runtime protocol and setup/uninstall behavior are security-sensitive. Changes should include tests for malformed input, resource bounds, idempotence, preservation of unrelated JSONC content, and failure recovery.

## Scope

The supported first-release scope is Windows as the local UI host and VS Code Remote-SSH as the remote transport. Proposals for other platforms should preserve the no-port design and should not weaken Workspace Trust, data minimization, or bounded resource use.
