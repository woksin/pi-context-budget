import { lstatSync, readdirSync, readFileSync, unlinkSync, existsSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../storage.ts";
import { JOURNAL_LINE_BYTES, scanLog } from "./log.ts";
import { readSessionState } from "./requests.ts";
import type { FoldedState } from "./types.ts";

/** Same shape the store accepts as a per-session journal file; nothing else in the directory is ever a candidate. */
export const JOURNAL_NAME = /^[A-Za-z0-9_-]{1,200}\.jsonl$/;
export const DAY_MS = 86_400_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const AUTO_MAX_MS = 200;
const DEFAULT_MAX_FILES = 5000;

const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export type PruneOptions = {
  home: string; state: (hidden: ReadonlySet<string>) => FoldedState; requestsOn: boolean; days: number; now?: () => number;
  currentSessionId?: string; dryRun?: boolean; maxFiles?: number; maxMs?: number; cursor?: string;
};
export type PruneResult = { examined: number; removed: number; wouldRemove: number; kept: number; protectedCount: number;
  errors: number; capped: boolean; cursor: string; mismatch: boolean };
type Candidate = { name: string; file: string; stat: Stats };

/** Every string anywhere in the events log: an event that cites a message id (any kind, any state) pins that message's file. */
function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, into);
  else if (typeof value === "object" && value !== null) for (const entry of Object.values(value)) collectStrings(entry, into);
}
/** Cited strings, or undefined when the events log is not wholly readable (cannot prove anything: keep everything). */
function citedStrings(home: string): Set<string> | undefined {
  const scan = scanLog(join(home, "events.jsonl"));
  if (scan.tornTail > 0 || scan.corrupt > 0) return undefined;
  const cited = new Set<string>();
  for (const located of scan.records) collectStrings(located.record, cited);
  return cited;
}
/** Fail safe: unreadable, oversized or malformed files count as cited. */
function citedByEvents(file: string, cited: Set<string>): boolean {
  try {
    if (statSync(file).size > MAX_READ_BYTES) return true;
    return scanLog(file, JOURNAL_LINE_BYTES).records.some(({ record: entry }) => {
      const id = text(record(entry).id);
      return id === undefined || cited.has(id);
    });
  } catch { return true; }
}
function hasOpenRequest(home: string, name: string): boolean {
  try { return readSessionState(home, name.slice(0, -".jsonl".length)).open.length > 0; }
  catch { return true; }
}
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size && b.isFile();

class Pass {
  readonly result: PruneResult = { examined: 0, removed: 0, wouldRemove: 0, kept: 0, protectedCount: 0, errors: 0, capped: false, cursor: "", mismatch: false };
  readonly candidates: Candidate[] = [];
  private readonly opts: PruneOptions;
  private readonly cutoff: number;
  constructor(opts: PruneOptions, cutoff: number) { this.opts = opts; this.cutoff = cutoff; }
  private cited: Set<string> | undefined | null = null;
  private isCited(cited: Set<string> | undefined, name: string, file: string): boolean {
    if (!cited) return true;
    return citedByEvents(file, cited) || (this.opts.requestsOn && hasOpenRequest(this.opts.home, name));
  }
  private evidence(): Set<string> | undefined {
    if (this.cited === null) this.cited = citedStrings(this.opts.home);
    return this.cited;
  }
  /** Rule A: expired, not current, cited by no event. Evidence is read once per file visit, after the stat. */
  visit(name: string): void {
    const result = this.result, file = join(this.opts.home, "journal", name);
    result.examined++;
    try {
      const stat = lstatSync(file);
      const old = stat.isFile() && stat.mtimeMs <= this.cutoff && name !== `${this.opts.currentSessionId}.jsonl`;
      if (!old) { result.kept++; return; }
      if (this.isCited(this.evidence(), name, file)) { result.kept++; result.protectedCount++; return; }
      this.candidates.push({ name, file, stat });
    } catch { result.kept++; result.errors++; }
  }
  private keepAll(mismatch: boolean): void {
    this.result.kept += this.candidates.length;
    this.result.errors++;
    this.result.mismatch = mismatch;
  }
  /** Rule B: the projection must be identical with and without the candidates (in memory only). */
  private verified(): boolean {
    try {
      const full = JSON.stringify(this.opts.state(new Set())), hidden = JSON.stringify(this.opts.state(new Set(this.candidates.map(c => c.name))));
      if (full === hidden) return true;
      this.keepAll(true);
    } catch { this.keepAll(false); }
    return false;
  }
  private remove(candidate: Candidate): void {
    try {
      if (!sameFile(candidate.stat, lstatSync(candidate.file))) { this.result.kept++; return; }
      if (this.opts.dryRun) { this.result.wouldRemove++; return; }
      unlinkSync(candidate.file);
      this.result.removed++;
    } catch { this.result.kept++; this.result.errors++; }
  }
  /** Events appended since the scan may cite a candidate: re-read the evidence and drop what is now cited. */
  private recheck(): void {
    const cited = citedStrings(this.opts.home), all = this.candidates.splice(0);
    for (const candidate of all) {
      if (this.isCited(cited, candidate.name, candidate.file)) { this.result.kept++; this.result.protectedCount++; }
      else this.candidates.push(candidate);
    }
  }
  finish(): void {
    if (!this.candidates.length) return;
    this.recheck();
    if (!this.candidates.length || !this.verified()) return;
    for (const candidate of this.candidates) this.remove(candidate);
  }
}

function candidateNames(home: string, cursor: string | undefined): string[] {
  try {
    return readdirSync(join(home, "journal")).filter(name => JOURNAL_NAME.test(name) && (!cursor || name > cursor)).sort();
  } catch { return []; }
}

/** Deletes aged per-session journal files that no event cites and whose absence provably changes nothing. Total: never throws, never creates directories. */
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
  pass.finish();
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
