/** Execute pure-machine effects against pi. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CommitSource, Effect, MachineEvent } from "../core.ts";
import { handoffMemory } from "../memory/handoff-hook.ts";
import { softNotice } from "../budget-notice.ts";
import { writeMarker } from "../storage.ts";
import { bytePrefix, emergencySummary } from "../collect.ts";
import { createHandoff, emergencyInput, validateObserved } from "./handoff.ts";
import { frame, mode, step, updateModeMismatch } from "./mode.ts";
import { observeRunning } from "./observe.ts";
import { status } from "./status.ts";
import type { ActionResult, Runtime } from "./runtime.ts";

type Outcome = ActionResult | undefined;
type Of<T extends Effect["type"]> = Extract<Effect, { type: T }>;
type Handlers = { [T in Exclude<Effect["type"], "log">]: (rt: Runtime, effect: Of<T>, ctx: ExtensionContext) => Outcome | Promise<Outcome | void> };

const SOFT_NOTIFY = "Context is large (soft threshold): the agent is asked to update its state file and prepare a handoff; none is forced yet.";
const DEGRADED_NOTIFY = "Context-budget handoff loop limit reached and no relaunch wrapper is available. Tools stay available and handoff enforcement is paused until a tool call makes progress; start a fresh session soon (/new, or relaunch under the wrapper).";
const IDLE_STEER = "Pending background work remains and context is large. Call context_handoff now while the cache is warm, then end this turn. The context resets at the end of this turn.";
const SETTLE_STEER = "Context recovery is required. Call context_handoff with goal, next_step, verified facts and verbatim user_constraints, then end this turn without further tools.";

const customMessage = (content: string) => ({ type: "custom_message" as const, customType: "context-budget", display: true, content });

function backstopKind(rt: Runtime, source: CommitSource, handoff: boolean, ctx: ExtensionContext) {
  if (source === "idle") return "idle" as const;
  if (handoff) return "handoff" as const;
  return rt.state.tokens !== null && rt.state.tokens >= frame(rt, ctx).thresholds.hard ? "hard" as const : "emergency" as const;
}

export async function compact(rt: Runtime, ctx: ExtensionContext, attempt: number): Promise<void> {
  await new Promise<void>(done => {
    const complete = (error?: Error) => {
      const event: MachineEvent = error
        ? { type: "session_compact_failed", reason: "manual", errorMessage: error.message, attempt }
        : { type: "session_compact", owned: true, attempt };
      // Pi emits the success/failure hook BEFORE this callback. Correlation lives in the FSM.
      void run(rt, event, ctx).then(() => done(), error => { rt.log(ctx, "hook_error", { error: String(error) }); done(); });
    };
    try { ctx.compact({ onComplete: () => complete(), onError: complete }); }
    catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function commit(rt: Runtime, effect: Of<"commit">, ctx: ExtensionContext): Promise<Outcome> {
  rt.resume.rememberLaneRoot(ctx, effect.handoff);
  await rt.requests.commit(ctx, effect.handoff.path, effect.source === "idle");
  rt.log(ctx, "handoff_committed", { path: effect.handoff.path, n: effect.handoff.n, count: rt.state.count, source: effect.source });
  return { entries: [{ type: "compaction", summary: await rt.resume.append(ctx, effect.handoff.text, effect.handoff), firstKeptEntryId: null,
    details: { kind: "handoff", path: effect.handoff.path, n: effect.handoff.n, source: effect.source } }], continue: true };
}

/** Mechanical recovery must fit and work even if handoff storage/metadata is unavailable. */
async function backstop(rt: Runtime, effect: Of<"backstop">, ctx: ExtensionContext): Promise<Outcome> {
  const h = effect.handoff, emergency = h ? undefined : emergencyInput(rt, ctx);
  rt.resume.rememberLaneRoot(ctx, h);
  const lint = emergency ? validateObserved(rt, ctx, emergency, { running: observeRunning(rt, ctx, false), enforce: false }).lint : [];
  const body = h?.text ?? emergencySummary(emergency!, await rt.requests.render(ctx, true), await handoffMemory(rt.intent, ctx, rt.state.lastHandoff));
  const summary = `${body}${lint.length ? `\n## Handoff lint\n${bytePrefix(lint.join("\n"), 1024)}` : ""}\nCompaction instance: ${randomUUID()}\n`;
  rt.log(ctx, "backstop", { path: h?.path, reason: "machine-authorized" });
  rt.requests.expectBackstop({ kind: backstopKind(rt, effect.source, !!h, ctx), handoffPath: h?.path });
  return { compaction: { summary: await rt.resume.append(ctx, summary, h, emergency), firstKeptEntryId: null as unknown as string, tokensBefore: effect.tokensBefore,
    details: { kind: "handoff", path: h?.path, n: h?.n, source: effect.source } } };
}

async function relaunch(rt: Runtime, effect: Of<"relaunch">, ctx: ExtensionContext): Promise<void> {
  const h = effect.handoff ?? await createHandoff(rt, ctx, emergencyInput(rt, ctx));
  rt.resume.rememberLaneRoot(ctx, h);
  await rt.resume.persist(ctx, h);
  writeMarker(process.env.PI_RELAUNCH_MARKER!, { cwd: resolve(ctx.cwd), launchPrompt: h.launchPrompt ?? null,
    handoff: h.path, sessionFile: ctx.sessionManager.getSessionFile() ?? null });
  rt.log(ctx, "relaunch", { marker: process.env.PI_RELAUNCH_MARKER, path: h.path });
  status(rt, ctx); ctx.shutdown();
}

const handlers: Handlers = {
  notify: (rt, _effect, ctx) => {
    rt.log(ctx, "soft_crossing");
    ctx.ui.notify(softNotice(frame(rt, ctx), SOFT_NOTIFY), "info");
  },
  notice_soft: (rt, _effect, ctx) => {
    rt.log(ctx, "soft_model_notice");
    return { entries: [customMessage(softNotice(frame(rt, ctx)))] };
  },
  notify_degraded: (rt, effect, ctx) => {
    rt.log(ctx, `${effect.reason}_degraded`);
    ctx.ui.notify(DEGRADED_NOTIFY, "warning");
  },
  notify_cap_advisory: (_rt, effect, ctx) => {
    ctx.ui.notify(`Context-budget: ${effect.count} handoffs this session (cap ${effect.cap}). In-place handoffs keep working, but a fresh session is recommended (/new from the latest handoff, or run under pi-session).`, "warning");
  },
  notice_required: (rt, effect, ctx) => {
    rt.log(ctx, "required_notice");
    return { entries: [customMessage(effect.content)] };
  },
  block: (rt, effect, ctx) => {
    rt.log(ctx, "blocked", { reason: effect.reason });
    return { block: true, reason: effect.reason };
  },
  reject_handoff: (_rt, effect) => { throw new Error(effect.reason); },
  cancel_compaction: () => ({ cancel: true }),
  steer: (rt, effect, ctx) => {
    rt.log(ctx, effect.idleOnly ? "idle_handoff_requested" : "settle_handoff_requested");
    return { entries: [customMessage(rt.intent.steer(ctx, effect.idleOnly ? IDLE_STEER : SETTLE_STEER, effect.idleOnly))], continue: true };
  },
  commit,
  compact: (rt, effect, ctx) => compact(rt, ctx, effect.attempt),
  backstop,
  relaunch: (rt, effect, ctx) => frame(rt, ctx).wrapped ? relaunch(rt, effect, ctx) : undefined,
  write_handoff: () => undefined, // Executed with validated tool arguments by the tool adapter.
};

function apply(rt: Runtime, effect: Exclude<Effect, { type: "log" }>, ctx: ExtensionContext) {
  return (handlers[effect.type] as (rt: Runtime, effect: Effect, ctx: ExtensionContext) => Outcome | Promise<Outcome | void>)(rt, effect, ctx);
}

export async function execute(rt: Runtime, effects: Effect[], ctx: ExtensionContext): Promise<Outcome> {
  let result: Outcome;
  for (const effect of effects) {
    if (effect.type === "log") { rt.log(ctx, effect.event, effect.data); continue; }
    // An awaited operation may have crossed a mode/guard change. Never execute stale actions.
    if (mode(rt, ctx) !== "enforce") { step(rt, { type: "mode_changed" }, ctx, frame(rt, ctx, null)); continue; }
    const outcome = apply(rt, effect, ctx);
    result = (outcome instanceof Promise ? await outcome : outcome) ?? result;
  }
  return result;
}

export async function run(rt: Runtime, event: MachineEvent, ctx: ExtensionContext): Promise<Outcome> {
  const result = await execute(rt, step(rt, event, ctx), ctx);
  // Mode feedback stays live without publishing native-compaction previews
  // over the last budget status in observe mode.
  try { updateModeMismatch(rt, ctx); } catch (error) { rt.log(ctx, "status_error", { error: String(error) }); }
  return result;
}
