import { existsSync, readFileSync } from "node:fs";

/** Every flag defaults to false: a missing block, missing flag, invalid value or parse error is off. */
export type MemoryConfig = {
  journal: boolean; requests: boolean; answers: "final" | false; answerPolicy: "carry" | false;
  intent: boolean; resume: boolean; recall: boolean;
  scope: { mode: "only" | "all"; names: string[] }; coordinators: string[]; trustRpc: boolean;
};
export type MemoryFlag = "journal" | "requests" | "intent" | "resume" | "recall";
export type ParsedMemoryConfig = { config: MemoryConfig; reasons: string[] };
/** Flags that register model-visible tools; only these decide whether the tool list changes at load. */
export const TOOL_FLAGS = ["intent", "recall"] as const satisfies readonly MemoryFlag[];

export const memoryOff = (): MemoryConfig => ({ journal: false, requests: false, answers: false, answerPolicy: false,
  intent: false, resume: false, recall: false, scope: { mode: "only", names: [] }, coordinators: [], trustRpc: false });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);

function flag(raw: Record<string, unknown>, key: MemoryFlag | "trustRpc", reasons: string[]): boolean {
  if (raw[key] === undefined) return false;
  if (typeof raw[key] === "boolean") return raw[key];
  reasons.push(`memory.${key} must be a boolean`);
  return false;
}
function literal<T extends string>(raw: Record<string, unknown>, key: string, allowed: T, reasons: string[]): T | false {
  if (raw[key] === undefined) return false;
  if (raw[key] === allowed) return allowed;
  reasons.push(`memory.${key} must be "${allowed}"`);
  return false;
}
function scope(raw: unknown, reasons: string[]): MemoryConfig["scope"] {
  if (raw === undefined) return { mode: "only", names: [] };
  const value = isRecord(raw) ? raw : undefined;
  if (value?.mode === "all") return { mode: "all", names: [] };
  if (value?.mode === "only" && strings(value.names)) return { mode: "only", names: [...value.names] };
  reasons.push("memory.scope must be {mode:\"all\"} or {mode:\"only\", names:[non-empty strings]}");
  return { mode: "only", names: [] };
}

/** Pure and total: never throws, never grants anything the input did not spell out. */
export function parseMemoryConfig(root: unknown): ParsedMemoryConfig {
  const reasons: string[] = [];
  const raw = isRecord(root) ? root.memory : undefined;
  if (raw === undefined) return { config: memoryOff(), reasons };
  if (!isRecord(raw)) return { config: memoryOff(), reasons: ["memory must be an object"] };
  const config = memoryOff();
  config.journal = flag(raw, "journal", reasons);
  config.requests = flag(raw, "requests", reasons);
  if (config.requests && !config.journal) { config.requests = false; reasons.push("memory.requests requires memory.journal"); }
  config.answers = literal(raw, "answers", "final", reasons);
  config.answerPolicy = literal(raw, "answerPolicy", "carry", reasons);
  for (const key of ["intent", "resume", "recall"] as const) config[key] = flag(raw, key, reasons);
  config.scope = scope(raw.scope, reasons);
  if (raw.coordinators !== undefined) {
    if (strings(raw.coordinators)) config.coordinators = [...raw.coordinators];
    else reasons.push("memory.coordinators must be an array of non-empty strings");
  }
  config.trustRpc = flag(raw, "trustRpc", reasons);
  // One invalid value anywhere distrusts the whole block: nothing stays on.
  return { config: reasons.length ? memoryOff() : config, reasons };
}

export function readMemoryConfig(file: string): ParsedMemoryConfig {
  try { return existsSync(file) ? parseMemoryConfig(JSON.parse(readFileSync(file, "utf8"))) : { config: memoryOff(), reasons: [] }; }
  catch { return { config: memoryOff(), reasons: ["memory config unreadable"] }; }
}

/** `names: []` is nobody; only an explicit `mode:"all"` means everyone. An unnamed session matches `all` only. */
export function inScope(config: MemoryConfig, name: string | undefined): boolean {
  return config.scope.mode === "all" || (name !== undefined && config.scope.names.includes(name));
}
export function flagOn(config: MemoryConfig, name: string | undefined, key: MemoryFlag): boolean {
  return config[key] === true && inScope(config, name);
}
export const anyToolFlag = (config: MemoryConfig): boolean => TOOL_FLAGS.some(key => config[key]);

type ToolDefinition = { name: string; execute: (...args: any[]) => unknown };
type ToolHost = { registerTool(tool: any): void };
export const MEMORY_DISABLED = "memory disabled";

/** Register at load only when the flag is on right then; every call re-checks, so rollback is immediate.
 * Enabling a tool for a running session needs a restart because registration happens once. */
export function registerMemoryTool<T extends ToolDefinition>(pi: ToolHost, tool: T, key: (typeof TOOL_FLAGS)[number],
  current: () => MemoryConfig, name: () => string | undefined): boolean {
  if (!current()[key]) return false;
  pi.registerTool({ ...tool, execute: async (...args: unknown[]) => {
    let allowed = false;
    try { allowed = flagOn(current(), name(), key); } catch { /* Fail closed. */ }
    if (!allowed) return { content: [{ type: "text", text: MEMORY_DISABLED }], details: { disabled: true } };
    return tool.execute(...args);
  } });
  return true;
}
