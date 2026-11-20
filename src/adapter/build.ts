/** Construct the shared runtime and its memory/overflow collaborators. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialState, parseConfig } from "../core.ts";
import { OverflowRecovery } from "../overflow-recovery.ts";
import { appendEvent, type SessionHosts } from "../storage.ts";
import { createRequestsHook, wire } from "../memory/requests-hook.ts";
import type { LaunchFacts } from "../memory/launch.ts";
import { createIntentHook } from "../memory/tools.ts";
import { createRecallHook } from "../memory/recall.ts";
import { createResumeHook } from "../memory/resume.ts";
import { emergencyInput } from "./handoff.ts";
import { run } from "./effects.ts";
import { frame, modeStatus, ref } from "./mode.ts";
import { autoState, checkCommand } from "./observe.ts";
import { reload, type EventLog, type Runtime } from "./runtime.ts";

export type RuntimeOptions = { agentDir: string; hosts: SessionHosts; launchFacts: () => LaunchFacts };

const hasActiveTools = (pi: ExtensionAPI) => (pi.getActiveTools?.().length ?? 1) > 0;

async function loadGuard(agentDir: string): Promise<((name: string) => boolean) | undefined> {
  try { return (await import(pathToFileURL(join(agentDir, "lib/guards.ts")).href)).isGuardOff; }
  catch { return undefined; } // Optional integration: absence never disables configured enforcement.
}

function eventLog(stateDir: string): EventLog {
  return (ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}): void => {
    try { appendEvent(stateDir, { at: new Date().toISOString(), pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), event, ...data }); }
    catch (error) { console.error(`context-budget: event log unavailable: ${String(error)}`); }
  };
}

function createOverflow(pi: ExtensionAPI, log: EventLog, self: () => Runtime): OverflowRecovery {
  return new OverflowRecovery({ pi, log, frame: ctx => frame(self(), ctx), run: (event, ctx) => run(self(), event, ctx),
    refresh: ctx => reload(self(), ctx), model: ctx => ref(ctx), emergencyInput: ctx => emergencyInput(self(), ctx),
    guardOff: ctx => modeStatus(self(), ctx).reason === "context guard off", tokens: () => self().state.tokens, relaunchSent: () => self().state.relaunchSent });
}

/** Hooks are created in the original registration order; their callbacks read the runtime lazily. */
function createHooks(pi: ExtensionAPI, base: { agentDir: string; configFile: string; log: EventLog }, launchFacts: () => LaunchFacts, self: () => Runtime) {
  const memoryDeps = { ...base, host: () => self().host };
  const intent = createIntentHook(pi, memoryDeps), recall = createRecallHook(pi, memoryDeps);
  const resume = createResumeHook({ ...memoryDeps, observe: ctx => autoState(self(), ctx),
    store: ctx => intent.readStore(ctx), command: ctx => checkCommand(self(), ctx) });
  const requests = createRequestsHook({ ...memoryDeps, hasTools: () => hasActiveTools(pi) });
  const journal = wire(requests, { ...memoryDeps, launchFacts });
  return { intent, recall, resume, requests, journal };
}

export async function createRuntime(pi: ExtensionAPI, { agentDir, hosts, launchFacts }: RuntimeOptions): Promise<Runtime> {
  const stateDir = resolve(process.env.PI_CONTEXT_BUDGET_STATE_DIR || join(agentDir, "context-budget"));
  const configFile = resolve(process.env.PI_CONTEXT_BUDGET_CONFIG || join(agentDir, "context-budget.json"));
  let rt: Runtime | undefined;
  const self = () => rt!;
  const log = eventLog(stateDir);
  const overflow = createOverflow(pi, log, self);
  const isGuardOff = await loadGuard(agentDir);
  const hooks = createHooks(pi, { agentDir, configFile, log }, launchFacts, self);
  rt = { pi, agentDir, stateDir, configFile, hosts, isGuardOff, knownIds: new Set<string>(), log,
    config: parseConfig({}), state: initialState(), host: undefined, sequence: 0, handoffRejections: 0,
    resumeBoundary: undefined, resumeMessage: undefined, mismatchLogged: undefined, overflow, ...hooks };
  return rt;
}
