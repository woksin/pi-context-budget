/** Bounded handoff collectors. All filesystem, clock and process observations are injected. */
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HandoffInput, RepoState } from "./core.ts";

export type Git = (cwd: string, ...args: string[]) => string | undefined;
export interface PathDeps { home: string; exists: (path: string) => boolean; isDirectory: (path: string) => boolean }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function safeGit(git: Git, cwd: string, ...args: string[]): string | undefined {
  try { return git(cwd, ...args); } catch { return undefined; }
}
/** UTF-8-safe prefix, without a replacement character at a byte boundary. */
export function bytePrefix(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  let bytes = 0, result = "";
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > budget) break;
    result += char;
  }
  return result;
}
function textContent(entry: unknown): string {
  const content = record(record(entry).message).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap(part => record(part).type === "text" && typeof record(part).text === "string" ? [record(part).text as string] : []).join("\n") : "";
}
function toolCalls(entry: unknown): Record<string, unknown>[] {
  const message = record(record(entry).message);
  return message.role === "assistant" && Array.isArray(message.content) ? message.content.filter(part => record(part).type === "toolCall") : [];
}
function shellPaths(command: string): string[] {
  const token = `(?:"([^"]+)"|'([^']+)'|([^\\s;&|<>]+))`;
  const patterns = [new RegExp(`(?:^|[\\s;&|])cd\\s+(?:--\\s+)?${token}`, "g"), new RegExp(`\\bgit\\s+-C\\s+${token}`, "g"),
    new RegExp(`--work-tree(?:=|\\s+)${token}`, "g"), new RegExp(`\\bgit\\s+worktree\\s+add\\s+(?:(?:-[bB]\\s+(?:"[^"]+"|'[^']+'|[^\\s;&|<>]+)|--?[\\w-]+)\\s+)*${token}`, "g")];
  return patterns.flatMap(pattern => [...command.matchAll(pattern)].map(match => match[1] ?? match[2] ?? match[3]));
}
export function touchedPaths(branch: readonly unknown[], cwd: string, deps: PathDeps): string[] {
  const paths = new Set<string>();
  const add = (path: string) => {
    if (paths.size >= 64 || path.includes("\0")) return;
    const expanded = path === "~" ? deps.home : path.startsWith("~/") ? join(deps.home, path.slice(2)) : path;
    const absolute = resolve(cwd, expanded);
    try { if (isAbsolute(absolute) && deps.exists(absolute)) paths.add(absolute); } catch { /* Optional observation. */ }
  };
  add(cwd);
  for (let i = branch.length - 1; i >= 0 && paths.size < 64; i--) {
    for (const call of toolCalls(branch[i])) {
      const args = record(call.arguments);
      for (const key of ["path", "file_path", "cwd", "workdir"]) if (typeof args[key] === "string") add(args[key]);
      if (call.name === "bash" && typeof args.command === "string") for (const path of shellPaths(args.command)) add(path);
    }
  }
  return [...paths];
}
export function repoRoots(paths: string[], git: Git, cap = 8, deps?: Pick<PathDeps, "isDirectory">): string[] {
  const roots = new Set<string>();
  for (let path of paths) {
    if (roots.size >= cap) break;
    if (deps) {
      try { while (!deps.isDirectory(path) && dirname(path) !== path) path = dirname(path); } catch { continue; }
    }
    const root = safeGit(git, path, "rev-parse", "--show-toplevel");
    if (root && isAbsolute(root)) roots.add(root);
  }
  return [...roots];
}
export function repoState(root: string, git: Git): RepoState {
  const status = safeGit(git, root, "status", "--porcelain=v2", "--branch");
  const lines = status?.split("\n") ?? [];
  const field = (key: string) => lines.find(line => line.startsWith(`# branch.${key} `))?.slice(key.length + 10);
  const oid = field("oid"), counts = field("ab")?.match(/^\+(\d+) -(\d+)$/);
  return { root, branch: field("head") || "unknown", head: oid && oid !== "(initial)" ? oid : "unknown",
    dirty: lines.filter(line => line && !line.startsWith("#")).length,
    sync: status === undefined ? "unknown" : counts ? `ahead ${counts[1]}, behind ${counts[2]} (upstream)` : field("upstream") ? "unknown" : "no upstream" };
}
export function claimRepos(claims: unknown[], roots: string[], git: Git, cap = 8): { roots: string[]; claims: unknown[] } {
  const worktrees = new Map<string, string>();
  if (claims.some(claim => typeof record(claim).branch === "string")) {
    for (const root of roots) {
      let path: string | undefined;
      for (const line of safeGit(git, root, "worktree", "list", "--porcelain")?.split("\n") ?? []) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        if (line.startsWith("branch refs/heads/") && path && isAbsolute(path)) worktrees.set(line.slice(18), path);
      }
    }
  }
  const all = new Set(roots);
  const mapped = claims.map(claim => {
    const r = record(claim);
    if (typeof r.branch !== "string") return claim;
    const path = worktrees.get(r.branch);
    if (path && all.size < cap) all.add(path);
    return { ...r, worktree: path ?? `branch ${r.branch} (no local worktree found)` };
  });
  return { roots: [...all].slice(0, cap), claims: mapped };
}
export interface RepoDeps extends PathDeps { now: () => number; git: (cwd: string, args: string[], timeoutMs: number) => string | undefined }
function deadlineGit(deps: RepoDeps, deadline: number): Git {
  return (root, ...args) => {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return;
    try { return deps.git(root, args, Math.max(1, Math.min(800, remaining))); } catch { return undefined; }
  };
}
export function collectRepositories(cwd: string, branch: readonly unknown[], claims: unknown[], deps: RepoDeps, budgetMs = 3000): { repos: RepoState[]; claims: unknown[]; cwdRoot?: string; cwdStatus?: string } {
  const deadline = deps.now() + budgetMs, observedGit = deadlineGit(deps, deadline);
  let cwdStatus: string | undefined;
  const cwdRoot = observedGit(cwd, "rev-parse", "--show-toplevel");
  const git: Git = (root, ...args) => {
    const output = observedGit(root, ...args);
    if (root === cwdRoot && args[0] === "status") cwdStatus = output;
    return output;
  };
  const paths = touchedPaths(branch, cwd, deps).filter(path => path !== resolve(cwd));
  const roots = [...new Set([...(cwdRoot ? [cwdRoot] : []), ...repoRoots(paths, git, 8, deps)])].slice(0, 8);
  const claimed = claimRepos(claims, roots, git);
  const repos = claimed.roots.map(root => deps.now() >= deadline
    ? { root, branch: "unknown", head: "unknown", dirty: 0, sync: "not inspected (time budget)" } : repoState(root, git));
  return { repos, claims: claimed.claims, cwdRoot, cwdStatus };
}
/** Backoff only needs one discovered repository's HEAD, not its full status inventory. */
export function collectHead(cwd: string, branch: readonly unknown[], deps: RepoDeps): string {
  const git = deadlineGit(deps, deps.now() + 1000);
  const root = repoRoots(touchedPaths(branch, cwd, deps), git, 1, deps)[0];
  return root ? safeGit(git, root, "rev-parse", "HEAD") || "unknown" : "unknown";
}
/** Preserve the compatibility working-tree lines without another git process. */
export function porcelainDirty(status: string | undefined): string[] {
  if (status === undefined) return ["unknown"];
  const lines = (status?.split("\n") ?? []).filter(line => line && !line.startsWith("#")).map(line => {
    if (line.startsWith("? ")) return `?? ${line.slice(2)}`;
    const offset = line.startsWith("2 ") ? 9 : line.startsWith("u ") ? 10 : 8;
    return `${line.slice(2, 4).replace(/\./g, " ")} ${line.split(" ").slice(offset).join(" ")}`;
  }).map(line => Array.from(line).slice(0, 200).join(""));
  return lines.length > 30 ? [...lines.slice(0, 30), `…(${lines.length - 30} more)`] : lines;
}
export function primaryHead(repos: RepoState[]): string { return repos[0]?.head ?? "unknown"; }

export function handoffPaths(branch: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const entry of branch) {
    const e = record(entry), details = record(e.details);
    if (e.type === "compaction" && typeof details.path === "string") paths.push(details.path);
    if (record(e.message).role === "user") for (const match of textContent(entry).matchAll(/^Handoff file:\s*(\/[^\r\n]+\.md)\s*$/gm)) paths.push(match[1]);
  }
  return paths;
}
export function chainIdentity(branch: readonly unknown[], sessionId: string, lastPath?: string): { sessionIds: string[] } {
  const ids = new Set([sessionId]);
  for (const path of [...handoffPaths(branch), ...(lastPath ? [lastPath] : [])]) {
    const id = path.match(/\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})-\d+\.md$/i)?.[1];
    if (id) ids.add(id);
  }
  return { sessionIds: [...ids] };
}
function middleCut(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  const chars = Array.from(text), allowance = Math.max(0, budget - 64);
  const start = bytePrefix(text, Math.floor(allowance * 0.75));
  const end = Array.from(bytePrefix([...chars].reverse().join(""), Math.floor(allowance * 0.25))).reverse().join("");
  return `${start}…(cut ${chars.length - Array.from(start).length - Array.from(end).length} chars)${end}`;
}
export function userMessagesSince(branch: readonly unknown[], previousAt?: string, budget = 4096): string {
  let boundary = -1;
  for (let i = 0; i < branch.length; i++) if (record(branch[i]).type === "compaction" || toolCalls(branch[i]).some(call => call.name === "context_handoff")) boundary = i;
  const since = previousAt === undefined ? NaN : Date.parse(previousAt);
  const messages = branch.flatMap((entry, index) => {
    const e = record(entry), at = Date.parse(String(e.timestamp ?? ""));
    if (record(e.message).role !== "user" || (Number.isFinite(since) && Number.isFinite(at) ? at <= since : index <= boundary)) return [];
    const text = textContent(entry);
    return text ? [text] : [];
  });
  const kept: string[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(messages[i]) + (kept.length ? 2 : 0);
    if (bytes + size > budget - 64) {
      if (!kept.length) kept.unshift(middleCut(messages[i], Math.max(0, budget - 64)));
      break;
    }
    kept.unshift(messages[i]); bytes += size;
  }
  const omitted = messages.length - kept.length;
  return bytePrefix(kept.join("\n\n") + (omitted ? `\n\nomitted: ${omitted} older messages` : ""), budget);
}
export interface PreviousHandoff { goal: string; constraints?: string; filesToRead: string[]; path: string }
export function parseHandoffSections(text: string): Omit<PreviousHandoff, "path"> {
  const section = (name: string) => {
    const heading = `## ${name}\n`, start = text.indexOf(heading);
    if (start < 0) return "";
    const from = start + heading.length, end = text.indexOf("\n\n## ", from);
    return text.slice(from, end < 0 ? undefined : end);
  };
  return { goal: section("Goal"), constraints: section("User constraints (verbatim)") || undefined,
    filesToRead: section("Read first").split("\n").filter(path => isAbsolute(path)) };
}
export function previousHandoff(branch: readonly unknown[], last: { path: string } | undefined, readFile: (path: string) => string): PreviousHandoff | undefined {
  const path = last?.path ?? handoffPaths(branch).at(-1);
  if (!path || !isAbsolute(path)) return;
  let sections: Omit<PreviousHandoff, "path"> | undefined;
  try {
    const json = JSON.parse(readFile(path.replace(/\.md$/, ".json")));
    if (typeof json.text === "string") sections = parseHandoffSections(json.text);
  } catch { /* Markdown is also sufficient. */ }
  if (!sections?.goal) try { sections = parseHandoffSections(readFile(path)); } catch { return; }
  if (sections?.goal) return { ...sections, path };
}
export function emergencyHandoff(branch: readonly unknown[], sessionFile?: string, previous?: PreviousHandoff, previousAt?: string): HandoffInput {
  const requests = userMessagesSince(branch, previousAt);
  return { goal: previous ? `Emergency handoff; previous goal: ${bytePrefix(previous.goal, 4096)}` : `Emergency handoff. Recent user requests:\n${requests || "Recover the original request from the session file."}`,
    facts: `No fresh structured handoff. Recheck previous tests/review/CI/issue claims. Session file: ${(sessionFile ?? "unavailable").slice(0, 400)}` +
      (previous ? `\nPrevious handoff: ${previous.path}` : "") + (requests ? `\nRecent user requests (verbatim):\n${requests}` : ""),
    user_constraints: previous?.constraints,
    files_to_read: previous?.filesToRead,
    next_step: "Re-establish state from files and git, re-read user constraints in the session file, then continue. Do not assume any prior check passed." };
}
/** Mechanical backstops have no auto-state dependency, but must retain emergency constraints/files. */
export function emergencySummary(input: HandoffInput): string {
  return ["# Emergency handoff", input.goal, input.facts,
    input.user_constraints && `\n## User constraints (verbatim)\n${input.user_constraints}`,
    input.files_to_read?.length && `\n## Read first\n${input.files_to_read.join("\n")}`,
    input.next_step].filter(Boolean).join("\n");
}
export interface InventoryRecord { id?: string; agentId?: string; status?: string; label?: string; description?: string; exitCode?: number | null; logPath?: string; finishedAt?: number | string; endedAt?: number | string }
export interface JobManager { list: () => InventoryRecord[] }
const inventoryField = (value: unknown) => value === undefined || value === null ? "-" : String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
export function finishedState(managers: Iterable<JobManager> | undefined, sinceMs: number | undefined, now: number): { finishedJobs: string[]; unavailable: string[] } {
  const unavailable: string[] = [], finished: { r: InventoryRecord; at: number }[] = [];
  if (!managers) return { finishedJobs: [], unavailable: ["pi-jobs registry absent"] };
  const terminal = new Set(["completed", "failed", "finished", "succeeded", "timed_out", "killed", "matched"]);
  const since = sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : now - 2 * 60 * 60_000;
  try {
    for (const manager of managers) for (const r of manager.list()) {
      if (!terminal.has(r.status ?? "")) continue;
      const time = r.finishedAt ?? r.endedAt, at = typeof time === "number" ? time : Date.parse(time ?? "");
      if (!Number.isFinite(at)) { if (!unavailable.length) unavailable.push("finished jobs: end timestamps unavailable; showing terminal records without a time filter"); }
      else if (at < since || at > now) continue;
      finished.push({ r, at: Number.isFinite(at) ? at : 0 });
    }
  } catch { unavailable.push("pi-jobs registry unreadable"); }
  return { finishedJobs: finished.sort((a, b) => b.at - a.at).slice(0, 10).map(({ r }) => Array.from([r.id, r.label, r.status, r.exitCode, r.logPath].map(inventoryField).join(" | ")).slice(0, 200).join("")), unavailable };
}
export function scheduledState(records: InventoryRecord[]): { scheduled: string[]; unavailable: string[] } {
  const scheduled = records.filter(r => r.status === "scheduled").slice(0, 10).map(r => Array.from([r.id ?? r.agentId, r.status, r.description].map(inventoryField).join(" | ")).slice(0, 200).join(""));
  return { scheduled, unavailable: scheduled.length ? [] : ["scheduled agents: not exposed by registry"] };
}
