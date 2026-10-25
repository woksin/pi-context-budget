/** Pi adapter: collect observations, translate events, execute pure-machine outputs. */
import type { ExtensionAPI, ExtensionContext, BoundaryResult, ToolCallEventResult, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { effectiveMode, modelThresholds, parseConfig, renderHandoff, validateHandoff, ownsWrapper, initialState, transition, policyStatus,
  restoreHistory, handoffBackoff, forced, type Effect, type Frame, type MachineEvent, type Handoff, type HandoffInput, type HistoryItem } from "./core.ts";
import { OverflowRecovery } from "./overflow-recovery.ts";
import { resumeCommand, runResumeCheck } from "./resume-check.ts";
import { appendEvent, atomicJson, gitState, issueClaims, runningState, writeHandoff, writeMarker, processSessionHosts, pendingQuestions, watchCheck, type SessionHosts } from "./storage.ts";

type ActionResult = BoundaryResult & ToolCallEventResult & SessionBeforeCompactResult;
type StatusState = "active" | "ended";
function statusIdentity(host: ReturnType<SessionHosts["acquire"]> | undefined, state: StatusState = "active") {
  return { primarySessionId: host?.primarySessionId, state };
}
export default async function (pi: ExtensionAPI) {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return createContextBudgetExtension({ agentDir: getAgentDir() })(pi);
}
export function createContextBudgetExtension({ agentDir, hosts = processSessionHosts() }: { agentDir: string; hosts?: SessionHosts }) {
  return async function contextBudgetExtension(pi: ExtensionAPI) {
    const stateDir = resolve(process.env.PI_CONTEXT_BUDGET_STATE_DIR || join(agentDir, "context-budget"));
    const configFile = resolve(process.env.PI_CONTEXT_BUDGET_CONFIG || join(agentDir, "context-budget.json"));
    let config = parseConfig({}), state = initialState();
    let host: ReturnType<SessionHosts["acquire"]> | undefined;
    let sequence = 0;
    const overflow = new OverflowRecovery({ pi, log, frame, run, refresh: reload, model: ctx => ref(ctx), emergencyInput,
      guardOff: ctx => modeStatus(ctx).reason === "context guard off", tokens: () => state.tokens, relaunchSent: () => state.relaunchSent });
    const knownIds = new Set<string>();
    let resumeBoundary: string | undefined, resumeMessage: string | undefined;
    let mismatchLogged: string | undefined;
    let isGuardOff: ((name: string) => boolean) | undefined;
    try { isGuardOff = (await import(pathToFileURL(join(agentDir, "lib/guards.ts")).href)).isGuardOff; }
    catch { /* Optional integration: absence never disables configured enforcement. */ }
    function log(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void {
      try { appendEvent(stateDir, { at: new Date().toISOString(), pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), event, ...data }); }
      catch (error) { console.error(`context-budget: event log unavailable: ${String(error)}`); }
    }
    function reload(ctx: ExtensionContext): void {
      try { config = parseConfig(existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {}); }
      catch (error) { config = parseConfig({}); log(ctx, "config_error", { error: String(error), mode: "observe" }); }
    }
    const ref = (ctx: ExtensionContext) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    function modeStatus(ctx: ExtensionContext) {
      let off = false;
      try { off = isGuardOff?.("context") ?? false; } catch { /* Unpatched optional guard module. */ }
      return { effective: effectiveMode(config, ctx.cwd, off), reason: off ? "context guard off" : "cwd restriction" };
    }
    function mode(ctx: ExtensionContext) {
      return modeStatus(ctx).effective;
    }
    function frame(ctx: ExtensionContext, observedTokens?: number | null): Frame {
      return { mode: mode(ctx), tokens: observedTokens === undefined ? ctx.getContextUsage()?.tokens ?? null : observedTokens,
        thresholds: modelThresholds(config, ref(ctx), host?.subagent ?? false), config,
        wrapped: !!host && ownsWrapper(process.pid, process.env, host.subagent) };
    }
    function step(event: MachineEvent, ctx: ExtensionContext, observed = frame(ctx)): Effect[] {
      const next = transition(state, event, observed);
      state = next.state;
      return next.effects;
    }
    function updateModeMismatch(ctx: ExtensionContext): void {
      const current = modeStatus(ctx);
      const mismatch = config.mode !== current.effective ? `context-budget: configured ${config.mode}, effective ${current.effective} (${current.reason})` : undefined;
      ctx.ui?.setStatus?.("context-budget", mismatch);
      if (mismatch && mismatch !== mismatchLogged) log(ctx, "mode_mismatch", { configured: config.mode, effective: current.effective, reason: current.reason });
      mismatchLogged = mismatch;
    }
    function status(ctx: ExtensionContext, lifecycle?: StatusState): void {
      try {
        const f = frame(ctx), policy = policyStatus(state, f);
        updateModeMismatch(ctx);
        atomicJson(join(stateDir, "status", `${ctx.sessionManager.getSessionId()}.json`), {
          at: new Date().toISOString(), pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
          cwd: ctx.cwd, model: ref(ctx), role: host?.subagent ? "subagent" : "main", tokens: state.tokens, ...statusIdentity(host, lifecycle),
          thresholds: f.thresholds, floor: state.floor, phase: policy.phase, action: policy.action, projected: f.mode === "observe", lastHandoffPath: state.lastHandoff?.path ?? null,
          lastHandoffTime: state.lastHandoff?.at ?? null, handoffCount: state.count, mode: f.mode, configuredMode: config.mode,
          fallbackReason: policy.fallbackReason, modeMismatchReason: config.mode !== f.mode ? modeStatus(ctx).reason : null,
          wrapper: f.wrapped, relaunchMarker: f.wrapped ? process.env.PI_RELAUNCH_MARKER : null,
        });
      } catch (error) { log(ctx, "status_error", { error: String(error) }); }
    }
    function autoState(ctx: ExtensionContext) {
      const running = runningState([...knownIds], { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
      let claims: unknown[] = [];
      try { claims = issueClaims(join(agentDir, "issue-work/registry.jsonl"), ctx.sessionManager.getSessionId()); }
      catch { running.unavailable.push("issue_work registry absent/unreadable"); }
      return { ...gitState(ctx.cwd), ...running, claims,
        questions: pendingQuestions(process.env.PI_QUESTIONS_HOME || join(agentDir, "user-questions"), ctx.sessionManager.getSessionId()) };
    }
    function checkCommand(ctx: ExtensionContext) {
      if (host?.subagent) return undefined;
      return resumeCommand(config, ctx.sessionManager.getSessionName?.());
    }
    async function createHandoff(ctx: ExtensionContext, input: HandoffInput): Promise<Handoff> {
      validateHandoff(input);
      const command = checkCommand(ctx);
      const resumeCheck = command ? await runResumeCheck(command, ctx.cwd) : undefined;
      const auto = { ...autoState(ctx), resumeCheck }, id = ctx.sessionManager.getSessionId();
      let path: string;
      do { path = join(auto.root, ".ai-work/handoffs", `${id}-${++sequence}.md`); } while (existsSync(path));
      const h = renderHandoff(input, auto, id, sequence, path, new Date().toISOString());
      writeHandoff(h, auto);
      log(ctx, "handoff_written", { path, n: h.n, bytes: Buffer.byteLength(h.text) });
      return h;
    }
    function emergencyInput(ctx: ExtensionContext): HandoffInput {
      const requests = ctx.sessionManager.getBranch().flatMap(e => e.type === "message" && e.message.role === "user"
        ? [JSON.stringify(e.message.content).slice(0, 600)] : []).slice(-3).join("\n");
      return { goal: `Emergency handoff. Recent user requests:\n${requests || "Recover the original request from the session file."}`,
        facts: `No fresh structured handoff. Recheck previous tests/review/CI/issue claims. Session file: ${(ctx.sessionManager.getSessionFile() ?? "unavailable").slice(0, 400)}`,
        next_step: "Re-establish state from files and git, re-read user constraints in the session file, then continue. Do not assume any prior check passed." };
    }
    async function compact(ctx: ExtensionContext, attempt: number): Promise<void> {
      await new Promise<void>(done => {
        const complete = (error?: Error) => {
          const event: MachineEvent = error
            ? { type: "session_compact_failed", reason: "manual", errorMessage: error.message, attempt }
            : { type: "session_compact", owned: true, attempt };
          // Pi emits the success/failure hook BEFORE this callback. Correlation lives in the FSM.
          void run(event, ctx).then(() => done(), error => { log(ctx, "hook_error", { error: String(error) }); done(); });
        };
        try { ctx.compact({ onComplete: () => complete(), onError: complete }); }
        catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
      });
    }
    async function execute(effects: Effect[], ctx: ExtensionContext): Promise<ActionResult | undefined> {
      let result: ActionResult | undefined;
      for (const effect of effects) {
        if (effect.type === "log") { log(ctx, effect.event, effect.data); continue; }
        // An awaited operation may have crossed a mode/guard change. Never execute stale actions.
        if (mode(ctx) !== "enforce") { step({ type: "mode_changed" }, ctx, frame(ctx, null)); continue; }
        switch (effect.type) {
          case "notify":
            log(ctx, "soft_crossing");
            ctx.ui.notify("Context is large: finish the current step first; hand off at the next natural boundary. No handoff is required at the soft threshold.", "info"); break;
          case "block":
            log(ctx, "blocked", { reason: effect.reason }); result = { block: true, reason: effect.reason }; break;
          case "reject_handoff": throw new Error(effect.reason);
          case "cancel_compaction": result = { cancel: true }; break;
          case "steer":
            log(ctx, effect.idleOnly ? "idle_handoff_requested" : "settle_handoff_requested");
            result = { entries: [{ type: "custom_message", customType: "context-budget", display: true, content: effect.idleOnly
              ? "Pending background work remains and context is large. Call context_handoff now while the cache is warm, then end this turn. The context resets at the end of this turn."
              : "Context recovery is required. Call context_handoff with goal, next_step, verified facts and verbatim user_constraints, then end this turn without further tools." }], continue: true }; break;
          case "commit":
            log(ctx, "handoff_committed", { path: effect.handoff.path, n: effect.handoff.n, count: state.count, source: effect.source });
            result = { entries: [{ type: "compaction", summary: effect.handoff.text, firstKeptEntryId: null,
              details: { kind: "handoff", path: effect.handoff.path, n: effect.handoff.n, source: effect.source } }], continue: true }; break;
          case "compact": await compact(ctx, effect.attempt); break;
          case "backstop": {
            // Mechanical recovery must fit and work even if handoff storage/metadata is unavailable.
            const h = effect.handoff, emergency = h ? undefined : emergencyInput(ctx);
            const summary = `${h?.text ?? `# Emergency handoff\n${emergency!.goal}\n${emergency!.facts}\n${emergency!.next_step}`}\nCompaction instance: ${randomUUID()}\n`;
            log(ctx, "backstop", { path: h?.path, reason: "machine-authorized" });
            result = { compaction: { summary, firstKeptEntryId: null as unknown as string, tokensBefore: effect.tokensBefore,
              details: { kind: "handoff", path: h?.path, n: h?.n, source: effect.source } } }; break;
          }
          case "relaunch": {
            if (!frame(ctx).wrapped) break;
            const h = effect.handoff ?? await createHandoff(ctx, emergencyInput(ctx));
            writeMarker(process.env.PI_RELAUNCH_MARKER!, { cwd: resolve(ctx.cwd), launchPrompt: h.launchPrompt ?? null,
              handoff: h.path, sessionFile: ctx.sessionManager.getSessionFile() ?? null });
            log(ctx, "relaunch", { marker: process.env.PI_RELAUNCH_MARKER, path: h.path });
            status(ctx); ctx.shutdown(); break;
          }
          case "write_handoff": break; // Executed with validated tool arguments by the tool adapter below.
        }
      }
      return result;
    }
    async function run(event: MachineEvent, ctx: ExtensionContext) {
      const result = await execute(step(event, ctx), ctx);
      // Mode feedback stays live without publishing native-compaction previews
      // over the last budget status in observe mode.
      try { updateModeMismatch(ctx); } catch (error) { log(ctx, "status_error", { error: String(error) }); }
      return result;
    }
    const safe = <E, R>(handler: (event: E, ctx: ExtensionContext) => R | Promise<R>) => async (event: E, ctx: ExtensionContext): Promise<R | undefined> => {
      try { return await handler(event, ctx); } catch (error) { log(ctx, "hook_error", { error: String(error) }); }
    };
    function reset(ctx: ExtensionContext): void {
      host?.release(); host = hosts.acquire(ctx.sessionManager.getSessionId());
      reload(ctx); overflow.reset(ctx); knownIds.clear(); resumeBoundary = resumeMessage = mismatchLogged = undefined;
      const history: HistoryItem[] = ctx.sessionManager.getBranch().flatMap((e): HistoryItem[] => {
        if (e.type === "compaction") {
          const details = e.details as { kind?: string; source?: string } | undefined;
          return [{ type: "compaction", owned: details?.kind === "handoff", source: details?.source === "idle" ? "idle" : "budget" }];
        }
        if (e.type !== "message") return [];
        const m = e.message;
        if (m.role === "user") return [{ type: "input" }];
        if (m.role === "assistant") return [{ type: "usage", tokens: m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite }];
        if (m.role === "toolResult") return [{ type: "tool", handoff: m.toolName === "context_handoff" ? (m.details as { handoff?: Handoff })?.handoff : undefined, error: m.isError }];
        return [];
      });
      state = restoreHistory(history, frame(ctx).mode);
      sequence = Math.max(sequence, state.lastHandoff?.n ?? 0);
      status(ctx);
    }
    pi.on("session_start", safe((_e, ctx) => { reset(ctx); log(ctx, "session_start", { mode: frame(ctx).mode, model: ref(ctx) }); }));
    pi.on("session_tree", safe((_e, ctx) => reset(ctx)));
    // Context runs after Pi has installed the boundary and before the resumed
    // provider call, including retain-none commits returned from turn_end.
    pi.on("context", safe(async (event, ctx) => {
      if (mode(ctx) !== "enforce") return;
      const boundary = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "compaction");
      if (!boundary || (boundary.details as { kind?: string } | undefined)?.kind !== "handoff") return;
      let watchMessage: string | undefined;
      if (resumeBoundary !== boundary.id) {
        resumeBoundary = boundary.id; resumeMessage = undefined;
        const command = checkCommand(ctx);
        const checks: string[] = [];
        if (command) checks.push(`## Resume check (after context reset)\n${await runResumeCheck(command, ctx.cwd)}`);
        try {
          const path = (boundary.details as { path?: string }).path;
          const handoff = state.lastHandoff?.path === path ? state.lastHandoff
            : path ? JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf8")) as Handoff : undefined;
          watchMessage = watchCheck(handoff?.recordedJobs);
        } catch { /* Optional recorded/live watch state unavailable. */ }
        resumeMessage = checks.join("\n\n") || undefined;
      }
      const message = [resumeMessage, watchMessage].filter(Boolean).join("\n\n");
      if (message) return { messages: [...event.messages, { role: "custom" as const, customType: "context-budget-resume-check", content: message, display: false, timestamp: Date.now() }] };
    }));
    pi.on("agent_start", safe(async (_e, ctx) => { await run({ type: "agent_start" }, ctx); }));
    pi.on("before_agent_start", safe(async (_e, ctx) => { await run({ type: "before_agent_start" }, ctx); }));
    pi.registerTool({
      name: "context_handoff", label: "Context handoff",
      description: "Write a concise structured handoff, then END THIS TURN without more tools. Recovery continues automatically; an idle request resets the context at the end of this turn. Separate facts from hypotheses and preserve user constraints verbatim.",
      parameters: { type: "object", properties: {
        goal: { type: "string", minLength: 1 }, next_step: { type: "string", minLength: 1 }, facts: { type: "string", minLength: 1 },
        decisions: { type: "string" }, user_constraints: { type: "string" }, open_items: { type: "string" }, hypotheses: { type: "string" },
        files_to_read: { type: "array", items: { type: "string" } }, launch_prompt: { type: "string" },
      }, required: ["goal", "next_step", "facts"], additionalProperties: false } as never,
      async execute(_id, input: HandoffInput, _signal, _update, ctx) {
        const effects = step({ type: "handoff_prepare" }, ctx);
        const intent = effects.find(e => e.type === "write_handoff");
        if (!intent || mode(ctx) !== "enforce") {
          await execute(effects, ctx);
          return { content: [{ type: "text", text: "Handoff inactive; no automatic action. Continue the task." }], details: {} };
        }
        validateHandoff(input);
        const f = frame(ctx);
        const refusal = handoffBackoff(input, state.lastHandoff, gitState(ctx.cwd).head, Boolean(forced(state, f)));
        if (refusal) throw new Error(refusal);
        const handoff = await createHandoff(ctx, input);
        await run({ type: "handoff_written", handoff }, ctx);
        return { content: [{ type: "text", text: intent.idleOnly ? "Handoff stored. End this turn without further tools; the context resets at the end of this turn." : "Handoff stored. End this turn without further tools; recovery continues automatically." }], details: { handoff } };
      },
    });
    pi.on("tool_call", safe((e, ctx) => run({ type: "tool_call", tool: e.toolName, id: e.toolCallId }, ctx)));
    pi.on("tool_execution_end", safe(async (e, ctx) => {
      // Reading ids is metadata collection, not policy; never walk arbitrary/cyclic result trees.
      const collect = (value: unknown, depth = 0): void => {
        if (!value || typeof value !== "object" || depth > 5) return;
        const v = value as Record<string, unknown>;
        if (typeof v.agentId === "string") knownIds.add(v.agentId);
        for (const child of Object.values(v)) if (typeof child === "object") collect(child, depth + 1);
      };
      if (e.toolName === "Agent" || e.toolName === "SubagentWorkflow") collect(e.result?.details);
      await run({ type: "tool_end", tool: e.toolName, id: e.toolCallId, error: e.isError }, ctx);
    }));
    pi.on("turn_end", safe(async (e, ctx) => {
      const result = await overflow.turn(e, ctx);
      log(ctx, "turn", { tokens: state.tokens, floor: state.floor, phase: state.phase }); status(ctx); return result;
    }));
    const pendingWork = (ctx: ExtensionContext) => { const r = runningState([...knownIds], { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }); return !!(r.jobs.length || r.subagents.length); };
    pi.on("agent_before_settle", safe((_e, ctx) => run({ type: "agent_before_settle", pendingWork: pendingWork(ctx) }, ctx)));
    pi.on("agent_settled", safe(async (e, ctx) => { await run({ type: "agent_settled", now: Date.now(), aborted: e.aborted, pendingWork: pendingWork(ctx) }, ctx); await overflow.settled(ctx, e.aborted); }));
    pi.on("input", safe(async (e, ctx) => {
      reload(ctx); overflow.input(e.source);
      await run({ type: "input", now: Date.now(), streaming: !!e.streamingBehavior, alreadyCompacted: ctx.sessionManager.getBranch().at(-1)?.type === "compaction" }, ctx);
      return { action: "continue" as const };
    }));
    pi.on("session_before_compact", (e, ctx) => overflow.beforeCompact(e, ctx, async () => {
      try { return await run({ type: "session_before_compact", reason: e.reason, tokensBefore: e.preparation?.tokensBefore }, ctx); }
      catch (error) {
        log(ctx, "backstop_error", { error: String(error) });
        try {
          // Missing measurements are an observation, not an adapter-level policy exception.
          return await execute(step({ type: "backstop_failed", reason: e.reason, errorMessage: String(error) }, ctx, frame(ctx, null)), ctx);
        } catch { return undefined; } // A torn-down runtime cannot execute any policy output.
      }
    }));
    pi.on("session_compact", safe(async (e, ctx) => {
      overflow.nativeCompaction(ctx, e.reason); await run({ type: "session_compact", owned: !!state.compaction && e.fromExtension }, ctx); status(ctx);
    }));
    pi.on("session_compact_failed", safe(async (e, ctx) => { overflow.nativeCompaction(ctx, e.reason); await run(e, ctx); }));
    pi.on("session_shutdown", safe((_e, ctx) => { overflow.shutdown(); status(ctx, "ended"); host?.release(); host = undefined; log(ctx, "session_shutdown"); }));
  };
}
