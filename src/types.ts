import type * as vscode from "vscode";

export const EVENT_KINDS = [
  "stop",
  "stop_failure",
  "permission",
  "question",
  "subagent_stop",
  "probe",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type AckStatus =
  | "shown"
  | "suppressed"
  | "expired"
  | "invalid"
  | "failed";

export interface BridgeEvent {
  schemaVersion: 2;
  installationId: string;
  eventId: string;
  kind: EventKind;
  createdAt: number;
  sessionHash: string;
  toolName?: string;
  errorKind?: string;
}

export interface InstallManifest {
  product: "claude-remote-notifier";
  protocolVersion: 2;
  extensionVersion: string;
  installationId: string;
  hookSha256: string;
  installedAt: string;
}

export interface AckRecord {
  schemaVersion: 1;
  eventIdHash: string;
  status: AckStatus;
  processedAt: number;
}

export interface WorkspaceUris {
  root: vscode.Uri;
  claudeDir: vscode.Uri;
  managedRoot: vscode.Uri;
  runtimeDir: vscode.Uri;
  hookFile: vscode.Uri;
  installFile: vscode.Uri;
  spoolRoot: vscode.Uri;
  pendingDir: vscode.Uri;
  inflightDir: vscode.Uri;
  ackDir: vscode.Uri;
  settingsFile: vscode.Uri;
  gitignoreFile: vscode.Uri;
}

export interface DiagnosticState {
  lastPollAt?: number;
  lastEventAt?: number;
  lastNotificationAt?: number;
  lastError?: string;
  pendingCount: number;
  inflightCount: number;
  ackCount: number;
}
