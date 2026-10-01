import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type FormattingOptions,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { MANAGED_HOOK_RELATIVE, MAX_SETTINGS_BYTES } from "../constants";

export interface HookInstallOptions {
  includeSubagent: boolean;
  removeLegacy: boolean;
}

interface HookDefinition {
  event: string;
  kind: string;
  matcher?: string;
}

const DEFINITIONS: HookDefinition[] = [
  { event: "Stop", kind: "stop" },
  { event: "StopFailure", kind: "stop_failure" },
  { event: "PermissionRequest", kind: "permission" },
  { event: "PreToolUse", kind: "question", matcher: "AskUserQuestion" },
  { event: "SubagentStop", kind: "subagent_stop" },
];

const MANAGED_SCRIPT = `\${CLAUDE_PROJECT_DIR}/${MANAGED_HOOK_RELATIVE}`;
const LEGACY_SCRIPT =
  "${CLAUDE_PROJECT_DIR}/tools/agent-attention-companion/hook/event-bridge.cjs";

export function managedHookDefinitions(
  includeSubagent: boolean,
): HookDefinition[] {
  return DEFINITIONS.filter(
    (definition) => includeSubagent || definition.kind !== "subagent_stop",
  );
}

export function installHooks(
  text: string,
  options: HookInstallOptions,
): string {
  const settings = parseAndValidate(text);
  const hooks = cloneObject(settings.hooks);
  const desired = managedHookDefinitions(options.includeSubagent);

  for (const [event, value] of Object.entries(hooks)) {
    const retained = arrayValue(value)
      .map((entry) => stripBridgeHandlers(entry, true, options.removeLegacy))
      .filter((entry): entry is unknown => entry !== undefined);
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }
  for (const definition of desired) {
    const entries = arrayValue(hooks[definition.event]);
    entries.push(createEntry(definition));
    hooks[definition.event] = entries;
  }

  return updateHooks(text, hooks);
}

export function uninstallHooks(text: string): string {
  const settings = parseAndValidate(text);
  const hooks = cloneObject(settings.hooks);
  for (const [event, value] of Object.entries(hooks)) {
    const retained = arrayValue(value)
      .map((entry) => stripBridgeHandlers(entry, true, false))
      .filter((entry): entry is unknown => entry !== undefined);
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }
  return updateHooks(text, hooks);
}

export function restoreLegacyHooks(
  currentText: string,
  originalText: string,
): string {
  const current = parseAndValidate(currentText);
  const original = parseAndValidate(originalText);
  const hooks = cloneObject(current.hooks);
  const originalHooks = cloneObject(original.hooks);
  for (const [event, value] of Object.entries(originalHooks)) {
    for (const originalEntry of arrayValue(value)) {
      if (!isRecord(originalEntry)) continue;
      const legacyHandlers = arrayValue(originalEntry.hooks).filter(
        isLegacyHandler,
      );
      if (legacyHandlers.length === 0) continue;
      const entries = arrayValue(hooks[event]);
      const matcher = originalEntry.matcher ?? undefined;
      const targetIndex = entries.findIndex(
        (entry) => isRecord(entry) && (entry.matcher ?? undefined) === matcher,
      );
      if (targetIndex >= 0 && isRecord(entries[targetIndex])) {
        const target = structuredClone(entries[targetIndex]);
        const handlers = arrayValue(target.hooks);
        for (const handler of legacyHandlers) {
          if (
            !handlers.some(
              (candidate) =>
                JSON.stringify(candidate) === JSON.stringify(handler),
            )
          ) {
            handlers.push(structuredClone(handler));
          }
        }
        target.hooks = handlers;
        entries[targetIndex] = target;
      } else {
        entries.push({
          ...structuredClone(originalEntry),
          hooks: structuredClone(legacyHandlers),
        });
      }
      hooks[event] = entries;
    }
  }
  return updateHooks(currentText, hooks);
}

export function countManagedHooks(text: string): number {
  const settings = parseAndValidate(text);
  const hooks = cloneObject(settings.hooks);
  return Object.values(hooks)
    .flatMap((value) => arrayValue(value))
    .filter(isManagedEntry).length;
}

export function managedHookIssues(
  text: string,
  includeSubagent: boolean,
): string[] {
  const settings = parseAndValidate(text);
  const hooks = cloneObject(settings.hooks);
  const desired = managedHookDefinitions(includeSubagent);
  const issues: string[] = [];
  for (const definition of desired) {
    const count = arrayValue(hooks[definition.event]).filter((entry) =>
      isExactManagedEntry(entry, definition),
    ).length;
    if (count !== 1) {
      issues.push(
        `Expected exactly one ${definition.event}/${definition.kind} hook, found ${count}.`,
      );
    }
  }
  const expectedKinds = new Set(desired.map((definition) => definition.kind));
  for (const [event, value] of Object.entries(hooks)) {
    for (const entry of arrayValue(value)) {
      if (!isManagedEntry(entry)) continue;
      const kind = managedKind(entry);
      const definition = desired.find(
        (candidate) => candidate.event === event && candidate.kind === kind,
      );
      if (
        !kind ||
        !expectedKinds.has(kind) ||
        !definition ||
        !isExactManagedEntry(entry, definition)
      ) {
        issues.push(`Unexpected or malformed managed hook in ${event}.`);
      }
    }
  }
  return issues;
}

export function hasLegacyHooks(text: string): boolean {
  const settings = parseAndValidate(text);
  const hooks = cloneObject(settings.hooks);
  return Object.values(hooks)
    .flatMap((value) => arrayValue(value))
    .some(isLegacyEntry);
}

function createEntry(definition: HookDefinition): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    hooks: [
      {
        type: "command",
        command: "node",
        args: [MANAGED_SCRIPT, definition.kind],
        timeout: 2,
      },
    ],
  };
  if (definition.matcher) entry.matcher = definition.matcher;
  return entry;
}

function isExactManagedEntry(
  value: unknown,
  definition: HookDefinition,
): boolean {
  if (!isRecord(value)) return false;
  if ((value.matcher ?? undefined) !== (definition.matcher ?? undefined))
    return false;
  const handlers = arrayValue(value.hooks);
  if (handlers.length !== 1 || !isRecord(handlers[0])) return false;
  const handler = handlers[0];
  const args = arrayValue(handler.args);
  return (
    handler.type === "command" &&
    handler.command === "node" &&
    handler.timeout === 2 &&
    args.length === 2 &&
    args[0] === MANAGED_SCRIPT &&
    args[1] === definition.kind
  );
}

function managedKind(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const handler of arrayValue(value.hooks)) {
    if (!isRecord(handler)) continue;
    const args = arrayValue(handler.args);
    if (
      handler.command === "node" &&
      args[0] === MANAGED_SCRIPT &&
      typeof args[1] === "string"
    ) {
      return args[1];
    }
  }
  return undefined;
}

function stripBridgeHandlers(
  value: unknown,
  removeManaged: boolean,
  removeLegacy: boolean,
): unknown | undefined {
  if (!isRecord(value)) return value;
  const handlers = arrayValue(value.hooks);
  const retained = handlers.filter(
    (handler) =>
      !(removeManaged && isManagedHandler(handler)) &&
      !(removeLegacy && isLegacyHandler(handler)),
  );
  if (retained.length === handlers.length) return value;
  if (retained.length === 0) return undefined;
  return { ...value, hooks: retained };
}

function isManagedHandler(value: unknown): boolean {
  return isBridgeHandler(value, MANAGED_SCRIPT);
}

function isLegacyHandler(value: unknown): boolean {
  return isBridgeHandler(value, LEGACY_SCRIPT);
}

function isManagedEntry(value: unknown): boolean {
  return isBridgeEntry(value, MANAGED_SCRIPT);
}

function isLegacyEntry(value: unknown): boolean {
  return isBridgeEntry(value, LEGACY_SCRIPT);
}

function isBridgeEntry(value: unknown, script: string): boolean {
  if (!isRecord(value)) return false;
  return arrayValue(value.hooks).some((handler) =>
    isBridgeHandler(handler, script),
  );
}

function isBridgeHandler(value: unknown, script: string): boolean {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    value.command !== "node"
  ) {
    return false;
  }
  const args = arrayValue(value.args);
  return args.length === 2 && args[0] === script && typeof args[1] === "string";
}

function parseAndValidate(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) {
    throw new Error("settings.local.json exceeds 1 MiB");
  }
  const source = text.trim() ? text : "{}\n";
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!tree || errors.length > 0)
    throw new Error("settings.local.json contains invalid JSONC");
  assertNoDuplicateKeys(tree);
  const value = parse(source, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (!isRecord(value))
    throw new Error("settings.local.json root must be an object");
  if (value.hooks !== undefined && !isRecord(value.hooks)) {
    throw new Error("settings.local.json hooks must be an object");
  }
  for (const [event, entries] of Object.entries(cloneObject(value.hooks))) {
    if (!Array.isArray(entries))
      throw new Error(`hooks.${event} must be an array`);
  }
  return value;
}

function assertNoDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      if (property.type !== "property" || !property.children?.[0]) continue;
      const key = String(property.children[0].value);
      if (seen.has(key)) throw new Error(`duplicate JSON key: ${key}`);
      seen.add(key);
      const value = property.children[1];
      if (value) assertNoDuplicateKeys(value);
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) assertNoDuplicateKeys(child);
  }
}

function updateHooks(text: string, hooks: Record<string, unknown>): string {
  const source = text.trim() ? text : "{}\n";
  const formatting: FormattingOptions = {
    insertSpaces: true,
    tabSize: detectIndent(source),
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  };
  const value = Object.keys(hooks).length > 0 ? hooks : undefined;
  const edits = modify(source, ["hooks"], value, {
    formattingOptions: formatting,
  });
  return applyEdits(source, edits);
}

function detectIndent(text: string): number {
  const match = text.match(/\n( +)"/);
  return match ? Math.max(2, match[1]!.length) : 2;
}

function cloneObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return structuredClone(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
