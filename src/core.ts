import { matchesGlob, isAbsolute, resolve } from "node:path";

export type Mode = "off" | "observe" | "enforce";
export interface Thresholds { soft: number; handoff: number; hard: number; minProgress: number }
export interface Config {
  mode: Mode;
  enforceCwds?: string[];
  main: Thresholds;
  subagent: Thresholds;
  models: Record<string, { main?: Partial<Thresholds>; subagent?: Partial<Thresholds> }>;
  idleMinutes: number;
  idleMinTokens: number;
  keepRecentTokens: number;
  maxHandoffsPerSession: number;
  loop: { maxHandoffsWithoutProgress: number; withinTurns: number };
}
const MAIN: Thresholds = { soft: 300000, handoff: 400000, hard: 600000, minProgress: 50000 };
const SUB: Thresholds = { soft: 150000, handoff: 200000, hard: 300000, minProgress: 25000 };
type ObjectValue = Record<string, unknown>;
function object(value: unknown, field: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as ObjectValue;
}
function positive(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive and finite`);
  return value;
}
function integer(value: unknown, fallback: number, field: string): number {
  const n = positive(value, fallback, field);
  if (!Number.isInteger(n)) throw new Error(`${field} must be an integer`);
  return n;
}
function thresholds(value: unknown, base: Thresholds): Thresholds {
  const v = value === undefined ? {} : object(value, "thresholds");
  const result = Object.fromEntries(Object.entries(base).map(([key, n]) => [key, positive(v[key], n, key)])) as unknown as Thresholds;
  if (result.soft > result.handoff || result.handoff > result.hard) throw new Error("Require soft <= handoff <= hard");
  return result;
}
export function parseConfig(raw: unknown): Config {
  const v = object(raw, "config");
  const mode = v.mode ?? "observe";
  if (!["off", "observe", "enforce"].includes(String(mode))) throw new Error("Invalid mode");
  const allow = v.enforceCwds;
  if (allow !== undefined && (!Array.isArray(allow) || !allow.every(p => typeof p === "string" && isAbsolute(p)))) {
    throw new Error("enforceCwds must contain absolute prefixes or globs");
  }
  const main = thresholds(v.main, MAIN), subagent = thresholds(v.subagent, SUB);
  const models: Config["models"] = {};
  for (const [ref, value] of Object.entries(v.models === undefined ? {} : object(v.models, "models"))) {
    const m = object(value, ref);
    models[ref] = { main: thresholds(m.main, main), subagent: thresholds(m.subagent, subagent) };
  }
  const loop = v.loop === undefined ? {} : object(v.loop, "loop");
  return {
    mode: mode as Mode, enforceCwds: allow as string[] | undefined, main, subagent, models,
    idleMinutes: positive(v.idleMinutes, 50, "idleMinutes"),
    idleMinTokens: positive(v.idleMinTokens, 300000, "idleMinTokens"),
    keepRecentTokens: positive(v.keepRecentTokens, 20000, "keepRecentTokens"),
    maxHandoffsPerSession: integer(v.maxHandoffsPerSession, 10, "maxHandoffsPerSession"),
    loop: { maxHandoffsWithoutProgress: integer(loop.maxHandoffsWithoutProgress, 2, "maxHandoffsWithoutProgress"),
      withinTurns: integer(loop.withinTurns, 8, "withinTurns") },
  };
}
export function effectiveMode(config: Config, cwd: string, guardOff = false): Mode {
  if (guardOff) return "off";
  if (config.mode !== "enforce" || !config.enforceCwds) return config.mode;
  const path = resolve(cwd);
  const allowed = config.enforceCwds.some(p => /[*?\[\]{}]/.test(p)
    ? matchesGlob(path, p)
    : path === resolve(p) || path.startsWith(`${resolve(p)}/`));
  return allowed ? "enforce" : "observe";
}
export function isSubagent(header: { parentSession?: string } | null | undefined): boolean {
  return typeof header?.parentSession === "string" && header.parentSession.length > 0;
}
export function modelThresholds(config: Config, model: string, sub: boolean): Thresholds {
  const role = sub ? "subagent" : "main";
  return { ...config[role], ...config.models[model]?.[role] };
}
export type Action = "none" | "handoff" | "relaunch";
export class Budget {
  floor: number | null = null;
  count = 0;
  turn = 0;
  handoffTurns: number[] = [];
  resetFloor(): void { this.floor = null; }
  measureUsage(tokens: number): void { if (this.floor === null) this.floor = tokens; }
  progressed(): void { this.handoffTurns = []; }
  committed(): void { this.count++; this.handoffTurns.push(this.turn); this.resetFloor(); }
  looped(config: Config): boolean {
    return this.handoffTurns.filter(t => this.turn - t <= config.loop.withinTurns).length > config.loop.maxHandoffsWithoutProgress;
  }
  action(tokens: number | null, t: Thresholds, config: Config): Action {
    if (this.looped(config) || this.count >= config.maxHandoffsPerSession) return "relaunch";
    if (tokens === null) return "none";
    if (tokens >= t.hard) return "relaunch";
    if (tokens >= t.handoff && this.floor !== null && tokens - this.floor >= t.minProgress) return "handoff";
    return "none";
  }
}
export function shouldBlock(mode: Mode, tool: string, action: Action, pending: boolean, wrapped: boolean): boolean {
  if (mode !== "enforce" || tool === "context_handoff") return false;
  // A wrapper-backed loop fallback must be allowed to settle; without a wrapper stay protected.
  if (action === "relaunch" && wrapped) return false;
  return pending || action !== "none";
}

export interface HandoffInput {
  goal: string; next_step: string; facts: string;
  decisions?: string; user_constraints?: string; open_items?: string; hypotheses?: string;
  files_to_read?: string[]; launch_prompt?: string;
}
export interface AutoState {
  cwd: string; root: string; branch: string; head: string;
  jobs: unknown[]; subagents: unknown[]; claims: unknown[]; unavailable: string[];
}
export interface Handoff { text: string; path: string; n: number; at: string; launchPrompt?: string }
export function validateHandoff(p: HandoffInput): void {
  for (const field of ["goal", "next_step", "facts"] as const) {
    if (typeof p[field] !== "string" || !p[field].trim()) throw new Error(`${field} is required and must be nonempty`);
  }
  for (const key of ["decisions", "user_constraints", "open_items", "hypotheses", "launch_prompt"] as const) {
    if (p[key] !== undefined && (typeof p[key] !== "string" || !p[key]!.trim())) throw new Error(`${key} must be nonempty text`);
  }
  if (p.files_to_read !== undefined && (!Array.isArray(p.files_to_read) || !p.files_to_read.every(f => typeof f === "string" && isAbsolute(f)))) {
    throw new Error("files_to_read must contain absolute paths");
  }
  if (p.launch_prompt !== undefined && !isAbsolute(p.launch_prompt)) throw new Error("launch_prompt must be an absolute path");
}
export const MAX_HANDOFF_BYTES = 12 * 1024;
export function renderHandoff(p: HandoffInput, auto: AutoState, id: string, n: number, path: string, at: string): Handoff {
  validateHandoff(p);
  const sections = [
    `# Handoff ${id}-${n}`, `Timestamp: ${at}\nHandoff file: ${path}`,
    `## Goal\n${p.goal}`, `## Verified facts (agent-reported; verify before relying on them)\n${p.facts}`,
    p.decisions && `## Decisions and why\n${p.decisions}`,
    p.user_constraints && `## User constraints (verbatim)\n${p.user_constraints}`,
    p.open_items && `## Open items\n${p.open_items}`, p.hypotheses && `## Hypotheses (unverified)\n${p.hypotheses}`,
    `## Next step\n${p.next_step}`, p.files_to_read?.length && `## Read first\n${p.files_to_read.join("\n")}`,
    `## Automatically collected state\nCwd: ${auto.cwd}\nRepository root: ${auto.root}\nBranch: ${auto.branch}\nHEAD: ${auto.head}\nLaunch prompt: ${p.launch_prompt ?? "not supplied"}\n` +
      `Running jobs / watches: ${JSON.stringify(auto.jobs)}\nRunning subagents: ${JSON.stringify(auto.subagents)}\nIssue claims: ${JSON.stringify(auto.claims)}\nUnavailable: ${auto.unavailable.join(", ") || "none"}`,
    "Resume now from Next step without asking the user. Verify current git HEAD and re-establish external state before trusting prior review/CI/issue facts.",
  ];
  const text = sections.filter(Boolean).join("\n\n") + "\n";
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_HANDOFF_BYTES) throw new Error(`Handoff is ${bytes} bytes; limit is ${MAX_HANDOFF_BYTES}. Shorten narrative and reference absolute files; do not omit user constraints.`);
  return { text, path, n, at, launchPrompt: p.launch_prompt };
}
