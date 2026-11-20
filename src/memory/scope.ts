import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chainIdentity } from "../collect.ts";
import type { Scope } from "./types.ts";

type LaneContext = Pick<ExtensionContext, "sessionManager">;
function chain(ctx: LaneContext, lastPath?: string): string[] {
  return chainIdentity(ctx.sessionManager.getBranch?.() ?? [], ctx.sessionManager.getSessionId(), lastPath).sessionIds;
}
/** getBranch is root-first; chainIdentity inserts current first, then ancestors in that order. */
export function laneKey(ctx: LaneContext, env = process.env): string {
  if (env.PI_ORCH_ID !== undefined) return `orch:${env.PI_ORCH_ID}`;
  const ids = chain(ctx);
  return `chain:${ids[1] ?? ids[0]}`;
}
/** Retain visibility for keys written by any member, without sharing session names. */
export function laneScopes(ctx: LaneContext, env = process.env, lastPath?: string): Scope[] {
  if (env.PI_ORCH_ID !== undefined) return [{ kind: "lane", key: laneKey(ctx, env) }];
  return chain(ctx, lastPath).map(id => ({ kind: "lane", key: `chain:${id}` }));
}
export function resolveLaneScope(ctx: LaneContext, scope: Scope): Scope {
  return scope.kind === "lane" ? { kind: "lane", key: laneKey(ctx) } : scope;
}
export function laneVisible(ctx: LaneContext, scope: Scope): boolean {
  return scope.kind !== "lane" || laneScopes(ctx).some(selected => selected.key === scope.key);
}
