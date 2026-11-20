import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { atomicJson, git } from "../storage.ts";
import { requireValid, safeName } from "./validate.ts";
import type { MemoryStoreCore } from "./store.ts";
import type { ItemQuery, Scope } from "./types.ts";

type LaneContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
type Sidecar = { path: string; id: string; data: Record<string, unknown> };
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function wrapperPath(branch: readonly unknown[]): string | undefined {
  const first = branch.map(entry => record(record(entry).message)).find(message => message.role === "user");
  const content = first?.content;
  const text = Array.isArray(content) ? content.map(part => record(part).text ?? "").join("\n") : String(content ?? "");
  return [...text.matchAll(/^continue from[ \t]+(\/[^\r\n]+\.md)[ \t]*$/gm)].at(-1)?.[1];
}
function trustedPaths(ctx: LaneContext): string[] {
  const branch = ctx.sessionManager.getBranch?.() ?? [];
  const launch = wrapperPath(branch);
  const paths = branch.map(record).filter(entry => entry.type === "compaction").map(entry => record(entry.details).path)
    .filter((path): path is string => typeof path === "string");
  return launch ? [launch, ...paths] : paths;
}
/** Both files and the server-selected directory must resolve without escaping .ai-work/handoffs. */
function sidecar(ctx: LaneContext, path: string): Sidecar {
  const root = realpathSync(git(ctx.cwd, ["rev-parse", "--show-toplevel"]) ?? resolve(ctx.cwd));
  const directory = join(root, ".ai-work", "handoffs");
  requireValid(realpathSync(directory) === directory, "invalid_lane_handoff");
  requireValid(isAbsolute(path) && path.endsWith(".md"), "invalid_lane_handoff");
  requireValid(dirname(realpathSync(path)) === directory, "invalid_lane_handoff");
  const json = realpathSync(path.replace(/\.md$/u, ".json"));
  requireValid(dirname(json) === directory, "invalid_lane_handoff");
  const id = basename(path).match(/^(.+)-\d+\.md$/u)?.[1];
  requireValid(id && safeName(id), "invalid_lane_handoff");
  const parsed: unknown = JSON.parse(readFileSync(json, "utf8"));
  requireValid(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "invalid_lane_handoff");
  return { path: json, id, data: record(parsed) };
}
function inherited(ctx: LaneContext, path?: string): Sidecar | undefined {
  if (!path) return undefined;
  try { return sidecar(ctx, path); } catch { return undefined; }
}
function storedRoot(entry?: Sidecar): string | undefined {
  const root = entry?.data.laneRoot;
  return typeof root === "string" && safeName(root) ? root : undefined;
}
export function laneIdentity(ctx: LaneContext, lastPath?: string): { root: string; sessionIds: string[] } {
  const own = ctx.sessionManager.getSessionId();
  const paths = trustedPaths(ctx).map(path => inherited(ctx, path));
  const last = inherited(ctx, lastPath);
  const resumed = last?.data.laneRoot ? last : paths.at(-1);
  const ancestors = [...paths, last].filter((entry): entry is Sidecar => entry !== undefined);
  return { root: storedRoot(resumed) ?? own,
    sessionIds: [...new Set([own, ...ancestors.map(entry => entry.id)])] };
}
/** The caller catches/logs failures: lineage metadata must never block a handoff. */
export function persistLaneRoot(ctx: LaneContext, path: string): void {
  const target = sidecar(ctx, path);
  atomicJson(target.path, { ...target.data, laneRoot: laneIdentity(ctx).root });
}
export function laneKey(ctx: LaneContext, env = process.env): string {
  return env.PI_ORCH_ID ? `orch:${env.PI_ORCH_ID}` : `chain:${laneIdentity(ctx).root}`;
}
export function laneScopes(ctx: LaneContext, env = process.env, lastPath?: string): Scope[] {
  if (env.PI_ORCH_ID) return [{ kind: "lane", key: laneKey(ctx, env) }];
  const identity = laneIdentity(ctx, lastPath);
  return [...new Set([identity.root, ...identity.sessionIds])].map(id => ({ kind: "lane", key: `chain:${id}` }));
}
export function resolveLaneScope(ctx: LaneContext, scope: Scope): Scope {
  return scope.kind === "lane" ? { kind: "lane", key: laneKey(ctx) } : scope;
}
function visibility(ctx: LaneContext): (scope: Scope) => boolean {
  const keys = new Set(laneScopes(ctx).map(scope => scope.key));
  return scope => scope.kind !== "lane" || keys.has(scope.key);
}
export function laneVisible(ctx: LaneContext, scope: Scope): boolean {
  return scope.kind !== "lane" || visibility(ctx)(scope);
}
export function requireVisibleItems(ctx: LaneContext, store: MemoryStoreCore, ids: readonly string[]): void {
  if (!ids.length) return;
  const items = store.readFolded().items, visible = visibility(ctx);
  for (const id of ids) if (items[id]) requireValid(visible(items[id].scope), "no_source");
}
/** Keep store cursors opaque and scan until a visible page is full or the store is exhausted. */
export function listVisibleItems(ctx: LaneContext, store: MemoryStoreCore, query: ItemQuery) {
  requireValid(Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 1000, "invalid_limit");
  const visible = visibility(ctx);
  let page = store.list({ ...query, limit: 1 });
  const items = page.items.filter(item => visible(item.scope));
  while (page.cursor !== undefined && items.length < query.limit) {
    page = store.list({ ...query, limit: 1, cursor: page.cursor });
    items.push(...page.items.filter(item => visible(item.scope)));
  }
  return { items, ...(page.cursor !== undefined ? { cursor: page.cursor } : {}) };
}
