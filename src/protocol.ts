import { createHash } from "node:crypto";
import {
  EVENT_KINDS,
  type AckStatus,
  type BridgeEvent,
  type EventKind,
} from "./types";

const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);
const ERROR_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{16}$/;
const UUID_PATTERN = /^[a-f0-9-]{32,36}$/i;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function eventIdHash(eventId: string): string {
  return sha256(eventId);
}

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && EVENT_KIND_SET.has(value);
}

export function parseBridgeEvent(
  raw: Uint8Array,
  installationId: string,
  now = Date.now(),
  maxAgeMs = 600_000,
): BridgeEvent {
  const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<
    string,
    unknown
  >;
  if (parsed.schemaVersion !== 2) throw new Error("unsupported schemaVersion");
  if (parsed.installationId !== installationId)
    throw new Error("installationId mismatch");
  if (!UUID_PATTERN.test(String(parsed.eventId ?? "")))
    throw new Error("invalid eventId");
  if (!isEventKind(parsed.kind)) throw new Error("invalid event kind");
  if (!Number.isFinite(parsed.createdAt)) throw new Error("invalid createdAt");
  const createdAt = Number(parsed.createdAt);
  if (createdAt > now + 5 * 60 * 1000)
    throw new Error("event timestamp is in the future");
  if (now - createdAt > maxAgeMs) throw new Error("event expired");
  if (!HASH_PATTERN.test(String(parsed.sessionHash ?? "")))
    throw new Error("invalid sessionHash");
  if (parsed.toolName !== undefined && !isBoundedText(parsed.toolName, 128)) {
    throw new Error("invalid toolName");
  }
  if (parsed.errorKind !== undefined) {
    if (
      typeof parsed.errorKind !== "string" ||
      !ERROR_KIND_PATTERN.test(parsed.errorKind)
    ) {
      throw new Error("invalid errorKind");
    }
  }
  return parsed as unknown as BridgeEvent;
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export function notificationText(
  kind: EventKind,
  toolName?: string,
): { title: string; body: string } {
  switch (kind) {
    case "permission":
      return {
        title: "Claude Code needs permission",
        body: toolName
          ? `Waiting to use ${toolName}.`
          : "A permission decision is waiting.",
      };
    case "question":
      return {
        title: "Claude Code is waiting",
        body: "A question needs your answer.",
      };
    case "stop_failure":
      return {
        title: "Claude Code stopped",
        body: "The request ended with an API error.",
      };
    case "subagent_stop":
      return {
        title: "Claude Code subagent finished",
        body: "A background subagent has stopped.",
      };
    case "probe":
      return {
        title: "Claude Remote Notifier",
        body: "The Remote-SSH event bridge is working.",
      };
    default:
      return {
        title: "Claude Code finished",
        body: "The current turn has stopped.",
      };
  }
}

export function isCompletionKind(kind: EventKind): boolean {
  return kind === "stop" || kind === "subagent_stop";
}

export function isAttentionKind(kind: EventKind): boolean {
  return (
    kind === "permission" || kind === "question" || kind === "stop_failure"
  );
}

export function isAckStatus(value: unknown): value is AckStatus {
  return ["shown", "suppressed", "expired", "invalid", "failed"].includes(
    String(value),
  );
}
