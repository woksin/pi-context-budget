/** Translate pi events into machine events; one registration per pi event, in the adapter's fixed order. */
import type { ExtensionContext, SessionBeforeCompactEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { graceEligible } from "../grace.ts";
import { pruneStatus } from "../storage.ts";
import { bindRequests } from "../memory/requests-hook.ts";
import { requestContext } from "./boundary.ts";
import { execute, run } from "./effects.ts";
import { registerHandoffTool } from "./handoff-tool.ts";
import { frame, mode, ref, step } from "./mode.ts";
import { pendingWork } from "./observe.ts";
import { reset } from "./session.ts";
import { discardUncommittedHandoff, status } from "./status.ts";
import { guarded, reload, type Runtime } from "./runtime.ts";

/** Reading ids is metadata collection, not policy; never walk arbitrary/cyclic result trees. */
const walkable = (value: unknown, depth: number): value is object => !!value && typeof value === "object" && depth <= 5;
function collectAgentIds(knownIds: Set<string>, value: unknown, depth = 0): void {
  if (!walkable(value, depth)) return;
  const v = value as Record<string, unknown>;
  if (typeof v.agentId === "string") knownIds.add(v.agentId);
  for (const child of Object.values(v)) if (typeof child === "object") collectAgentIds(knownIds, child, depth + 1);
}

async function toolExecutionEnd(rt: Runtime, e: ToolExecutionEndEvent, ctx: ExtensionContext) {
  if (e.toolName === "Agent" || e.toolName === "SubagentWorkflow") collectAgentIds(rt.knownIds, e.result?.details);
  await run(rt, { type: "tool_end", tool: e.toolName, id: e.toolCallId, error: e.isError }, ctx);
}

async function beforeCompact(rt: Runtime, e: SessionBeforeCompactEvent, ctx: ExtensionContext) {
  try { return await run(rt, { type: "session_before_compact", reason: e.reason, tokensBefore: e.preparation?.tokensBefore }, ctx); }
  catch (error) {
    rt.log(ctx, "backstop_error", { error: String(error) });
    try {
      // Missing measurements are an observation, not an adapter-level policy exception.
      return await execute(rt, step(rt, { type: "backstop_failed", reason: e.reason, errorMessage: String(error) }, ctx, frame(rt, ctx, null)), ctx);
    } catch { return undefined; } // A torn-down runtime cannot execute any policy output.
  }
}

function shutdown(rt: Runtime, ctx: ExtensionContext): void {
  discardUncommittedHandoff(ctx, { state: rt.state, enforced: mode(rt, ctx) === "enforce" }, rt.log);
  rt.overflow.shutdown(); status(rt, ctx, "ended"); rt.host?.release(); rt.host = undefined; rt.log(ctx, "session_shutdown");
}

function wireSession(rt: Runtime, safe: ReturnType<typeof guarded>): void {
  rt.pi.on("session_start", safe((_e, ctx) => {
    reset(rt, ctx); void rt.journal.retention(ctx); pruneStatus(rt.stateDir, { currentSessionId: ctx.sessionManager.getSessionId() });
    rt.log(ctx, "session_start", { mode: frame(rt, ctx).mode, model: ref(ctx) });
  }));
  rt.pi.on("session_tree", safe((_e, ctx) => reset(rt, ctx)));
  bindRequests(rt.pi, rt.requests, { safe, run: (event, ctx) => run(rt, event, ctx), overflow: rt.overflow, pendingWork: ctx => pendingWork(rt, ctx),
    status: ctx => status(rt, ctx), compactionOwned: () => !!rt.state.compaction, context: (event, ctx) => requestContext(rt, event, ctx) });
}

function wireTurns(rt: Runtime, safe: ReturnType<typeof guarded>): void {
  const { pi, overflow, journal, requests } = rt;
  pi.on("tool_call", safe((e, ctx) => run(rt, { type: "tool_call", tool: e.toolName, id: e.toolCallId, graceEligible: graceEligible(e.toolName, e.input, ctx.cwd) }, ctx)));
  pi.on("tool_execution_end", safe((e, ctx) => toolExecutionEnd(rt, e, ctx)));
  pi.on("turn_end", safe(async (e, ctx) => {
    const result = await overflow.turn(e, ctx);
    rt.log(ctx, "turn", { tokens: rt.state.tokens, floor: rt.state.floor, phase: rt.state.phase }); status(rt, ctx); return result;
  }));
  pi.on("agent_before_settle", safe((_e, ctx) => run(rt, { type: "agent_before_settle", pendingWork: pendingWork(rt, ctx) }, ctx)));
  pi.on("input", safe(async (e, ctx) => {
    reload(rt, ctx); await journal.onInput(e, ctx); overflow.input(e.source);
    await run(rt, { type: "input", now: Date.now(), streaming: !!e.streamingBehavior, alreadyCompacted: ctx.sessionManager.getBranch().at(-1)?.type === "compaction", human: requests.takeHumanTurn() }, ctx);
    return { action: "continue" as const };
  }));
  pi.on("session_before_compact", (e, ctx) => overflow.beforeCompact(e, ctx, () => beforeCompact(rt, e, ctx)));
  pi.on("session_shutdown", safe((_e, ctx) => shutdown(rt, ctx)));
}

export function wireEvents(rt: Runtime): void {
  const safe = guarded(rt.log);
  wireSession(rt, safe);
  registerHandoffTool(rt);
  wireTurns(rt, safe);
}
