import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyOrigin, type OriginContext } from "./origin.ts";
import { flagOn, memoryOff, readMemoryConfig, type MemoryConfig } from "./config.ts";
import { loadScanner, redact, type Scanner } from "./redact.ts";
import { newId, type JournalEntry } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileMemoryStore } from "./store.ts";

type InputEvent = { text: string; source?: unknown };
type HookContext = { cwd: string; hasUI?: boolean;
  sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getSessionName?(): string | undefined } };
/** Trusted adapter facts only; never derived from input text, tool arguments or model claims. */
export type HostFacts = { subagent?: boolean; primarySessionId?: string; launch?: Pick<OriginContext, "initialPrompt" | "relaunchPrompt"> };
export type JournalHookDeps = {
  agentDir: string;
  configFile: string;
  host: () => HostFacts | undefined;
  /** Verified launch facts from argv/TTY (launch.ts); trusted host facts win. */
  launchFacts?: () => HostFacts["launch"];
  /** Called after a journal entry is durable; must not throw. */
  onJournaled?: (entry: JournalEntry, ctx: HookContext) => Promise<void>;
  log: (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void;
};
export type JournalHook = { reload(ctx: HookContext): void; onInput(event: InputEvent, ctx: HookContext): Promise<void>; reset(): void;
  /** Daily bounded journal prune; inert unless the journal is on for this session. Never throws. */
  retention(ctx: HookContext): Promise<void> };

/** Metadata is attacker-influenced text too: redact it, and omit it when redaction fails. */
function injectedFrom(value: string | undefined, scanner: Scanner | undefined): { injectedFrom?: string } {
  if (!value) return {};
  const { text } = redact(value, scanner);
  return text ? { injectedFrom: text } : {};
}
const brief = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 200);

/** Inert unless `memory.journal` is on for this session at call time. Never throws into pi; the store is loaded lazily. */
export function createJournalHook(deps: JournalHookDeps): JournalHook {
  let memory: MemoryConfig = memoryOff(), reasons = "";
  let firstInput = true, scanner: Promise<Scanner | undefined> | undefined, store: Promise<FileMemoryStore> | undefined;
  const scanners = () => scanner ??= loadScanner(deps.agentDir);
  const onJournaled = deps.onJournaled ?? (async () => {});
  const stores = () => store ??= import("./store.ts").then(({ FileMemoryStore }) => new FileMemoryStore({ agentDir: deps.agentDir }));

  function originContext(ctx: HookContext, position: boolean): OriginContext {
    const facts = deps.host(), id = ctx.sessionManager.getSessionId(), launch = facts?.launch ?? deps.launchFacts?.();
    return { hasUI: ctx.hasUI, hostSubagent: facts?.subagent, firstInput: position,
      identity: facts?.primarySessionId ? { sessionId: id, primarySessionId: facts.primarySessionId } : undefined,
      initialPrompt: launch?.initialPrompt, relaunchPrompt: launch?.relaunchPrompt };
  }
  async function journal(event: InputEvent, ctx: HookContext, position: boolean): Promise<void> {
    const name = ctx.sessionManager.getSessionName?.();
    if (!flagOn(memory, name, "journal") || typeof event.text !== "string") return;
    const decision = classifyOrigin(event, originContext(ctx, position));
    if (!decision.journal) return;
    const scanner = await scanners(), body = redact(event.text, scanner);
    const entry: Omit<JournalEntry, "schema" | "textBytes" | "sha256" | "blob"> = {
      id: newId(), at: new Date().toISOString(), cwd: ctx.cwd, origin: decision.origin, originEvidence: decision.originEvidence,
      session: { id: ctx.sessionManager.getSessionId(), role: "main", file: ctx.sessionManager.getSessionFile?.() },
      ...(name ? { lane: name } : {}),
      ...(decision.injectedKind ? { injectedKind: decision.injectedKind } : {}),
      ...injectedFrom(decision.injectedFrom, scanner), ...body,
    };
    const stored = (await stores()).appendMessage(entry);
    await onJournaled(stored, ctx);
  }
  /** Fixed reason codes only; config excerpts and exception text never reach the log. */
  function reload(ctx: HookContext): void {
    const parsed = readMemoryConfig(deps.configFile);
    memory = parsed.config;
    const joined = parsed.reasons.join("; ");
    if (joined === reasons) return;
    reasons = joined;
    if (joined) deps.log(ctx as ExtensionContext, "memory_config_invalid", { reasons: parsed.reasons, memory: "off" });
  }
  /** Same fold options as the intent store, so liveness is judged exactly as the product sees it. */
  async function prune(ctx: HookContext): Promise<void> {
    const name = ctx.sessionManager.getSessionName?.();
    if (!flagOn(memory, name, "journal")) return;
    const [{ FileMemoryStore, memoryHome }, { eligibilityCheck }, { retentionPass }] =
      await Promise.all([import("./store.ts"), import("./authorize.ts"), import("./retention.ts")]);
    const home = memoryHome({ agentDir: deps.agentDir });
    if (!existsSync(join(home, "journal"))) return; // Nothing to prune; never create the store just for this.
    const store = new FileMemoryStore({ home, eligibilityCheck, coordinators: memory.coordinators });
    const result = retentionPass({ home, state: () => store.readFolded(), requestsOn: flagOn(memory, name, "requests"),
      days: memory.retentionDays, currentSessionId: ctx.sessionManager.getSessionId() });
    if (result) deps.log(ctx as ExtensionContext, "journal_pruned", { examined: result.examined, removed: result.removed,
      kept: result.kept, protected: result.protectedCount, errors: result.errors, capped: result.capped });
  }
  return {
    reload,
    async retention(ctx) {
      try { reload(ctx); await prune(ctx); }
      catch (error) {
        try { deps.log(ctx as ExtensionContext, "journal_error", { error: brief(error) }); } catch { /* Logging must not escape either. */ }
      }
    },
    reset: () => { firstInput = true; },
    async onInput(event, ctx) {
      const position = firstInput;
      firstInput = false;
      try { await journal(event, ctx, position); }
      catch (error) {
        try { deps.log(ctx as ExtensionContext, "journal_error", { error: brief(error) }); } catch { /* Logging must not escape either. */ }
      }
    },
  };
}
