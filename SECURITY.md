# Security Policy

## Supported versions

The latest GitHub Release is supported. This project has not yet reached a stable 1.0 compatibility guarantee.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes credentials, permits local code execution, or can delete files outside the managed bridge directory. Use GitHub's private vulnerability reporting for this repository when available, or contact the repository owner through the address on their GitHub profile.

Include:

- extension version;
- local Windows and VS Code versions;
- remote OS, Node.js, and Claude Code versions;
- whether the workspace was trusted;
- reproduction steps using synthetic data only;
- the expected security boundary and observed result.

Do not include real hook payloads, transcripts, secrets, or complete user settings.

## Threat model

The extension treats Workspace Trust as the primary boundary. In Restricted Mode it does not install hooks or consume workspace events.

Defenses include:

- fixed, workspace-derived managed paths;
- symbolic-link checks at setup and consumption boundaries;
- exact managed hook signatures and JSONC-preserving edits;
- hook self-hash verification against the install manifest;
- bounded hook input, event records, spool size, scans, retention, and notification concurrency;
- minimal events that omit transcript, command, question, and assistant prose;
- atomic publish, claim, acknowledgement, and delete transitions;
- no listener ports, telemetry, webhooks, or outbound network calls.

A hostile process with write access inside a trusted remote workspace can race Remote-SSH file-system checks. The design uses fixed paths, symlink checks, installation IDs, hashes, and atomic renames as defense in depth, but does not claim to withstand a malicious process that already controls a trusted workspace.

Windows notification text is passed as bounded environment-variable data to a fixed PowerShell program. Remote event fields are never interpolated into PowerShell source or shell commands.
