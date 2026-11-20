import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { flagOn, MEMORY_DISABLED, readMemoryConfig } from "./config.ts";
import { eligibilityCheck, recoverySteer } from "./authorize.ts";
import { registerIntentCommands } from "./commands.ts";
import { loadScanner, redact } from "./redact.ts";
import { requireValid, ValidationError } from "./validate.ts";
import { newId } from "./types.ts";
import { normaliseRepoScope, selectedHandoffScopes } from "./handoff-scopes.ts";
import type { Actor, ClassifyEvent, Item, ItemQuery, RetireEvent, Source, Span } from "./types.ts";
import type { MemoryStoreCore } from "./store.ts";

export type IntentDeps = { agentDir: string; configFile: string; host: () => { subagent: boolean } | undefined };
export interface IntentServices {
  enabled(ctx: ExtensionContext): boolean;
  store(ctx: ExtensionContext): Promise<MemoryStoreCore>;
  actor(ctx: ExtensionContext, human?: boolean): Actor;
  agentDir: string;
}
const reply = (details: unknown, text = JSON.stringify(details)) => ({ content: [{ type: "text" as const, text }], details });
const scopeSchema = { type: "object", properties: { kind: { type: "string", enum: ["global", "repo", "lane", "session", "task"] }, key: { type: "string" } }, required: ["kind", "key"] };
const sourceSchema = { type: "object", properties: { ref: { type: "string" }, span: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } }, required: ["start", "end"] } }, required: ["ref"] };
const textSchema = { type: "string" };
const schemas = {
  memory_add: { properties: { kind: { type: "string", enum: ["directive", "order", "decision"] }, scope: scopeSchema,
    text: textSchema, source: sourceSchema, gloss: textSchema, supersedes: { type: "array", items: textSchema } }, required: ["kind", "scope", "text"] },
  memory_retire: { properties: { itemId: textSchema, status: { type: "string", enum: ["done", "superseded", "withdrawn"] }, reason: textSchema, source: sourceSchema }, required: ["itemId", "status", "reason"] },
  memory_classify: { properties: { messageId: textSchema, whole: { enum: [null, "none"] }, reason: textSchema,
    spans: { type: "array", items: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" }, result: { enum: ["directive", "decision", "none"] }, itemIds: { type: "array", items: textSchema } }, required: ["start", "end", "result", "itemIds"] } } }, required: ["messageId", "spans"] },
  memory_list: { properties: { scopes: { type: "array", items: scopeSchema }, status: textSchema, kind: textSchema, cursor: textSchema, limit: { type: "integer", minimum: 1, maximum: 1000 } }, required: [] },
};
type AddInput = Pick<Item, "kind" | "scope" | "text" | "gloss" | "supersedes"> & { source?: { ref?: string; span?: Span } };
async function add(runtime: IntentServices, store: MemoryStoreCore, ctx: ExtensionContext, input: AddInput) {
  const source = itemSource(input), actor = runtime.actor(ctx);
  const selected = selectedHandoffScopes(ctx, store);
  const item: Item = { id: newId(), kind: input.kind, scope: normaliseRepoScope(input.scope, selected.repo), text: input.text, source,
    supersedes: input.supersedes ?? [] };
  if (input.gloss !== undefined) item.gloss = await safeText(runtime, input.gloss);
  if (input.kind === "directive") item.authority = { mode: "auto", ruleVersion: 1 };
  if (input.kind === "decision") item.text = await safeText(runtime, input.text);
  const result = store.addItem(item, actor);
  if (!result.ok) return reply(result, result.reason);
  const folded = store.readFolded().items[item.id]!;
  const selectedScopes = selectedHandoffScopes(ctx, store).scopes;
  const status = folded.status === "proposed" ? `proposed: user must confirm with /memory confirm ${item.id}` : JSON.stringify(folded);
  return reply({ ...result, item: folded, selectedScopes }, `${status}\nHandoff-selected scope keys: ${JSON.stringify(selectedScopes)}`);
}
function itemSource(input: AddInput): Source {
  if (input.kind === "decision") return { type: "agent_decision" };
  requireValid(input.source?.ref, "no_source");
  return { type: input.kind === "order" ? "coordinator_order" : "user_message", ref: input.source?.ref, span: input.source?.span };
}
async function safeText(runtime: IntentServices, text: string): Promise<string> {
  const result = redact(text, await loadScanner(runtime.agentDir));
  requireValid(result.text !== null, "too_large");
  return result.text;
}
async function operation(runtime: IntentServices, name: keyof typeof schemas, input: any, ctx: ExtensionContext) {
  const store = await runtime.store(ctx), actor = runtime.actor(ctx);
  switch (name) {
    case "memory_add": return add(runtime, store, ctx, input);
    case "memory_retire": {
      requireValid(["done", "superseded", "withdrawn"].includes(input.status), "invalid_retirement");
      const source: Source = input.source?.ref
        ? { type: "user_message", ref: input.source.ref } : { type: "agent_decision" };
      const result = store.retireItem(input.itemId, input.status as RetireEvent["status"], await safeText(runtime, input.reason), source, actor);
      return reply(result, result.ok ? undefined : result.reason);
    }
    case "memory_classify": {
      const result = store.classify({ messageId: input.messageId, spans: input.spans, whole: input.whole ?? null,
        reason: input.reason === undefined ? undefined : await safeText(runtime, input.reason) } as Omit<ClassifyEvent, "schema" | "id" | "at" | "actor" | "type">, actor);
      return reply(result, result.ok ? undefined : result.reason);
    }
    case "memory_list": return reply(store.list({ scopes: input.scopes, status: input.status, kind: input.kind,
      cursor: input.cursor, limit: input.limit ?? 50 } as ItemQuery));
  }
}
function registerTools(pi: ExtensionAPI, runtime: IntentServices) {
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    pi.registerTool({ name, label: name, description: "Intent memory. Cite journal spans for directives/orders; proposed directives need human confirmation.",
      parameters: { type: "object", ...schemas[name] } as any,
      async execute(_id, input, _signal, _update, ctx) {
        if (!runtime.enabled(ctx)) return reply({}, MEMORY_DISABLED);
        try { return await operation(runtime, name, input, ctx); }
        catch (error) {
          const reason = error instanceof ValidationError ? error.message : "memory unavailable";
          return reply({ ok: false, reason }, reason);
        }
      } });
  }
}
class IntentRuntime implements IntentServices {
  readonly agentDir: string;
  private readonly loaded: boolean;
  private registered = false;
  private pi: ExtensionAPI;
  private deps: IntentDeps;
  constructor(pi: ExtensionAPI, deps: IntentDeps) {
    this.pi = pi; this.deps = deps;
    this.agentDir = deps.agentDir;
    this.loaded = readMemoryConfig(deps.configFile).config.intent;
  }
  enabled(ctx: ExtensionContext): boolean {
    if (!this.loaded || this.deps.host()?.subagent !== false) return false;
    return flagOn(readMemoryConfig(this.deps.configFile).config, ctx.sessionManager.getSessionName?.(), "intent");
  }
  actor(ctx: ExtensionContext, human = false): Actor {
    return { kind: human ? "human" : "agent", id: ctx.sessionManager.getSessionId(), harness: "pi" };
  }
  async store(_ctx: ExtensionContext): Promise<MemoryStoreCore> {
    const { FileMemoryStore } = await import("./store.ts");
    return new FileMemoryStore({ home: process.env.PI_MEMORY_HOME || join(this.agentDir, "memory"), eligibilityCheck,
      coordinators: readMemoryConfig(this.deps.configFile).config.coordinators });
  }
  start(ctx: ExtensionContext): void {
    if (this.registered || !this.enabled(ctx)) return;
    // Role is authoritative only after the session host has bound; pi 1.2 supports post-bind registration.
    registerTools(this.pi, this); registerIntentCommands(this.pi, this);
    this.registered = true;
  }
  steer(ctx: ExtensionContext, text: string, idleOnly = false): string { return recoverySteer({ text, enabled: this.enabled(ctx), idleOnly }); }
}
export function createIntentHook(pi: ExtensionAPI, deps: IntentDeps) { return new IntentRuntime(pi, deps); }
