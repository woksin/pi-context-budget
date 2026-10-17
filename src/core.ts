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
/** Hosting identity, NOT ancestry: /fork and /clone also populate parentSession. */
export function isSubagent(identity: { sessionId: string; primarySessionId: string }): boolean {
  return identity.sessionId !== identity.primarySessionId;
}
export function ownsWrapper(pid: number, env: { PI_SESSION_WRAPPER?: string; PI_SESSION_WRAPPER_PID?: string; PI_RELAUNCH_MARKER?: string; PI_SESSION_LAUNCH_ID?: string }, subagent: boolean): boolean {
  return !subagent && env.PI_SESSION_WRAPPER === "1" && env.PI_SESSION_WRAPPER_PID === String(pid)
    && /^[a-f0-9]{32}$/.test(env.PI_SESSION_LAUNCH_ID ?? "")
    && !!env.PI_RELAUNCH_MARKER && isAbsolute(env.PI_RELAUNCH_MARKER)
    && env.PI_RELAUNCH_MARKER.split("/").at(-1) === `${pid}-${env.PI_SESSION_LAUNCH_ID}.json`;
}
export function modelThresholds(config: Config, model: string, sub: boolean): Thresholds {
  const role = sub ? "subagent" : "main";
  return { ...config[role], ...config.models[model]?.[role] };
}
export type Phase = "idle" | "soft-notified" | "handoff-required" | "handoff-pending-commit" | "compacting" | "fallback-armed";
export type Fallback = "hard" | "loop" | "cap" | "compaction";
export type FailureClass = "cancelled" | "nothing-to-compact" | "transient" | "persistent";
export const MAX_COMPACTION_RETRIES = 2;
export interface MachineState {
  phase: Phase; mode: Mode; tokens: number | null; floor: number | null;
  turn: number; count: number; handoffTurns: number[]; softNotified: boolean;
  settleRequest: "none" | "budget" | "idle";
  pending?: Handoff; stored?: Handoff; lastHandoff?: Handoff;
  failures: number; compactionFallback: boolean;
  compaction?: { id: number; origin: "idle" | "backstop" };
  attempt: number; blockedCalls: string[]; lastSettled: number; observedIdle: boolean;
  providerFailure: "none" | "error" | "overflow" | "aborted";
  relaunchSent: boolean;
}
export interface Frame { mode: Mode; tokens: number | null; thresholds: Thresholds; config: Config; wrapped: boolean }
export type MachineEvent =
  | { type: "turn_end"; usage?: number; failure?: MachineState["providerFailure"] }
  | { type: "tool_call"; tool: string; id: string }
  | { type: "tool_end"; tool: string; id: string; error: boolean }
  | { type: "handoff_prepare" }
  | { type: "handoff_written"; handoff: Handoff }
  | { type: "agent_start" }
  | { type: "before_agent_start" }
  | { type: "agent_before_settle"; pendingWork: boolean }
  | { type: "agent_settled"; now: number; aborted: boolean; pendingWork: boolean }
  | { type: "input"; now: number; streaming: boolean; alreadyCompacted: boolean }
  | { type: "session_before_compact"; reason: string; tokensBefore?: number }
  | { type: "session_compact"; owned: boolean; attempt?: number }
  | { type: "session_compact_failed"; reason: string; errorMessage?: string; aborted?: boolean; fromExtension?: boolean; attempt?: number }
  | { type: "backstop_failed"; reason: string; errorMessage: string }
  | { type: "mode_changed" };
export type Effect =
  | { type: "log"; event: string; data?: Record<string, unknown> }
  | { type: "notify" }
  | { type: "write_handoff"; idleOnly: boolean }
  | { type: "reject_handoff"; reason: string }
  | { type: "block"; reason: string }
  | { type: "steer"; idleOnly: boolean }
  | { type: "commit"; handoff: Handoff }
  | { type: "compact"; attempt: number }
  | { type: "backstop"; handoff?: Handoff; tokensBefore: number }
  | { type: "relaunch"; handoff?: Handoff }
  | { type: "cancel_compaction" };
export function initialState(mode: Mode = "observe"): MachineState {
  return { phase: "idle", mode, tokens: null, floor: null, turn: 0, count: 0, handoffTurns: [], softNotified: false,
    settleRequest: "none", failures: 0, compactionFallback: false, attempt: 0, blockedCalls: [], lastSettled: 0,
    observedIdle: false, providerFailure: "none", relaunchSent: false };
}
export function classifyFailure(e: { aborted?: boolean; errorMessage?: string }): FailureClass {
  if (e.aborted || /cancelled|canceled|aborted/i.test(e.errorMessage ?? "")) return "cancelled";
  if (/nothing to compact|already compacted/i.test(e.errorMessage ?? "")) return "nothing-to-compact";
  if (/temporar|timeout|timed out|network|ECONN|EAI_AGAIN|429|503|overload|rate.?limit/i.test(e.errorMessage ?? "")) return "transient";
  return "persistent";
}
export function fallbackFor(s: MachineState, f: Frame): Fallback | undefined {
  if (s.handoffTurns.filter(t => s.turn - t <= f.config.loop.withinTurns).length > f.config.loop.maxHandoffsWithoutProgress) return "loop";
  if (s.count >= f.config.maxHandoffsPerSession) return "cap";
  if (s.compactionFallback) return "compaction";
  if (s.tokens !== null && s.tokens >= f.thresholds.hard) return "hard";
  return undefined;
}
function handoffRequired(s: MachineState, f: Frame): boolean {
  return s.tokens !== null && s.floor !== null && s.tokens >= f.thresholds.handoff && s.tokens - s.floor >= f.thresholds.minProgress;
}
function committed(s: MachineState): void {
  s.count++; s.handoffTurns.push(s.turn); s.tokens = s.floor = null;
  s.stored = s.pending ?? s.stored; s.pending = undefined;
  s.softNotified = false; s.settleRequest = "none";
  s.compaction = undefined; s.failures = 0; s.compactionFallback = s.relaunchSent = false;
}
function resetEnforcement(s: MachineState): void {
  s.pending = s.stored = undefined; s.compaction = undefined; s.blockedCalls = [];
  s.settleRequest = "none"; s.failures = 0; s.compactionFallback = s.relaunchSent = false;
}
const REQUIRED = "Call context_handoff now with goal, next_step and verified facts; preserve user_constraints verbatim and hypotheses separately. Then end the turn without further tools. Only the user may disable enforcement via config or the optional /guards off context.";
function phase(s: MachineState, f: Frame): Phase {
  if (s.mode !== "enforce") return "idle";
  if (s.compaction) return "compacting";
  if (fallbackFor(s, f)) return "fallback-armed";
  if (s.pending) return "handoff-pending-commit";
  if (handoffRequired(s, f)) return "handoff-required";
  return s.softNotified ? "soft-notified" : "idle";
}
function observe(s: MachineState, e: MachineEvent, f: Frame): Effect[] {
  if (s.mode !== "observe") return [];
  const log = (event: string): Effect[] => [{ type: "log", event }];
  if (e.type === "session_before_compact") return log("would_backstop");
  if (e.type === "handoff_prepare") return log("would_handoff");
  if (e.type === "turn_end" && fallbackFor(s, f)) return log("would_relaunch");
  if (e.type === "tool_call" && (fallbackFor(s, f) || handoffRequired(s, f))) return log("would_block");
  if (e.type === "agent_settled" && e.pendingWork && (s.tokens ?? 0) >= f.config.idleMinTokens) return log("would_idle_handoff");
  if (e.type === "input" && s.observedIdle && e.now - s.lastSettled >= f.config.idleMinutes * 60000) return log("would_idle_compact");
  return [];
}
function startCompaction(s: MachineState, origin: "idle" | "backstop"): void {
  if (!s.compaction) s.compaction = { id: ++s.attempt, origin };
}
function compactionFailed(s: MachineState, e: Extract<MachineEvent, { type: "session_compact_failed" }>): Effect[] {
  const owned = !!s.compaction;
  const classification = classifyFailure(e);
  s.compaction = undefined;
  if (classification === "cancelled" || classification === "nothing-to-compact" || (e.reason === "manual" && !owned)) {
    return [{ type: "log", event: "compaction_ignored", data: { classification, reason: e.reason } }];
  }
  s.failures++;
  s.compactionFallback = classification === "persistent" || s.failures > MAX_COMPACTION_RETRIES;
  return [{ type: "log", event: s.compactionFallback ? "compaction_fallback" : "compaction_retry_pending",
    data: { classification, failures: s.failures, retry: "next eligible input or automatic compaction boundary" } }];
}
function active(s: MachineState, e: MachineEvent, f: Frame): Effect[] {
  const fallback = fallbackFor(s, f);
  switch (e.type) {
    case "tool_call":
      if (e.tool !== "context_handoff" && (s.pending || fallback || handoffRequired(s, f))) {
        s.blockedCalls.push(e.id);
        return [{ type: "block", reason: s.pending || (fallback && s.stored) ? "Handoff stored. End this turn; do not call more tools." : `Every tool except context_handoff is blocked. ${REQUIRED}` }];
      }
      if (e.tool !== "context_handoff") s.stored = undefined;
      return [];
    case "tool_end": {
      if (s.blockedCalls.includes(e.id)) { s.blockedCalls = s.blockedCalls.filter(id => id !== e.id); return []; }
      if (e.tool !== "context_handoff") {
        s.pending = s.stored = undefined;
        if (!e.error) s.handoffTurns = [];
      }
      return [];
    }
    case "handoff_prepare": return s.pending
      ? [{ type: "reject_handoff", reason: "A handoff is already stored. End this turn without further tools." }]
      : [{ type: "write_handoff", idleOnly: s.settleRequest === "idle" }];
    case "handoff_written":
      s.lastHandoff = s.stored = e.handoff;
      if (s.settleRequest !== "idle") s.pending = e.handoff;
      return [];
    case "turn_end": {
      // Hard means WITHOUT a usable handoff. Cap/loop must not be bypassed by another handoff.
      const usable = s.pending ?? (fallback === "hard" || handoffRequired(s, f) ? s.stored : undefined);
      if (usable && fallback !== "loop" && fallback !== "cap" && s.providerFailure === "none") {
        committed(s); return [{ type: "commit", handoff: usable }];
      }
      if (s.tokens === null || s.tokens < f.thresholds.soft) s.softNotified = false;
      if (!s.softNotified && (s.tokens ?? 0) >= f.thresholds.soft) { s.softNotified = true; return [{ type: "notify" }]; }
      return [];
    }
    case "agent_before_settle":
      if (s.providerFailure !== "none" || s.settleRequest !== "none" || s.pending || (fallback && s.stored)) return [];
      if (fallback || handoffRequired(s, f)) { s.settleRequest = "budget"; return [{ type: "steer", idleOnly: false }]; }
      if (!s.stored && e.pendingWork && (s.tokens ?? 0) >= f.config.idleMinTokens) {
        s.settleRequest = "idle"; return [{ type: "steer", idleOnly: true }];
      }
      return [];
    case "agent_settled":
      if (!fallback || s.relaunchSent || e.aborted || ["error", "aborted"].includes(s.providerFailure)) return [];
      if (!f.wrapped) return [{ type: "log", event: "relaunch_unavailable", data: { reason: fallback } }];
      s.relaunchSent = true;
      return [{ type: "relaunch", handoff: s.pending ?? s.stored }];
    case "input":
      s.settleRequest = "none";
      if (s.stored && !e.streaming && s.lastSettled > 0 && e.now - s.lastSettled >= f.config.idleMinutes * 60000
        && (s.tokens ?? 0) > f.config.keepRecentTokens && !e.alreadyCompacted) {
        startCompaction(s, "idle"); return [{ type: "compact", attempt: s.compaction!.id }];
      }
      return [];
    case "session_before_compact":
      startCompaction(s, "backstop"); return [{ type: "backstop", handoff: s.stored, tokensBefore: e.tokensBefore ?? s.tokens ?? 0 }];
    case "session_compact_failed": return compactionFailed(s, e);
    case "backstop_failed":
      startCompaction(s, "backstop");
      return [...compactionFailed(s, { type: "session_compact_failed", reason: e.reason, errorMessage: e.errorMessage }), { type: "cancel_compaction" }];
    default: return [];
  }
}
/** Pure, immutable policy boundary. Inactive modes can emit ONLY telemetry, never action effects. */
export function transition(previous: MachineState, event: MachineEvent, frame: Frame): { state: MachineState; effects: Effect[] } {
  const s: MachineState = { ...previous, handoffTurns: [...previous.handoffTurns], blockedCalls: [...previous.blockedCalls], tokens: frame.tokens };
  if (s.mode !== frame.mode) { resetEnforcement(s); s.mode = frame.mode; }
  if ((event.type === "session_compact" || event.type === "session_compact_failed") && event.attempt !== undefined && s.compaction?.id !== event.attempt) {
    s.phase = phase(s, frame);
    return { state: s, effects: [] };
  }
  if (event.type === "turn_end") {
    s.turn++; s.providerFailure = event.failure ?? "none";
    if (s.floor === null && event.usage !== undefined && s.providerFailure === "none") s.floor = event.usage;
  }
  if (event.type === "before_agent_start") {
    s.pending = s.stored = undefined; s.settleRequest = "none"; s.providerFailure = "none";
  }
  if (event.type === "session_compact") {
    if (event.owned && s.mode === "enforce") committed(s);
    else { s.tokens = s.floor = null; s.compaction = undefined; s.compactionFallback = false; s.failures = 0; s.relaunchSent = false; }
  }
  const effects = s.mode === "enforce" ? active(s, event, frame) : observe(s, event, frame);
  if (event.type === "agent_settled") {
    s.lastSettled = event.now; s.observedIdle = event.pendingWork && (s.tokens ?? 0) >= frame.config.idleMinTokens;
  }
  if (event.type === "input") s.observedIdle = false;
  s.phase = phase(s, frame);
  return { state: s, effects };
}

export type HistoryItem = { type: "input" } | { type: "usage"; tokens: number } | { type: "compaction"; owned: boolean }
  | { type: "tool"; handoff?: Handoff; error?: boolean };
/** Restore persisted observations without replaying historical policy effects. */
export function restoreHistory(history: HistoryItem[], mode: Mode): MachineState {
  const s = initialState(mode);
  for (const e of history) {
    if (e.type === "input") s.stored = undefined;
    if (e.type === "usage") { s.turn++; s.tokens = e.tokens; s.floor ??= e.tokens; }
    if (e.type === "compaction") {
      s.tokens = s.floor = null;
      if (e.owned) { s.count++; s.handoffTurns.push(s.turn); }
    }
    if (e.type === "tool") {
      if (e.handoff) s.stored = s.lastHandoff = e.handoff;
      else { s.stored = undefined; if (!e.error) s.handoffTurns = []; }
    }
  }
  return s;
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
/** Automatic observations cannot consume the model's entire narrative budget. */
export function boundedAutoState(auto: AutoState): AutoState {
  const short = (text: string) => Buffer.byteLength(text) > 256 ? Buffer.from(text).subarray(0, 250).toString("utf8") + "…" : text;
  const list = (records: unknown[]) => {
    const out: unknown[] = [];
    let bytes = 0;
    for (const r of records) {
      const json = JSON.stringify(r);
      const item = Buffer.byteLength(json) > 300 ? { truncated: json.slice(0, 120) } : r;
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 768) break;
      out.push(item); bytes += size;
    }
    if (out.length < records.length) out.push({ omitted: records.length - out.length });
    return out;
  };
  return { cwd: short(auto.cwd), root: short(auto.root), branch: short(auto.branch), head: short(auto.head),
    jobs: list(auto.jobs), subagents: list(auto.subagents), claims: list(auto.claims), unavailable: auto.unavailable.slice(0, 8).map(short) };
}
export function renderHandoff(p: HandoffInput, auto: AutoState, id: string, n: number, path: string, at: string): Handoff {
  validateHandoff(p);
  auto = boundedAutoState(auto);
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
