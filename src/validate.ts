/** Handoff checks use injected observations only; uncertain state is always warn-only. */
import { basename, isAbsolute, normalize } from "node:path";
import { RETRY, type AutoState, type HandoffInput } from "./core.ts";

interface CheckContext {
  running: Pick<AutoState, "jobs" | "subagents" | "scheduled" | "finishedJobs" | "unavailable">;
  knownIds: string[];
  exists(path: string): boolean;
  mtimeMs(path: string): number | undefined;
  branch: readonly unknown[];
  enforce: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export function recordId(value: unknown): string | undefined {
  const r = record(value), id = r.id ?? r.agentId;
  return typeof id === "string" && id.trim() ? id : undefined;
}
/** Short ids are accepted only when they identify exactly one known record. */
export function matchesId(short: string, full: string, ids: string[]): boolean {
  return short === full || (short.length >= 8 && full.startsWith(short) && ids.filter(id => id.startsWith(short)).length === 1);
}
// Deliberately small heuristic: tests/builds and unfamiliar shell commands may change state.
const READ_ONLY = /^(?:git\s+(?:status|diff|log|show|rev-parse|branch|worktree\s+list)\b|(?:ls|cat|rg|grep|find|head|tail|wc|pwd|echo)\b|gh\s+(?:(?:pr|issue|run)\s+)?(?:view|list|status|checks)\b)/;
function mutating(call: Record<string, unknown>): boolean {
  if (["edit", "write", "multi_edit", "notebook_edit"].includes(String(call.name))) return true;
  if (call.name !== "bash") return false;
  const command = record(call.arguments).command;
  return typeof command !== "string" || command.split(/;|&&|\|\||\||\r?\n/).some(part => !READ_ONLY.test(part.trim()) || /[<>`]|\$\(/.test(part));
}
function stateFile(path: string): boolean {
  return !path.includes("/handoffs/") && (path.includes("/.ai-work/") || /^STATE.*\.md$/i.test(basename(path)));
}
function lastChanges(paths: string[], branch: readonly unknown[]): Map<string, { tool: string; at: number }> {
  const changes = new Map<string, { tool: string; at: number }>();
  for (let i = branch.length - 1; i >= Math.max(0, branch.length - 2000) && changes.size < paths.length; i--) {
    const e = record(branch[i]), at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    const message = record(e.message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of [...message.content].reverse()) {
      const call = record(part), args = record(call.arguments);
      if (call.type !== "toolCall" || !mutating(call)) continue;
      for (const path of paths) {
        const edited = args.path ?? args.file_path;
        const same = typeof edited === "string" && (edited === path || (!isAbsolute(edited) && path.endsWith(`/${normalize(edited)}`)));
        if (!changes.has(path) && (call.name === "bash" || !same)) changes.set(path, { tool: String(call.name), at });
      }
    }
  }
  return changes;
}
function fileChecks(input: HandoffInput, ctx: CheckContext): { missing: string[]; stale: string[] } {
  const files = [...new Set(input.files_to_read ?? [])].slice(0, 20);
  const changes = lastChanges(files.filter(stateFile), ctx.branch);
  const missing: string[] = [], stale: string[] = [];
  for (const path of files) {
    const change = changes.get(path);
    if (!change) {
      let exists = false;
      try { exists = ctx.exists(path); } catch { /* Treat unavailable files as missing. */ }
      if (!exists) missing.push(path);
      continue;
    }
    let mtime: number | undefined;
    try { mtime = ctx.mtimeMs(path); } catch { /* A disappearing file is objectively missing. */ }
    if (mtime === undefined || !Number.isFinite(mtime)) { missing.push(path); continue; }
    if (mtime < change.at) stale.push(`State file ${path} was last modified ${new Date(mtime).toISOString()}, before the last state-changing tool call (${change.tool} at ${new Date(change.at).toISOString()}); update it, or treat its contents as stale.`);
  }
  return { missing, stale };
}
export function checkHandoff(input: HandoffInput, ctx: CheckContext): { errors: string[]; lint: string[] } {
  const errors: string[] = [], lint: string[] = [];
  const problem = (text: string, enforce = ctx.enforce) => { if (enforce) errors.push(`${text} ${RETRY}`); else lint.push(text); };
  const files = fileChecks(input, ctx);
  if (files.missing.length) problem(`files_to_read files not found: ${files.missing.slice(0, 10).map(path => `(missing) ${path}`).join(", ")}. Supply existing paths or remove them.`);
  const running = [...new Set([...ctx.running.jobs, ...ctx.running.subagents].flatMap(r => recordId(r) ? [recordId(r)!] : []))];
  const known = [...new Set([...running, ...ctx.knownIds, ...[...ctx.running.scheduled ?? [], ...ctx.running.finishedJobs ?? []].map(line => line.split(" | ")[0])])];
  const actions = input.watch_actions ?? [];
  const missing = running.filter(id => !actions.some(action => matchesId(action.id, id, known)));
  if (missing.length) problem(`watch_actions missing running ids: ${missing.join(", ")}. Add one entry per id, e.g. {"id":"${missing[0]}","target":"result","on_complete":"read result"}.`);
  const unknown = actions.filter(action => !known.some(id => matchesId(action.id, id, known)));
  if (unknown.length) {
    const available = !ctx.running.unavailable.some(message => /^pi-(?:jobs|subagents)/.test(message));
    problem(`Unknown watch_actions ids: ${unknown.map(action => action.id).join(", ")}. Use an exact known id or a unique prefix of at least 8 characters${available ? "." : "; registry unavailable, verify on resume."}`, ctx.enforce && available);
  }
  lint.push(...files.stale);
  return { errors, lint: lint.slice(0, 8).map(line => Array.from(line).slice(0, 300).join("")) };
}
