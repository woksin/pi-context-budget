import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, existsSync, type Stats } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../storage.ts";
import { scanLog } from "./log.ts";
import { readSessionState } from "./requests.ts";
import type { FoldedState } from "./types.ts";

/** Same shape the store accepts as a per-session journal file; nothing else in the directory is ever a candidate. */
export const JOURNAL_NAME = /^[A-Za-z0-9_-]{1,200}\.jsonl$/;
export const DAY_MS = 86_400_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const AUTO_MAX_MS = 200;
const DEFAULT_MAX_FILES = 5000;

export type PruneOptions = {
  home: string; state: FoldedState | (() => FoldedState); requestsOn: boolean; days: number; now?: () => number;
  currentSessionId?: string; dryRun?: boolean; maxFiles?: number; maxMs?: number; cursor?: string;
};
export type PruneResult = { examined: number; removed: number; wouldRemove: number; kept: number; protectedCount: number;
  errors: number; capped: boolean; cursor: string };
type Evidence = { ids: string[] } | undefined;

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

/** Active/proposed items plus everything they supersede: ancestors must stay valid for the live item's add to fold. */
function liveChain(state: FoldedState): Set<string> {
  const chain = new Set<string>(), queue = Object.values(state.items).filter(item => item.status === "active" || item.status === "proposed").map(item => item.id);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (chain.has(id)) continue;
    chain.add(id);
    queue.push(...(state.items[id]?.supersedes ?? []));
  }
  return chain;
}
function itemRefs(item: Record<string, unknown>): (string | undefined)[] {
  return [text(record(item.source).ref), text(record(item.authority).commandRef)];
}
function eventItemIds(event: Record<string, unknown>): string[] {
  const ids = [text(record(event.item).id), text(event.itemId)];
  for (const span of Array.isArray(event.spans) ? event.spans : []) {
    const itemIds = record(span).itemIds;
    if (Array.isArray(itemIds)) ids.push(...itemIds.map(text));
  }
  return ids.filter((id): id is string => id !== undefined);
}
function eventRefs(event: Record<string, unknown>): (string | undefined)[] {
  return [...itemRefs(record(event.item)), ...itemRefs(event), text(event.messageId)];
}
const present = (refs: (string | undefined)[]): string[] => refs.filter((ref): ref is string => ref !== undefined);
function eventEvidence(records: ReturnType<typeof scanLog>["records"], chain: Set<string>): string[] {
  const events = records.map(located => record(located.record));
  return events.filter(event => eventItemIds(event).some(id => chain.has(id))).flatMap(event => present(eventRefs(event)));
}
/** Message ids that live items need in the journal. Corrupt events log means evidence cannot be proven: undefined. */
function protectedIds(state: FoldedState, home: string): Evidence {
  const chain = liveChain(state), scan = scanLog(join(home, "events.jsonl"));
  if (scan.tornTail > 0 || scan.corrupt > 0) return undefined;
  const itemEvidence = [...chain].flatMap(id => present(itemRefs(record(state.items[id]))));
  return { ids: [...new Set([...itemEvidence, ...eventEvidence(scan.records, chain)])] };
}
/** Fail safe: unreadable, oversized or ambiguous files count as backing live evidence. */
function citesProtectedId(file: string, ids: string[]): boolean {
  if (!ids.length) return false;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    if (fstatSync(fd).size > MAX_READ_BYTES) return true;
    const body = readFileSync(fd, "utf8");
    return ids.some(id => body.includes(id));
  } catch { return true; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Keep result. */ } }
}
function hasOpenRequest(home: string, name: string): boolean {
  try { return readSessionState(home, name.slice(0, -".jsonl".length)).open.length > 0; }
  catch { return true; }
}
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size && b.isFile();

class Pass {
  readonly result: PruneResult = { examined: 0, removed: 0, wouldRemove: 0, kept: 0, protectedCount: 0, errors: 0, capped: false, cursor: "" };
  private evidence: Evidence | null = null;
  private readonly opts: PruneOptions;
  private readonly cutoff: number;
  constructor(opts: PruneOptions, cutoff: number) { this.opts = opts; this.cutoff = cutoff; }
  private ids(): Evidence {
    if (this.evidence !== null) return this.evidence;
    try {
      const { state } = this.opts;
      this.evidence = protectedIds(typeof state === "function" ? state() : state, this.opts.home);
    } catch { this.evidence = undefined; }
    if (!this.evidence) this.result.errors++;
    return this.evidence;
  }
  private isProtected(name: string, file: string): boolean {
    const evidence = this.ids();
    if (!evidence) return true;
    return citesProtectedId(file, evidence.ids) || (this.opts.requestsOn && hasOpenRequest(this.opts.home, name));
  }
  private remove(file: string, before: Stats): void {
    if (this.opts.dryRun) { this.result.wouldRemove++; return; }
    if (!sameFile(before, lstatSync(file))) { this.result.kept++; return; }
    unlinkSync(file);
    this.result.removed++;
  }
  /** Any exception means keep. */
  visit(name: string): void {
    const result = this.result, file = join(this.opts.home, "journal", name);
    result.examined++;
    try {
      const stat = lstatSync(file);
      const old = stat.isFile() && stat.mtimeMs <= this.cutoff && name !== `${this.opts.currentSessionId}.jsonl`;
      if (!old) { result.kept++; return; }
      if (this.isProtected(name, file)) { result.kept++; result.protectedCount++; return; }
      this.remove(file, stat);
    } catch { result.kept++; result.errors++; }
  }
}

function candidateNames(home: string, cursor: string | undefined): string[] {
  try {
    return readdirSync(join(home, "journal")).filter(name => JOURNAL_NAME.test(name) && (!cursor || name > cursor)).sort();
  } catch { return []; }
}

/** Deletes aged per-session journal files that no live item or open request needs. Total: never throws, never creates directories. */
export function pruneJournals(opts: PruneOptions): PruneResult {
  const now = opts.now ?? Date.now, started = now(), maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES, maxMs = opts.maxMs ?? Infinity;
  const pass = new Pass(opts, started - opts.days * DAY_MS);
  const names = candidateNames(opts.home, opts.cursor);
  for (const [index, name] of names.entries()) {
    if (pass.result.examined >= maxFiles || now() - started > maxMs) {
      pass.result.capped = true;
      pass.result.cursor = names[index - 1] ?? opts.cursor ?? "";
      break;
    }
    pass.visit(name);
  }
  return pass.result;
}

export const STAMP_FILE = ".journal-prune";
export type RetentionPassOptions = Omit<PruneOptions, "dryRun" | "maxMs" | "cursor">;
function readStamp(path: string): { at: number; cursor: string } {
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    if (typeof stamp.at === "number" && typeof stamp.cursor === "string") return stamp;
  } catch { /* Missing or invalid stamps start a new pass. */ }
  return { at: -Infinity, cursor: "" };
}
/** Daily bounded automatic pass. The stamp is written first so concurrent starters skip; deletion is idempotent anyway. */
export function retentionPass(opts: RetentionPassOptions): PruneResult | undefined {
  const now = opts.now ?? Date.now, started = now(), stampPath = join(opts.home, STAMP_FILE);
  try {
    if (!existsSync(join(opts.home, "journal"))) return undefined;
    const stamp = readStamp(stampPath);
    if (started - stamp.at < DAY_MS) return undefined;
    atomicJson(stampPath, { at: started, cursor: stamp.cursor });
    const result = pruneJournals({ ...opts, maxMs: AUTO_MAX_MS, cursor: stamp.cursor });
    atomicJson(stampPath, { at: started, cursor: result.capped ? result.cursor : "" });
    return result;
  } catch { return undefined; }
}
