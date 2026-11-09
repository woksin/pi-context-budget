import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { boundedAutoState, isSubagent, type AutoState, type Handoff, type HandoffInput, type RecordedJob } from "./core.ts";
import { matchesId, recordId } from "./validate.ts";
import { bytePrefix, repoState, collectRepositories, collectHead, finishedState, porcelainDirty, scheduledState, type RepoDeps, type JobManager } from "./collect.ts";

/** A CLI process has one primary runtime; SDK children bind while it remains alive.
 * Fork/resume tear down that primary BEFORE binding its replacement. No ancestry inference.
 */
export class SessionHosts {
  private primary?: string;
  private refs = new Map<string, number>();
  acquire(sessionId: string): { primarySessionId: string; subagent: boolean; release: () => void } {
    this.primary ??= sessionId;
    const subagent = isSubagent({ sessionId, primarySessionId: this.primary });
    this.refs.set(sessionId, (this.refs.get(sessionId) ?? 0) + 1);
    let released = false;
    return { primarySessionId: this.primary, subagent, release: () => {
      if (released) return;
      released = true;
      const count = (this.refs.get(sessionId) ?? 1) - 1;
      if (count) this.refs.set(sessionId, count);
      else { this.refs.delete(sessionId); if (this.primary === sessionId) this.primary = undefined; }
    } };
  }
}
export function processSessionHosts(): SessionHosts {
  const key = Symbol.for("pi-context-budget.session-hosts");
  const shared = globalThis as Record<symbol, unknown>;
  shared[key] ??= new SessionHosts();
  return shared[key] as SessionHosts;
}

export function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
export const EVENT_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const EVENT_LOG_KEEP = 5;
export const TURN_LOG_KEEP = 2;
interface EventLogOptions { maxBytes?: number; keep?: number; now?: () => number }
function logSize(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
function sameLock(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}
function makeLogLock(lock: string): boolean {
  try { mkdirSync(lock, { mode: 0o700 }); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
function takeLogLock(lock: string, now: () => number): Stats | undefined {
  if (!makeLogLock(lock)) {
    const stale = statSync(lock);
    if (now() - stale.mtimeMs <= 10000) return undefined;
    // Another stale-lock breaker may already have replaced it. Recheck identity
    // and mtime immediately before removal, leaving a changed lock alone.
    if (!sameLock(stale, statSync(lock))) return undefined;
    rmdirSync(lock);
    if (!makeLogLock(lock)) return undefined;
  }
  return statSync(lock);
}
function logArchive(dir: string, base: string, now: () => number): string {
  const stamp = new Date(now()).toISOString().replace(/[-:.]/g, "");
  // Rotation runs under the lock, so a same-millisecond collision gets a counter
  // above every existing one for that stamp (pruned names are never reused);
  // archiveOrder sorts these after the plain stamp.
  const prefix = `${base}-${stamp}`, taken = readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith(".jsonl"));
  if (!taken.length) return join(dir, `${prefix}.jsonl`);
  const counter = Math.max(0, ...taken.map(name => Number(/-(\d+)\.jsonl$/.exec(name.slice(prefix.length))?.[1] ?? 0)));
  let path: string, next = counter;
  do path = join(dir, `${prefix}-${String(++next).padStart(3, "0")}.jsonl`); while (existsSync(path));
  return path;
}
const archiveOrder = (a: string, b: string): number => {
  const x = a.slice(0, -".jsonl".length), y = b.slice(0, -".jsonl".length);
  return x < y ? -1 : x > y ? 1 : 0;
};
function pruneLog(dir: string, base: string, keep: number): void {
  const archives = readdirSync(dir).filter(name => name.startsWith(`${base}-`) && name.endsWith(".jsonl")).sort(archiveOrder);
  for (const name of archives.slice(0, Math.max(0, archives.length - keep))) {
    try { rmSync(join(dir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function rotateLog(dir: string, base: string, opts: Required<EventLogOptions>): void {
  const lock = join(dir, `${base}.lock`), owner = takeLogLock(lock, opts.now);
  if (!owner) return;
  try {
    const file = join(dir, `${base}.jsonl`);
    if (logSize(file) < opts.maxBytes) return;
    renameSync(file, logArchive(dir, base, opts.now));
    pruneLog(dir, base, opts.keep);
  } finally {
    if (sameLock(owner, statSync(lock))) rmdirSync(lock);
  }
}
export function appendEvent(dir: string, data: unknown, opts: EventLogOptions = {}): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = data !== null && typeof data === "object" && "event" in data && data.event === "turn" ? "turns" : "events";
  const file = join(dir, `${base}.jsonl`), maxBytes = opts.maxBytes ?? EVENT_LOG_MAX_BYTES;
  try {
    if (logSize(file) >= maxBytes) rotateLog(dir, base, { maxBytes, keep: opts.keep ?? (base === "turns" ? TURN_LOG_KEEP : EVENT_LOG_KEEP), now: opts.now ?? Date.now });
  } catch { /* Rotation is best-effort: telemetry must still append if it fails. */ }
  appendFileSync(file, JSON.stringify(data) + "\n", { mode: 0o600 });
}
interface StatusPruneOptions {
  now?: () => number;
  retentionMs?: number;
  throttleMs?: number;
  maxFiles?: number;
  maxMs?: number;
  currentSessionId?: string;
  pidAlive?: (pid: number) => boolean;
}
interface PruneStamp { at: number; cursor: string }
function pruneStamp(path: string): PruneStamp {
  try {
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    if (typeof stamp.at === "number" && typeof stamp.cursor === "string") return stamp;
  } catch { /* Missing or invalid stamps start a new pass. */ }
  return { at: -Infinity, cursor: "" };
}
function statusPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function markerPending(marker: unknown): boolean {
  if (marker === undefined || marker === null) return false;
  if (typeof marker !== "string" || !marker) return true;
  try { statSync(marker); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function statusCanPrune(record: { pid: number; sessionId?: string; relaunchMarker?: unknown }, pidAlive: (pid: number) => boolean, currentSessionId?: string): boolean {
  if (currentSessionId !== undefined && record.sessionId === currentSessionId) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  return pidAlive(record.pid) === false && !markerPending(record.relaunchMarker);
}
function pruneStatusFile(path: string, cutoff: number, pidAlive: (pid: number) => boolean, currentSessionId?: string): boolean {
  if (currentSessionId !== undefined && basename(path) === `${currentSessionId}.json`) return false;
  const before = statSync(path);
  if (!before.isFile() || before.mtimeMs >= cutoff) return false;
  if (!statusCanPrune(JSON.parse(readFileSync(path, "utf8")), pidAlive, currentSessionId)) return false;
  // Status writes are atomic renames. Leave a refreshed/replaced record alone.
  if (!sameLock(before, statSync(path))) return false;
  rmSync(path);
  return true;
}
interface PruneCounts { examined: number; removed: number; kept: number; errors: number; capped: boolean }
function scanStatus(dir: string, stamp: PruneStamp, started: number, counts: PruneCounts,
  { now = Date.now, retentionMs = 7 * 24 * 60 * 60 * 1000, maxFiles = 5000, maxMs = 200, currentSessionId, pidAlive = statusPidAlive }: StatusPruneOptions): string {
  const names = readdirSync(dir).filter(name => name.endsWith(".json") && name > stamp.cursor).sort();
  let cursor = stamp.cursor;
  for (const name of names) {
    if (counts.examined >= maxFiles || now() - started >= maxMs) { counts.capped = true; break; }
    cursor = name;
    counts.examined++;
    try {
      if (pruneStatusFile(join(dir, name), started - retentionMs, pidAlive, currentSessionId)) counts.removed++;
      else counts.kept++;
    } catch { counts.kept++; counts.errors++; /* Unreadable/corrupt/unknown means keep. */ }
  }
  return counts.capped ? cursor : "";
}
function statusPrunePass(dir: string, opts: StatusPruneOptions): void {
  const now = opts.now ?? Date.now, started = now(), statusDir = join(dir, "status");
  const stampPath = join(statusDir, ".last-prune"), throttleMs = opts.throttleMs ?? 24 * 60 * 60 * 1000;
  if (started - pruneStamp(stampPath).at < throttleMs) return;
  const lock = join(statusDir, ".prune.lock"), owner = takeLogLock(lock, now);
  if (!owner) return;
  const counts = { examined: 0, removed: 0, kept: 0, errors: 0, capped: false };
  try {
    // Recheck under the lock: another starter may have just completed a pass.
    const stamp = pruneStamp(stampPath);
    if (started - stamp.at < throttleMs) return;
    const cursor = scanStatus(statusDir, stamp, started, counts, opts);
    atomicJson(stampPath, { at: started, cursor });
  } catch { counts.errors++; }
  finally {
    try { if (sameLock(owner, statSync(lock))) rmdirSync(lock); } catch { /* Best-effort release. */ }
    try { appendEvent(dir, { at: new Date(started).toISOString(), event: "status_pruned", ...counts }); }
    catch { /* Pruning telemetry must not break a session either. */ }
  }
}
/** Best-effort, bounded cleanup of old status records with a confirmed dead PID. */
export function pruneStatus(dir: string, opts: StatusPruneOptions = {}): void {
  try { statusPrunePass(dir, opts); }
  catch { /* Missing/unwritable status directories or locks simply defer pruning. */ }
}
export function writeHandoff(h: Handoff, auto: AutoState, input?: HandoffInput): void {
  mkdirSync(dirname(h.path), { recursive: true, mode: 0o700 });
  writeFileSync(h.path, h.text, { flag: "wx", mode: 0o600 });
  const fields = input && { goal: input.goal, user_constraints: input.user_constraints, files_to_read: input.files_to_read, watch_actions: input.watch_actions };
  writeFileSync(h.path.replace(/\.md$/, ".json"), JSON.stringify({ ...h, input: fields, auto: boundedAutoState(auto) }) + "\n", { flag: "wx", mode: 0o600 });
}
export interface Marker { cwd: string; launchPrompt: string | null; handoff: string; sessionFile: string | null }
export function writeMarker(path: string, marker: Marker): void {
  for (const p of [marker.cwd, marker.handoff, marker.launchPrompt, marker.sessionFile]) {
    if (p !== null && !p.startsWith("/")) throw new Error("Relaunch marker paths must be absolute");
  }
  atomicJson(path, marker);
}
export function git(cwd: string, args: string[], timeout = 1500): string | undefined {
  try { return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8", timeout, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}
export function gitState(cwd: string): Pick<AutoState, "cwd" | "root" | "branch" | "head"> {
  return { cwd: resolve(cwd), root: git(cwd, ["rev-parse", "--show-toplevel"]) || resolve(cwd), branch: git(cwd, ["branch", "--show-current"]) || "unknown/detached", head: git(cwd, ["rev-parse", "HEAD"]) || "unknown" };
}
/** Working-tree and upstream detail for handoffs only (gitState runs on every handoff attempt). */
export function gitDetail(cwd: string): { dirty: string[]; sync: string } {
  const status = git(cwd, ["status", "--short"]);
  const lines = status ? status.split("\n").map(line => Array.from(line).slice(0, 200).join("")) : [];
  const dirty = lines.length > 30 ? [...lines.slice(0, 30), `…(${lines.length - 30} more)`] : lines;
  const counts = git(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])?.split(/\s+/);
  const sync = status === undefined ? "unknown" : counts === undefined ? (git(cwd, ["rev-parse", "--abbrev-ref", "@{u}"]) === undefined ? "no upstream" : "unknown")
    : `ahead ${counts[1]}, behind ${counts[0]} (upstream)`;
  return { dirty, sync };
}
function repoDeps(): RepoDeps {
  return { git, home: homedir(), exists: existsSync, isDirectory: path => statSync(path).isDirectory(), now: Date.now };
}
export function collectRepos(cwd: string, branch: readonly unknown[], claims: unknown[]) {
  const result = collectRepositories(cwd, branch, claims, repoDeps());
  return { ...result, dirty: porcelainDirty(result.cwdStatus) };
}
export function handoffHead(cwd: string, branch: readonly unknown[]): string {
  return collectHead(cwd, branch, repoDeps());
}
/** Launch-prompt text is stored beside the handoff so the relaunch marker always references an absolute file. */
export function writeLaunchPrompt(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
}
interface RunningRecord { id?: string; agentId?: string; status?: string; cwd?: string; command?: string; kind?: string; label?: string; until?: string; intervalSeconds?: number; timeoutSeconds?: number; logPath?: string; description?: string; session?: { sessionId?: string } }
interface SubRegistry { hasRunning?: () => boolean; listAgents?: () => RunningRecord[]; getRecord?: (id: string) => RunningRecord | undefined }
interface JobRegistry { list: () => RunningRecord[] }
export function subagentTaskDir(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[/\\]/g, "-").replace(/^[A-Za-z]:-/, "").replace(/^-+/, "");
  return join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, sessionId, "tasks");
}
export function runningState(knownIds: string[] = [], session?: { cwd: string; sessionId: string; taskDir?: string }, sinceMs?: number): Pick<AutoState, "jobs" | "subagents" | "scheduled" | "finishedJobs" | "unavailable"> {
  const global = globalThis as Record<symbol, unknown>;
  const unavailable: string[] = [];
  const subagents: unknown[] = [], jobs: unknown[] = [];
  let scheduled: string[] = [], finishedJobs: string[] = [];
  const brief = (r: RunningRecord) => ({ id: r.id ?? r.agentId, status: r.status, cwd: r.cwd, command: r.command, kind: r.kind, label: r.label, until: r.until, intervalSeconds: r.intervalSeconds, timeoutSeconds: r.timeoutSeconds, logPath: r.logPath, description: r.description });
  try {
    const sub = global[Symbol.for("pi-subagents:manager")] as SubRegistry | undefined;
    if (!sub) unavailable.push("pi-subagents registry absent", "scheduled agents: not exposed by registry");
    else {
      let enumerated = !!sub.listAgents;
      const ids = new Set(knownIds);
      if (!sub.listAgents && session && sub.getRecord) {
        try {
          for (const file of readdirSync(session.taskDir ?? subagentTaskDir(session.cwd, session.sessionId)).sort()) {
            if (file.endsWith(".output")) ids.add(file.slice(0, -7));
          }
          enumerated = true;
        } catch (error) {
          // No task directory is normal before the first spawn, but not proof
          // of an empty inventory when the manager says work is pending.
          enumerated = (error as NodeJS.ErrnoException).code === "ENOENT" && sub.hasRunning?.() === false;
        }
      }
      const records = sub.listAgents?.() ?? [...ids].map(id => sub.getRecord?.(id)).filter((r): r is RunningRecord => !!r);
      const pending = scheduledState(records);
      scheduled = pending.scheduled; unavailable.push(...pending.unavailable);
      subagents.push(...records.filter(r => r.status === "running" || r.status === "queued").map(brief));
      if (sub.hasRunning?.() && !subagents.length) {
        subagents.push({ status: "running", detail: "Registry reports pending work; ids unavailable" });
        enumerated = false;
      }
      if (!enumerated) unavailable.push("pi-subagents enumeration unavailable; captured known ids only");
    }
  } catch { unavailable.push("pi-subagents registry unreadable", "scheduled agents: not exposed by registry"); }
  try {
    const managers = global[Symbol.for("pi-jobs.liveManagers")] as Set<JobRegistry> | undefined;
    if (!managers) unavailable.push("pi-jobs registry absent");
    else for (const manager of managers) jobs.push(...manager.list().filter(r => r.status === "running").map(brief));
  } catch { unavailable.push("pi-jobs registry unreadable"); }
  const finished = finishedState(global[Symbol.for("pi-jobs.liveManagers")] as Set<JobManager> | undefined, sinceMs, Date.now());
  finishedJobs = finished.finishedJobs;
  unavailable.push(...finished.unavailable.filter(message => !unavailable.includes(message)));
  return { jobs, subagents, scheduled, finishedJobs, unavailable };
}
export function issueClaims(path: string, sessionId: string): unknown[] {
  const views = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.repo !== "string" || !Number.isInteger(e.issue)) continue;
      const key = `${e.repo.toLowerCase()}#${e.issue}`;
      // Latest state applies globally, not just to this session's old claim.
      const prior = views.get(key);
      views.set(key, { ...prior, ...e, sessionId: e.state ? e.sessionId : prior?.sessionId });
    } catch { /* Partial concurrent append. */ }
  }
  return [...views.values()].filter(e => e.sessionId === sessionId && ["in-progress", "in-review", "blocked", "paused"].includes(String(e.state)))
    .map(e => ({ repo: e.repo, issue: e.issue, state: e.state, pr: e.pr, branch: e.branch }));
}

/** Optional pi-questions integration. Read only the latest immutable revision per item. */
export function pendingQuestions(home: string, match: { sessionIds: string[] } | string): string[] {
  const identity = typeof match === "string" ? { sessionIds: [match] } : match;
  try {
    const lines: string[] = [];
    const items = join(home, "items");
    const recent = readdirSync(items, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^Q-\d+$/.test(entry.name))
      .flatMap(entry => {
        try { return [{ id: entry.name, mtime: statSync(join(items, entry.name)).mtimeMs }]; }
        catch { return []; }
      })
      .sort((a, b) => b.mtime - a.mtime || Number(b.id.slice(2)) - Number(a.id.slice(2))).slice(0, 200)
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    for (const { id } of recent) {
      if (lines.length === 20) break;
      try {
        const dir = join(home, "items", id);
        const revisions = readdirSync(dir).filter(file => /^r\d+\.json$/.test(file))
          .sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)));
        if (!revisions.length) continue;
        const item = JSON.parse(readFileSync(join(dir, revisions[0]), "utf8"));
        const sameChain = identity.sessionIds.includes(item.asker?.sessionId);
        if (item.id !== id || !sameChain || item.status !== "open" || typeof item.title !== "string") continue;
        lines.push(Array.from(`${id} | ${item.status} | ${item.title.replace(/[\r\n]/g, " ")}`).slice(0, 200).join(""));
      } catch { /* An unreadable/latest corrupt item must not resurrect an older revision. */ }
    }
    return lines;
  } catch { return []; }
}
/** Missing/unreadable registries are not evidence that recorded work stopped. */
function repoWatchCheck(repos: Handoff["repos"]): string | undefined {
  if (!repos?.length) return undefined;
  const deadline = Date.now() + 2000;
  return `## Re-verify per repository\n${repos.slice(0, 8).map(repo => {
    const current = repoState(repo.root, (root, ...args) => {
      const remaining = deadline - Date.now();
      return remaining > 0 ? git(root, args, Math.min(800, remaining)) : undefined;
    });
    const now = current.head === "unknown" ? "not inspected" : `${current.branch}@${current.head.slice(0, 7)} | dirty ${current.dirty}`;
    return `${repo.root} | recorded ${repo.branch}@${repo.head.slice(0, 7)} | current ${now}; re-verify CI/review/issue facts.`;
  }).join("\n")}`;
}
export function watchCheck(recorded: Pick<Handoff, "recordedJobs" | "recordedSubagents" | "watchActions" | "repos"> | RecordedJob[] = []): string | undefined {
  const handoff = Array.isArray(recorded) ? { recordedJobs: recorded } : recorded;
  const ids = [...handoff.recordedJobs ?? [], ...handoff.recordedSubagents ?? []].map(r => r.id);
  const live = runningState([...ids, ...handoff.watchActions?.map(w => w.id) ?? []]), missing: string[] = [];
  const field = (text: string) => text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const describe = (id: string, target?: string, action?: string) => {
    const watch = handoff.watchActions?.find(w => matchesId(w.id, id, ids));
    return [id, watch?.target ?? target ?? "target unknown", watch?.on_complete ?? action ?? "follow-up unknown"].map(field).join(" | ");
  };
  if (!live.unavailable.some(message => message.startsWith("pi-jobs"))) {
    const running = new Set(live.jobs.map(recordId));
    for (const job of handoff.recordedJobs ?? []) if (!running.has(job.id)) {
      const details = [job.id, job.label, job.command].map(field).join(" | ");
      const watch = handoff.watchActions?.some(w => matchesId(w.id, job.id, ids));
      missing.push(details + (watch ? `; ${describe(job.id, job.label, job.command)}` : ""));
    }
  }
  if (!live.unavailable.some(message => message.startsWith("pi-subagents"))) {
    const running = new Set(live.subagents.map(recordId));
    const agents = [...handoff.recordedSubagents ?? []];
    for (const watch of handoff.watchActions ?? []) {
      if (![...agents, ...handoff.recordedJobs ?? []].some(r => matchesId(watch.id, r.id, ids))) agents.push({ id: watch.id });
    }
    for (const agent of agents) if (![...running].some(id => id && matchesId(agent.id, id, [...running].filter((id): id is string => !!id)))) {
      missing.push(`Not running (finished, failed or lost): ${describe(agent.id, agent.description)} — check its result and perform the on_complete action`);
    }
  }
  return bytePrefix([missing.length ? `## Watch check\nNo longer running; re-arm as needed:\n${missing.join("\n")}` : undefined,
    repoWatchCheck(handoff.repos)].filter(Boolean).join("\n\n"), 4096) || undefined;
}
