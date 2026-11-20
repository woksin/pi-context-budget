import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { IntentServices } from "./tools.ts";
import type { FoldedItem, MessageInput, WriteResult } from "./types.ts";
import { newId } from "./types.ts";
import { loadScanner, redact } from "./redact.ts";
import { singleLine } from "./render.ts";
import { flagOn, memoryOff, MEMORY_DISABLED } from "./config.ts";
import { laneVisible, listVisibleItems, requireVisibleItems } from "./scope.ts";
import { requireValid, ValidationError } from "./validate.ts";

function tell(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
  if (ctx.mode === "tui") ctx.ui.notify(text, "info");
  else pi.sendMessage({ customType: "memory", content: text, display: true });
}
async function confirmed(ctx: ExtensionCommandContext, text: string, source: string): Promise<boolean> {
  if (ctx.mode !== "tui" || typeof ctx.ui?.confirm !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 30_000); });
    const answer = await Promise.race([ctx.ui.confirm("Authorise memory item", `${singleLine(text)}\nsource: ${source}`, { timeout: 30_000 }), timeout]);
    return answer === true && ctx.mode === "tui";
  } catch { return false; }
  finally { clearTimeout(timer); }
}
function journal(ctx: ExtensionCommandContext, text: string, id: string, after = 0): MessageInput {
  return { id, at: new Date(Math.max(Date.now(), after + 1)).toISOString(),
    session: { id: ctx.sessionManager.getSessionId(), role: "main" }, cwd: ctx.cwd,
    origin: "human", originEvidence: ["tui-confirm"], text, withheld: null, redactions: [] };
}
async function direct(runtime: IntentServices, text: string, ctx: ExtensionCommandContext): Promise<WriteResult> {
  requireValid(text.trim().length > 0, "invalid_item");
  const redacted = redact(text, await loadScanner(runtime.agentDir));
  requireValid(redacted.text !== null, "too_large");
  const id = newId();
  requireValid(await confirmed(ctx, redacted.text, id), "refused: interactive TUI confirmation required, cancelled or unavailable");
  requireValid(runtime.enabled(ctx), MEMORY_DISABLED);
  const store = await runtime.store(ctx), body = "/directive " + redacted.text;
  store.appendMessage({ ...journal(ctx, body, id), redactions: redacted.redactions });
  return store.addItem({ id: newId(), kind: "directive", scope: { kind: "session", key: ctx.sessionManager.getSessionId() },
    text: redacted.text, source: { type: "user_message", ref: id, span: { start: 11, end: body.length } },
    authority: { mode: "command", ruleVersion: 1, commandRef: id }, supersedes: [] }, runtime.actor(ctx, true));
}
async function proposed(runtime: IntentServices, ctx: ExtensionCommandContext, id: string): Promise<FoldedItem> {
  const store = await runtime.store(ctx), item = store.readFolded().items[id];
  requireVisibleItems(ctx, store, [id]);
  requireValid(item, "no_source"); requireValid(item.status === "proposed", "not_proposed");
  return item;
}
async function authorise(runtime: IntentServices, ctx: ExtensionCommandContext, verb: string, id: string): Promise<WriteResult> {
  const item = await proposed(runtime, ctx, id), store = await runtime.store(ctx);
  if (verb === "confirm" && item.kind === "directive") requireValid(store.getMessage(item.source.ref!)?.origin === "human", "not_human");
  requireValid(await confirmed(ctx, item.text, item.source.ref ?? id), "refused: interactive TUI confirmation required, cancelled or unavailable");
  requireValid(runtime.enabled(ctx), MEMORY_DISABLED);
  const actor = runtime.actor(ctx, true);
  if (verb === "confirm") return store.confirm(id, actor);
  const entry = journal(ctx, `/memory reject ${id}`, newId(), Date.parse(item.at));
  store.appendMessage(entry);
  return store.retireItem(id, "rejected", "Rejected by user", { type: "user_message", ref: entry.id }, actor);
}
const PURGE_USAGE = "Use /memory purge [--days N] [--dry-run]";
const parseDays = (raw: string | undefined): number => {
  requireValid(raw !== undefined && /^\d{1,4}$/u.test(raw) && Number(raw) >= 1 && Number(raw) <= 3650, PURGE_USAGE);
  return Number(raw);
};
/** Strict: only `--days N` (integer 1..3650) and `--dry-run`, each at most once. */
export function parsePurgeArgs(args: string[]): { days?: number; dryRun: boolean } {
  const parsed: { days?: number; dryRun: boolean } = { dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    requireValid((flag === "--dry-run" && !parsed.dryRun) || (flag === "--days" && parsed.days === undefined), PURGE_USAGE);
    if (flag === "--dry-run") parsed.dryRun = true;
    else parsed.days = parseDays(args[++index]);
  }
  return parsed;
}
async function purge(runtime: IntentServices, ctx: ExtensionCommandContext, args: string[]): Promise<string> {
  const options = parsePurgeArgs(args), config = runtime.memoryConfig?.() ?? memoryOff(), name = ctx.sessionManager.getSessionName?.();
  requireValid(flagOn(config, name, "journal"), MEMORY_DISABLED);
  const [{ pruneJournals }, { memoryHome }] = await Promise.all([import("./retention.ts"), import("./store.ts")]);
  const store = await runtime.store(ctx);
  const result = pruneJournals({ home: memoryHome({ agentDir: runtime.agentDir }), state: store.readFolded(), requestsOn: flagOn(config, name, "requests"),
    days: options.days ?? config.retentionDays, currentSessionId: ctx.sessionManager.getSessionId(), dryRun: options.dryRun });
  const count = options.dryRun ? `would remove ${result.wouldRemove}` : `removed ${result.removed}`;
  return `purge: ${count}, kept ${result.kept} (protected ${result.protectedCount}), errors ${result.errors}${result.capped ? ", capped: run again to continue" : ""}`;
}
function handler(pi: ExtensionAPI, runtime: IntentServices, action: (text: string, ctx: ExtensionCommandContext) => Promise<unknown>) {
  return async (text: string, ctx: ExtensionCommandContext) => {
    try {
      requireValid(runtime.enabled(ctx), MEMORY_DISABLED);
      const result = await action(text, ctx); tell(pi, ctx, typeof result === "string" ? result : JSON.stringify(result));
    } catch (error) {
      tell(pi, ctx, error instanceof ValidationError ? error.message : "memory unavailable");
    }
  };
}
export function registerIntentCommands(pi: ExtensionAPI, runtime: IntentServices): void {
  pi.registerCommand("directive", { description: "Record a directive after interactive confirmation",
    handler: handler(pi, runtime, (text, ctx) => direct(runtime, text, ctx)) });
  pi.registerCommand("memory", { description: "confirm|reject <id>, list [id], purge [--days N] [--dry-run]",
    handler: handler(pi, runtime, async (text, ctx) => {
      const [verb, id, ...rest] = text.trim().split(/\s+/u);
      if (verb === "purge") return purge(runtime, ctx, [...(id ? [id] : []), ...rest]);
      if (verb === "list") {
        const store = await runtime.store(ctx);
        if (id) {
          const item = store.readFolded().items[id];
          return item && laneVisible(ctx, item.scope) ? item : undefined;
        }
        return listVisibleItems(ctx, store, { limit: 50 });
      }
      requireValid(["confirm", "reject"].includes(verb) && id, "Use /memory confirm|reject <id> or /memory list");
      return authorise(runtime, ctx, verb, id);
    }) });
}
