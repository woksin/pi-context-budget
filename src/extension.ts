/** Structured retain-none handoffs; observe by default. No timers or provider calls. */
import type { ExtensionAPI, ExtensionContext, BoundaryResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Budget, effectiveMode, isSubagent, modelThresholds, parseConfig, renderHandoff, shouldBlock, type Handoff, type HandoffInput } from "./core.ts";
import { appendEvent, atomicJson, gitState, issueClaims, runningState, writeHandoff, writeMarker } from "./storage.ts";

export default async function (pi: ExtensionAPI) {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return createContextBudgetExtension({ agentDir: getAgentDir() })(pi);
}

/** Explicit root injection keeps unit tests independent of a user's pi installation. */
export function createContextBudgetExtension({ agentDir }: { agentDir: string }) {
  return async function contextBudgetExtension(pi: ExtensionAPI) {
  const stateDir = resolve(process.env.PI_CONTEXT_BUDGET_STATE_DIR || join(agentDir, "context-budget"));
  const configFile = resolve(process.env.PI_CONTEXT_BUDGET_CONFIG || join(agentDir, "context-budget.json"));
  const registryFile = join(agentDir, "issue-work", "registry.jsonl");
  let config = parseConfig({});
  let budget = new Budget();
  let pending: Handoff | undefined, stored: Handoff | undefined, lastHandoff: Handoff | undefined;
  let sequence = 0, lastSettled = 0, softSent = false, settleAsked = false, idleRequested = false;
  let fallbackReason: string | undefined;
  let providerError = false, observedIdlePending = false;
  let knownIds = new Set<string>();
  const blockedCalls = new Set<string>();
  let compactionSequence = 0;
  let previousAction = "none";
  let isGuardOff: ((name: string) => boolean) | undefined;
  // INSTALL.md patches the shared guard library. A missing/unpatched library leaves enforcement on.
  try {
    const guards = await import(pathToFileURL(join(agentDir, "lib", "guards.ts")).href);
    isGuardOff = guards.isGuardOff;
  } catch { /* Standalone -e loading, or installation has not included the guard patch. */ }
  const log = (ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}) => {
    try { appendEvent(stateDir, { at: new Date().toISOString(), pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), event, ...data }); }
    catch (error) { console.error(`context-budget: event log unavailable: ${String(error)}`); }
  };
  const safe = <E, R>(handler: (event: E, ctx: ExtensionContext) => R | Promise<R>) => async (event: E, ctx: ExtensionContext): Promise<R | undefined> => {
    try { return await handler(event, ctx); }
    catch (error) { log(ctx, "hook_error", { error: String(error) }); return undefined; }
  };
  function reload(ctx: ExtensionContext): void {
    try { config = parseConfig(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {}); }
    catch (error) { config = parseConfig({}); log(ctx, "config_error", { error: String(error), mode: "observe" }); }
  }
  function mode(ctx: ExtensionContext) {
    let off = false;
    try { off = isGuardOff?.("context") ?? false; } catch { /* Not patched yet. */ }
    return effectiveMode(config, ctx.cwd, off);
  }
  const tokens = (ctx: ExtensionContext) => ctx.getContextUsage()?.tokens ?? null;
  const ref = (ctx: ExtensionContext) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  const limits = (ctx: ExtensionContext) => modelThresholds(config, ref(ctx), isSubagent(ctx.sessionManager.getHeader()));
  // In-process children inherit the environment but do not own the wrapper's process marker.
  const wrapped = (ctx: ExtensionContext) => !isSubagent(ctx.sessionManager.getHeader()) && process.env.PI_SESSION_WRAPPER === "1" && !!process.env.PI_RELAUNCH_MARKER;
  const action = (ctx: ExtensionContext) => fallbackReason ? "relaunch" as const : budget.action(tokens(ctx), limits(ctx), config);
  const reason = (ctx: ExtensionContext) => `Context budget reached (${tokens(ctx) ?? "unknown"} tokens). Every tool except context_handoff is blocked. Call context_handoff now with goal, next_step, and facts (verified SHAs, review/CI ids, PR/issue states); include verbatim user_constraints and hypotheses separately. Then end this turn. You will continue automatically. Only the user may disable enforcement via configuration, or /guards off context when that optional integration is installed.`;
  function status(ctx: ExtensionContext, measuredTokens: number | null = tokens(ctx)): void {
    try { atomicJson(join(stateDir, "status", `${ctx.sessionManager.getSessionId()}.json`), {
      at: new Date().toISOString(), pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd, model: ref(ctx), role: isSubagent(ctx.sessionManager.getHeader()) ? "subagent" : "main", tokens: measuredTokens,
      thresholds: limits(ctx), floor: budget.floor, lastHandoffPath: lastHandoff?.path ?? null, lastHandoffTime: lastHandoff?.at ?? null,
      handoffCount: budget.count, mode: mode(ctx), configuredMode: config.mode, fallbackReason: fallbackReason ?? null,
      wrapper: wrapped(ctx), relaunchMarker: wrapped(ctx) ? process.env.PI_RELAUNCH_MARKER : null,
    }); } catch (error) { log(ctx, "status_error", { error: String(error) }); }
  }
  function autoState(ctx: ExtensionContext) {
    const running = runningState([...knownIds]);
    let claims: unknown[] = [];
    try { claims = issueClaims(registryFile, ctx.sessionManager.getSessionId()); }
    catch { running.unavailable.push("issue_work registry absent/unreadable"); }
    return { ...gitState(ctx.cwd), ...running, claims };
  }
  function createHandoff(ctx: ExtensionContext, input: HandoffInput): Handoff {
    const auto = autoState(ctx), id = ctx.sessionManager.getSessionId();
    let path: string;
    do { path = join(auto.root, ".ai-work", "handoffs", `${id}-${++sequence}.md`); } while (existsSync(path));
    const h = renderHandoff(input, auto, id, sequence, path, new Date().toISOString());
    writeHandoff(h, auto);
    stored = h; lastHandoff = h;
    log(ctx, "handoff_written", { path, n: h.n, bytes: Buffer.byteLength(h.text), idleOnly: idleRequested });
    return h;
  }
  function emergencyInput(ctx: ExtensionContext): HandoffInput {
    const requests = ctx.sessionManager.getBranch().filter(e => e.type === "message" && e.message.role === "user").slice(-3)
      .map(e => e.type === "message" && e.message.role === "user" ? JSON.stringify(e.message.content).slice(0, 1400) : "").join("\n");
    return { goal: `Emergency handoff. Recent user requests:\n${requests || "Read the session file to recover the request."}`,
      facts: `No fresh structured handoff was available. Previous claims about tests, review, CI and issues must be rechecked. Session file: ${ctx.sessionManager.getSessionFile() ?? "unavailable"}`,
      next_step: "Re-establish state from files and git before continuing. Re-read user constraints in the session file. Do not assume previous work or checks succeeded." };
  }
  function continuation(ctx: ExtensionContext, idle = false): BoundaryResult {
    settleAsked = true;
    idleRequested = idle;
    return { entries: [{ type: "custom_message", customType: "context-budget", display: true,
      content: idle ? "Pending background work remains and context is large. Call context_handoff now while the cache is warm, then end the turn. It will be stored without compaction until the next idle input." : reason(ctx) }], continue: true };
  }
  function reset(ctx: ExtensionContext): void {
    budget = new Budget(); pending = stored = lastHandoff = undefined;
    sequence = lastSettled = 0; softSent = settleAsked = idleRequested = providerError = false;
    fallbackReason = undefined; knownIds = new Set(); blockedCalls.clear(); previousAction = "none";
    reload(ctx);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "compaction") {
        budget.resetFloor();
        const d = entry.details as { kind?: string; path?: string; n?: number } | undefined;
        if (d?.kind === "handoff") { budget.committed(); sequence = Math.max(sequence, d.n ?? 0); }
      }
      if (entry.type === "message" && entry.message.role === "user") stored = undefined;
      if (entry.type === "message" && entry.message.role === "assistant") {
        budget.turn++;
        const u = entry.message.usage;
        if (u) budget.measureUsage(u.input + u.output + u.cacheRead + u.cacheWrite);
      }
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName !== "context_handoff") {
          stored = undefined;
          if (!entry.message.isError) budget.progressed();
        }
        else {
          const d = entry.message.details as { handoff?: Handoff } | undefined;
          if (d?.handoff) { stored = lastHandoff = d.handoff; sequence = Math.max(sequence, d.handoff.n); }
        }
      }
    }
    status(ctx);
  }
  pi.on("session_start", safe((_event, ctx) => { reset(ctx); log(ctx, "session_start", { mode: mode(ctx), model: ref(ctx) }); }));
  pi.on("session_tree", safe((_event, ctx) => reset(ctx)));
  pi.on("agent_start", safe((_event, _ctx) => {
    // A new external prompt/custom delivery makes an old idle snapshot stale.
    stored = undefined; settleAsked = idleRequested = providerError = false;
  }));
  pi.registerTool({
    name: "context_handoff", label: "Context handoff",
    description: "Write a structured task handoff, then end this turn. In enforce mode history is replaced at turn_end and work continues automatically; an idle handoff is stored only. Keep verified facts separate from hypotheses. Never omit verbatim user constraints.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", minLength: 1 }, next_step: { type: "string", minLength: 1 }, facts: { type: "string", minLength: 1 },
        decisions: { type: "string" }, user_constraints: { type: "string" }, open_items: { type: "string" },
        hypotheses: { type: "string" }, files_to_read: { type: "array", items: { type: "string" } }, launch_prompt: { type: "string" },
      },
      required: ["goal", "next_step", "facts"], additionalProperties: false,
    } as never,
    async execute(_id, input: HandoffInput, _signal, _onUpdate, ctx) {
      if (mode(ctx) !== "enforce") {
        log(ctx, "would_handoff", { mode: mode(ctx) });
        return { content: [{ type: "text", text: "Context handoff is inactive in observe/off mode; no file, compaction, block or relaunch was performed. Continue the task." }], details: {} };
      }
      if (pending) throw new Error("A handoff is already pending; end this turn without further tool calls.");
      const h = createHandoff(ctx, input);
      if (!idleRequested) pending = h;
      return { content: [{ type: "text", text: idleRequested ? "Handoff stored for idle reset. End this turn." : "Handoff stored. End this turn without further tools; work continues automatically from Next step." }], details: { handoff: h } };
    },
  });
  pi.on("tool_call", safe((event, ctx) => {
    const a = action(ctx), m = mode(ctx);
    if (event.toolName !== "context_handoff") stored = undefined;
    if (m === "observe" && (a !== "none" || pending)) log(ctx, "would_block", { tool: event.toolName, action: a, tokens: tokens(ctx) });
    if (shouldBlock(m, event.toolName, a, !!pending, wrapped(ctx))) {
      blockedCalls.add(event.toolCallId);
      log(ctx, "blocked", { tool: event.toolName, action: a, tokens: tokens(ctx) });
      return { block: true, reason: pending ? "Handoff written. End this turn without further tool calls; continuation is automatic." : reason(ctx) };
    }
  }));
  pi.on("tool_execution_end", safe((event, ctx) => {
    if (blockedCalls.delete(event.toolCallId)) return;
    if (event.toolName !== "context_handoff") stored = undefined;
    if (event.toolName !== "context_handoff" && !event.isError) budget.progressed();
    // The current pi-subagents registry exposes getRecord but not enumeration.
    const collect = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== "object" || depth > 5) return;
      const v = value as Record<string, unknown>;
      if (typeof v.agentId === "string") knownIds.add(v.agentId);
      for (const child of Object.values(v)) if (typeof child === "object") collect(child, depth + 1);
    };
    if (event.toolName === "Agent" || event.toolName === "SubagentWorkflow") collect(event.result?.details);
    // A sibling tool might already be running when context_handoff executes.
    if (event.toolName !== "context_handoff" && pending) {
      pending = stored = undefined;
      log(ctx, "handoff_invalidated", { reason: "sibling tool completed after handoff" });
    }
  }));
  pi.on("turn_end", safe((event, ctx): BoundaryResult | undefined => {
    budget.turn++;
    if (event.message.role === "assistant") {
      providerError = event.message.stopReason === "error" || event.message.stopReason === "aborted";
      const u = event.message.usage;
      if (u && !providerError) budget.measureUsage(u.input + u.output + u.cacheRead + u.cacheWrite);
    }
    const m = mode(ctx), t = tokens(ctx), a = action(ctx);
    if (a !== previousAction && a !== "none" && m !== "off") log(ctx, m === "observe" ? `would_${a}_crossing` : `${a}_crossing`, { tokens: t, floor: budget.floor });
    previousAction = a;
    if (m === "enforce" && a === "relaunch") fallbackReason ??= budget.looped(config) ? "handoff loop" : "hard limit or handoff cap";
    if (pending && m === "enforce" && !fallbackReason && !providerError) {
      const h = pending; pending = undefined;
      budget.committed(); softSent = settleAsked = idleRequested = false; previousAction = "none";
      log(ctx, "handoff_committed", { path: h.path, n: h.n, count: budget.count, tokensBefore: t });
      status(ctx, null);
      return { entries: [{ type: "compaction", summary: h.text, firstKeptEntryId: null, details: { kind: "handoff", path: h.path, n: h.n } }], continue: true };
    }
    if (m !== "enforce") pending = undefined;
    if (t === null || t < limits(ctx).soft) softSent = false;
    if (t !== null && t >= limits(ctx).soft && !softSent) {
      softSent = true;
      log(ctx, m === "observe" ? "would_soft_notice" : "soft_crossing", { tokens: t });
      if (m === "enforce") ctx.ui.notify("Context is large: finish the current step first; hand off at the next natural boundary. No handoff is required at the soft threshold.", "info");
    }
    if (m === "observe" && a !== "none") log(ctx, `would_${a}`, { tokens: t, floor: budget.floor });
    log(ctx, "turn", { tokens: t, floor: budget.floor, action: a });
    status(ctx);
  }));
  pi.on("agent_before_settle", safe((_event, ctx): BoundaryResult | undefined => {
    if (providerError) return;
    const m = mode(ctx), a = action(ctx);
    if (m !== "enforce") return;
    if (a === "relaunch") fallbackReason ??= "hard limit, loop or cap";
    if (a !== "none" && !settleAsked && !pending) return continuation(ctx);
    const t = tokens(ctx), running = runningState([...knownIds]);
    if (!settleAsked && !stored && t !== null && t >= config.idleMinTokens && (running.jobs.length || running.subagents.length)) {
      log(ctx, "idle_handoff_requested", { tokens: t });
      return continuation(ctx, true);
    }
  }));
  pi.on("agent_settled", safe((event, ctx) => {
    lastSettled = Date.now();
    if (mode(ctx) !== "enforce") {
      const running = runningState([...knownIds]);
      observedIdlePending = mode(ctx) === "observe" && (tokens(ctx) ?? 0) >= config.idleMinTokens && !!(running.jobs.length || running.subagents.length);
      if (observedIdlePending) log(ctx, "would_idle_handoff");
      return;
    }
    if (fallbackReason && !event.aborted && !providerError) {
      if (!wrapped(ctx)) { log(ctx, "relaunch_unavailable", { reason: fallbackReason, detail: "This session does not own a pi-session wrapper. Enforcement stays on; use /guards off context only if the user chooses." }); return; }
      const h = pending ?? stored ?? createHandoff(ctx, emergencyInput(ctx));
      writeMarker(process.env.PI_RELAUNCH_MARKER!, { cwd: resolve(ctx.cwd), launchPrompt: h.launchPrompt ?? null, handoff: h.path, sessionFile: ctx.sessionManager.getSessionFile() ?? null });
      log(ctx, "relaunch", { marker: process.env.PI_RELAUNCH_MARKER, reason: fallbackReason, path: h.path });
      status(ctx);
      ctx.shutdown();
    }
  }));
  pi.on("input", safe(async (event, ctx) => {
    reload(ctx);
    const elapsed = lastSettled ? Date.now() - lastSettled : 0;
    if (elapsed >= config.idleMinutes * 60000 && !event.streamingBehavior) {
      if (mode(ctx) === "observe" && observedIdlePending) log(ctx, "would_idle_compact", { elapsed });
      else if (mode(ctx) === "enforce" && stored && (tokens(ctx) ?? 0) > config.keepRecentTokens && ctx.sessionManager.getBranch().at(-1)?.type !== "compaction") {
        const outcome = await new Promise<string>(done => {
          try { ctx.compact({ onComplete: () => done("ok"), onError: error => done(error.message) }); }
          catch (error) { done(String(error)); }
        });
        log(ctx, "idle_compact", { outcome });
        if (outcome !== "ok" && !outcome.includes("Nothing to compact")) fallbackReason = "idle compaction failed";
      }
    }
    stored = undefined; idleRequested = settleAsked = observedIdlePending = false;
    return { action: "continue" as const };
  }));
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      if (mode(ctx) !== "enforce") { log(ctx, "would_backstop", { reason: event.reason }); return { cancel: true }; }
      const h = stored ?? createHandoff(ctx, emergencyInput(ctx));
      const summary = `${h.text}\nCompaction instance: ${++compactionSequence}-${randomUUID()}\n`;
      log(ctx, "backstop", { reason: event.reason, path: h.path, n: h.n });
      return { compaction: { summary, firstKeptEntryId: null as unknown as string, tokensBefore: event.preparation.tokensBefore,
        details: { kind: "handoff", path: h.path, n: h.n } } };
    } catch (error) { log(ctx, "backstop_error", { error: String(error) }); return { cancel: true }; }
  });
  pi.on("session_compact", safe((_event, ctx) => { budget.committed(); softSent = settleAsked = false; status(ctx); }));
  pi.on("session_compact_failed", safe((_event, ctx) => { if (mode(ctx) === "enforce") fallbackReason = "compaction failed"; }));
  pi.on("session_shutdown", safe((_event, ctx) => { status(ctx); log(ctx, "session_shutdown"); }));
  };
}
