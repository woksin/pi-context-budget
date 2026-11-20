/** Per-session status file and shutdown bookkeeping. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { effectiveThresholds, policyStatus, type Frame, type MachineState } from "../core.ts";
import { atomicJson } from "../storage.ts";
import { frame, modeStatus, ref, updateModeMismatch } from "./mode.ts";
import type { EventLog, Host, Runtime } from "./runtime.ts";

export type StatusState = "active" | "ended";
type Policy = ReturnType<typeof policyStatus>;

function statusIdentity(host: Host | undefined, state: StatusState = "active") {
  return { primarySessionId: host?.primarySessionId, state };
}

function sessionFields(rt: Runtime, ctx: ExtensionContext, lifecycle: StatusState | undefined) {
  const sessionId = ctx.sessionManager.getSessionId();
  return { at: new Date().toISOString(), pid: process.pid, sessionId, sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd, model: ref(ctx), role: rt.host?.subagent ? "subagent" : "main", tokens: rt.state.tokens, ...statusIdentity(rt.host, lifecycle) };
}

function policyFields(state: MachineState, f: Frame, policy: Policy) {
  return { thresholds: f.thresholds, floor: state.floor, effectiveThresholds: effectiveThresholds(state.floor, f.thresholds),
    phase: policy.phase, action: policy.action, projected: f.mode === "observe" };
}

function handoffFields(state: MachineState) {
  return { lastHandoffPath: state.lastHandoff?.path ?? null, lastHandoffTime: state.lastHandoff?.at ?? null, handoffCount: state.count };
}

function modeFields(rt: Runtime, ctx: ExtensionContext, f: Frame, policy: Policy) {
  const configuredMode = rt.config.mode;
  return { mode: f.mode, configuredMode, fallbackReason: policy.fallbackReason,
    modeMismatchReason: configuredMode !== f.mode ? modeStatus(rt, ctx).reason : null,
    wrapper: f.wrapped, relaunchMarker: f.wrapped ? process.env.PI_RELAUNCH_MARKER : null };
}

export function status(rt: Runtime, ctx: ExtensionContext, lifecycle?: StatusState): void {
  try {
    const f = frame(rt, ctx), policy = policyStatus(rt.state, f);
    updateModeMismatch(rt, ctx);
    atomicJson(join(rt.stateDir, "status", `${ctx.sessionManager.getSessionId()}.json`), {
      ...sessionFields(rt, ctx, lifecycle), ...policyFields(rt.state, f, policy), ...handoffFields(rt.state), ...modeFields(rt, ctx, f, policy),
    });
  } catch (error) { rt.log(ctx, "status_error", { error: String(error) }); }
}

export function discardUncommittedHandoff(ctx: ExtensionContext, snapshot: { state: MachineState; enforced: boolean }, log: EventLog): void {
  const held = snapshot.state.pending ?? snapshot.state.stored;
  if (!snapshot.enforced || !held) return;
  if (held.path !== snapshot.state.committedPath) log(ctx, "handoff_discarded", { path: held.path, reason: "session shutdown before commit" });
}
