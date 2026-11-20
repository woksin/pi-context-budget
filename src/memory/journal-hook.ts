import { classifyOrigin, type OriginContext } from "./origin.ts";
import { flagOn, type MemoryConfig } from "./config.ts";
import { loadScanner, redact, type Scanner } from "./redact.ts";
import { newId, type JournalEntry } from "./types.ts";
import type { FileMemoryStore } from "./store.ts";

type InputEvent = { text: string; source?: unknown };
type HookContext = { cwd: string; hasUI?: boolean;
  sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined; getSessionName?(): string | undefined } };
/** Trusted adapter facts only; never derived from input text, tool arguments or model claims. */
export type HostFacts = { subagent?: boolean; primarySessionId?: string; launch?: Pick<OriginContext, "initialPrompt" | "relaunchPrompt"> };
export type JournalHookDeps = {
  agentDir: string;
  config: () => MemoryConfig;
  host: () => HostFacts | undefined;
  log: (ctx: HookContext, event: string, data?: Record<string, unknown>) => void;
};
export type JournalHook = { onInput(event: InputEvent, ctx: HookContext): Promise<void>; reset(): void };

const brief = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 200);

/** Inert unless `memory.journal` is on for this session at call time. Never throws into pi; the store is loaded lazily. */
export function createJournalHook(deps: JournalHookDeps): JournalHook {
  let firstInput = true, scanner: Promise<Scanner | undefined> | undefined, store: Promise<FileMemoryStore> | undefined;
  const scanners = () => scanner ??= loadScanner(deps.agentDir);
  const stores = () => store ??= import("./store.ts").then(({ FileMemoryStore }) => new FileMemoryStore({ agentDir: deps.agentDir }));

  function originContext(ctx: HookContext, position: boolean): OriginContext {
    const facts = deps.host(), id = ctx.sessionManager.getSessionId();
    return { hasUI: ctx.hasUI, hostSubagent: facts?.subagent, firstInput: position,
      identity: facts?.primarySessionId ? { sessionId: id, primarySessionId: facts.primarySessionId } : undefined,
      initialPrompt: facts?.launch?.initialPrompt, relaunchPrompt: facts?.launch?.relaunchPrompt };
  }
  async function journal(event: InputEvent, ctx: HookContext, position: boolean): Promise<void> {
    const name = ctx.sessionManager.getSessionName?.();
    if (!flagOn(deps.config(), name, "journal") || typeof event.text !== "string") return;
    const decision = classifyOrigin(event, originContext(ctx, position));
    if (!decision.journal) return;
    const body = redact(event.text, await scanners());
    const entry: Omit<JournalEntry, "schema" | "textBytes" | "sha256" | "blob"> = {
      id: newId(), at: new Date().toISOString(), cwd: ctx.cwd, origin: decision.origin, originEvidence: decision.originEvidence,
      session: { id: ctx.sessionManager.getSessionId(), role: "main", file: ctx.sessionManager.getSessionFile?.() },
      ...(name ? { lane: name } : {}),
      ...(decision.injectedKind ? { injectedKind: decision.injectedKind } : {}),
      ...(decision.injectedFrom ? { injectedFrom: decision.injectedFrom } : {}), ...body,
    };
    (await stores()).appendMessage(entry);
  }
  return {
    reset: () => { firstInput = true; },
    async onInput(event, ctx) {
      const position = firstInput;
      firstInput = false;
      try { await journal(event, ctx, position); }
      catch (error) {
        try { deps.log(ctx, "journal_error", { error: brief(error) }); } catch { /* Logging must not escape either. */ }
      }
    },
  };
}
