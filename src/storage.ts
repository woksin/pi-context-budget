import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedAutoState, isSubagent, type AutoState, type Handoff } from "./core.ts";

/** A CLI process has one primary runtime; SDK children bind while it remains alive.
 * Fork/resume tear down that primary BEFORE binding its replacement. No ancestry inference.
 */
export class SessionHosts {
  private primary?: string;
  private refs = new Map<string, number>();
  acquire(sessionId: string): { subagent: boolean; release: () => void } {
    this.primary ??= sessionId;
    const subagent = isSubagent({ sessionId, primarySessionId: this.primary });
    this.refs.set(sessionId, (this.refs.get(sessionId) ?? 0) + 1);
    let released = false;
    return { subagent, release: () => {
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
export function appendEvent(dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(data) + "\n", { mode: 0o600 });
}
export function writeHandoff(h: Handoff, auto: AutoState): void {
  mkdirSync(dirname(h.path), { recursive: true, mode: 0o700 });
  writeFileSync(h.path, h.text, { flag: "wx", mode: 0o600 });
  writeFileSync(h.path.replace(/\.md$/, ".json"), JSON.stringify({ ...h, auto: boundedAutoState(auto) }) + "\n", { flag: "wx", mode: 0o600 });
}
export interface Marker { cwd: string; launchPrompt: string | null; handoff: string; sessionFile: string | null }
export function writeMarker(path: string, marker: Marker): void {
  for (const p of [marker.cwd, marker.handoff, marker.launchPrompt, marker.sessionFile]) {
    if (p !== null && !p.startsWith("/")) throw new Error("Relaunch marker paths must be absolute");
  }
  atomicJson(path, marker);
}
export function gitState(cwd: string): Pick<AutoState, "cwd" | "root" | "branch" | "head"> {
  const git = (...args: string[]) => {
    try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return ""; }
  };
  return { cwd: resolve(cwd), root: git("rev-parse", "--show-toplevel") || resolve(cwd), branch: git("branch", "--show-current") || "unknown/detached", head: git("rev-parse", "HEAD") || "unknown" };
}
interface RunningRecord { id?: string; agentId?: string; status?: string; cwd?: string; command?: string; kind?: string; logPath?: string; description?: string; session?: { sessionId?: string } }
interface SubRegistry { hasRunning?: () => boolean; listAgents?: () => RunningRecord[]; getRecord?: (id: string) => RunningRecord | undefined }
interface JobRegistry { list: () => RunningRecord[] }
export function runningState(knownIds: string[] = []): Pick<AutoState, "jobs" | "subagents" | "unavailable"> {
  const global = globalThis as Record<symbol, unknown>;
  const unavailable: string[] = [];
  const subagents: unknown[] = [], jobs: unknown[] = [];
  const brief = (r: RunningRecord) => ({ id: r.id ?? r.agentId, status: r.status, cwd: r.cwd, command: r.command, kind: r.kind, logPath: r.logPath, description: r.description });
  try {
    const sub = global[Symbol.for("pi-subagents:manager")] as SubRegistry | undefined;
    if (!sub) unavailable.push("pi-subagents registry absent");
    else {
      const records = sub.listAgents?.() ?? knownIds.map(id => sub.getRecord?.(id)).filter((r): r is RunningRecord => !!r);
      subagents.push(...records.filter(r => r.status === "running" || r.status === "queued").map(brief));
      if (sub.hasRunning?.() && !subagents.length) subagents.push({ status: "running", detail: "Registry reports pending work; ids unavailable" });
      if (!sub.listAgents) unavailable.push("pi-subagents registry cannot enumerate; captured known ids only");
    }
  } catch { unavailable.push("pi-subagents registry unreadable"); }
  try {
    const managers = global[Symbol.for("pi-jobs.liveManagers")] as Set<JobRegistry> | undefined;
    if (!managers) unavailable.push("pi-jobs registry absent");
    else for (const manager of managers) jobs.push(...manager.list().filter(r => r.status === "running").map(brief));
  } catch { unavailable.push("pi-jobs registry unreadable"); }
  return { jobs, subagents, unavailable };
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
