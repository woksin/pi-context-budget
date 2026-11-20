/** Shared mutable adapter state: one runtime per extension instance, passed to every adapter module. */
import type { ExtensionAPI, ExtensionContext, BoundaryResult, ToolCallEventResult, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { parseConfig, type Config, type MachineState } from "../core.ts";
import type { SessionHosts } from "../storage.ts";
import type { OverflowRecovery } from "../overflow-recovery.ts";
import type { RequestsHook } from "../memory/requests-hook.ts";
import type { JournalHook } from "../memory/journal-hook.ts";
import type { createIntentHook } from "../memory/tools.ts";
import type { createRecallHook } from "../memory/recall.ts";
import type { createResumeHook } from "../memory/resume.ts";

export type ActionResult = BoundaryResult & ToolCallEventResult & SessionBeforeCompactResult;
export type Host = ReturnType<SessionHosts["acquire"]>;
export type EventLog = (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void;

export interface Runtime {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly stateDir: string;
  readonly configFile: string;
  readonly hosts: SessionHosts;
  readonly isGuardOff: ((name: string) => boolean) | undefined;
  readonly knownIds: Set<string>;
  readonly log: EventLog;
  config: Config;
  state: MachineState;
  host: Host | undefined;
  sequence: number;
  handoffRejections: number;
  resumeBoundary: string | undefined;
  resumeMessage: string | undefined;
  mismatchLogged: string | undefined;
  overflow: OverflowRecovery;
  intent: ReturnType<typeof createIntentHook>;
  recall: ReturnType<typeof createRecallHook>;
  resume: ReturnType<typeof createResumeHook>;
  requests: RequestsHook;
  journal: JournalHook;
}

/** Wrap an event handler so adapter failures are logged instead of propagating into pi. */
export function guarded(log: EventLog) {
  return <E, R>(handler: (event: E, ctx: ExtensionContext) => R | Promise<R>) => async (event: E, ctx: ExtensionContext): Promise<R | undefined> => {
    try { return await handler(event, ctx); } catch (error) { log(ctx, "hook_error", { error: String(error) }); }
  };
}

export function reload(rt: Runtime, ctx: ExtensionContext): void {
  rt.journal.reload(ctx); rt.requests.reload();
  try { rt.config = parseConfig(existsSync(rt.configFile) ? JSON.parse(readFileSync(rt.configFile, "utf8")) : {}); }
  catch (error) { rt.config = parseConfig({}); rt.log(ctx, "config_error", { error: error instanceof SyntaxError ? "invalid_json" : "unreadable", mode: "observe" }); }
}
