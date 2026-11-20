/** Effective mode, observation frames and machine stepping. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveMode, modelThresholds, ownsWrapper, transition, type Effect, type Frame, type MachineEvent } from "../core.ts";
import { canHandoff } from "../budget-notice.ts";
import type { Runtime } from "./runtime.ts";

export const ref = (ctx: ExtensionContext) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";

export function modeStatus(rt: Runtime, ctx: ExtensionContext) {
  let off = false;
  try { off = rt.isGuardOff?.("context") ?? false; } catch { /* Unpatched optional guard module. */ }
  return { effective: effectiveMode(rt.config, ctx.cwd, off), reason: off ? "context guard off" : "cwd restriction" };
}

export function mode(rt: Runtime, ctx: ExtensionContext) {
  return modeStatus(rt, ctx).effective;
}

function observedTokens(ctx: ExtensionContext, observed: number | null | undefined): number | null {
  return observed === undefined ? ctx.getContextUsage()?.tokens ?? null : observed;
}

export function frame(rt: Runtime, ctx: ExtensionContext, observed?: number | null): Frame {
  const { host, config } = rt;
  return { mode: mode(rt, ctx), tokens: observedTokens(ctx, observed),
    thresholds: modelThresholds(config, ref(ctx), host?.subagent ?? false), config,
    handoffAvailable: canHandoff(rt.pi, host), deferAnswered: rt.requests.deferAnswered(ctx), memoryIntent: rt.intent.enabled(ctx),
    wrapped: !!host && ownsWrapper(process.pid, process.env, host.subagent) };
}

export function step(rt: Runtime, event: MachineEvent, ctx: ExtensionContext, observed = frame(rt, ctx)): Effect[] {
  const next = transition(rt.state, event, observed);
  rt.state = next.state;
  return next.effects;
}

export function updateModeMismatch(rt: Runtime, ctx: ExtensionContext): void {
  const current = modeStatus(rt, ctx), configured = rt.config.mode;
  const mismatch = configured !== current.effective ? `context-budget: configured ${configured}, effective ${current.effective} (${current.reason})` : undefined;
  ctx.ui?.setStatus?.("context-budget", mismatch);
  if (mismatch && mismatch !== rt.mismatchLogged) rt.log(ctx, "mode_mismatch", { configured, effective: current.effective, reason: current.reason });
  rt.mismatchLogged = mismatch;
}
