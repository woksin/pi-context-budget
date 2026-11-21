import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommands } from "./commands.ts";
import { MEMORY_DISABLED } from "./config.ts";
import { singleLine } from "./render.ts";
import { requireVisibleItems } from "./scope.ts";
import type { MemoryStoreCore } from "./store.ts";
import type { IntentServices } from "./tools.ts";
import { newId, type FoldedItem, type WriteResult } from "./types.ts";
import { requireValid, ValidationError } from "./validate.ts";
import { registerReviewBridge, ReviewFailure, type ReviewRequest, type ReviewReason } from "./review-bridge.ts";

export interface ReviewControls {
  reviewBlocked?: () => boolean;
  log?: (ctx: ExtensionContext, event: string, data: Record<string, unknown>) => void;
}
function proposed(store: MemoryStoreCore, ctx: ExtensionContext, id: string): FoldedItem {
  const item = store.readFolded().items[id];
  requireVisibleItems(ctx, store, [id]);
  requireValid(item, "no_source"); requireValid(item.status === "proposed", "not_proposed");
  return item;
}
function humanSource(store: MemoryStoreCore, item: FoldedItem): void {
  if (item.kind === "directive") requireValid(store.getMessage(item.source.ref!)?.origin === "human", "not_human");
}
function write(runtime: IntentServices, ctx: ExtensionContext, store: MemoryStoreCore, { item, action }: { item: FoldedItem; action: string }): WriteResult {
  const actor = runtime.actor(ctx, true);
  if (action === "confirm") return store.confirm(item.id, actor);
  const entry = { id: newId(), at: new Date(Math.max(Date.now(), Date.parse(item.at) + 1)).toISOString(),
    session: { id: ctx.sessionManager.getSessionId(), role: "main" as const }, cwd: ctx.cwd,
    origin: "human" as const, originEvidence: ["tui-confirm"], text: `/memory reject ${item.id}`, withheld: null, redactions: [] };
  store.appendMessage(entry);
  return store.retireItem(item.id, "rejected", "Rejected by user", { type: "user_message", ref: entry.id }, actor);
}
async function legacyPrompt(ctx: ExtensionCommandContext, item: FoldedItem): Promise<boolean> {
  if (ctx.mode !== "tui" || typeof ctx.ui?.confirm !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 30_000); });
    const answer = await Promise.race([ctx.ui.confirm("Authorise memory item", `${singleLine(item.text)}\nsource: ${item.source.ref ?? item.id}`, { timeout: 30_000 }), timeout]);
    return answer === true && ctx.mode === "tui";
  } catch { return false; }
  finally { clearTimeout(timer); }
}
function promptText(request: ReviewRequest, item: FoldedItem): string {
  return [`Memory review: ${request.action}`, `item: ${singleLine(item.id)}`, `kind: ${singleLine(item.kind)}`,
    `scope: ${singleLine(item.scope.kind)}:${singleLine(item.scope.key)}`, `source: ${singleLine(JSON.stringify(item.source))}`,
    `canonical text: ${singleLine(item.text)}`].join("\n");
}
function fingerprint(store: MemoryStoreCore, item: FoldedItem): string {
  return JSON.stringify({ item, source: item.source.ref ? store.getMessage(item.source.ref) : null });
}
function storeId(runtime: IntentServices): string {
  const home = resolve(process.env.PI_MEMORY_HOME || join(runtime.agentDir, "memory"));
  let canonical = home;
  try { canonical = realpathSync(home); } catch { /* Uncreated stores still have a stable configured identity. */ }
  return createHash("sha256").update(canonical).digest("hex");
}
function nativeReviewUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui?.select === "function";
}
function reviewError(error: unknown): never {
  if (error instanceof ReviewFailure) throw error;
  const known: ReviewReason[] = ["no_source", "not_proposed", "not_human"];
  if (error instanceof ValidationError && known.includes(error.message as ReviewReason)) throw new ReviewFailure(error.message as ReviewReason);
  throw new ReviewFailure("unavailable");
}

/** Owns the native contexts; the only exported entry point is extension registration. */
export function registerIntentReview(pi: ExtensionAPI, runtime: IntentServices, controls: ReviewControls): () => void {
  let context: ExtensionContext | undefined, sessionId: string | undefined, generation: string | undefined;
  let suspended = true;
  let invalidate: (reason: ReviewReason) => void = () => {};
  const suspend = () => { suspended = true; generation = newId(); invalidate("wrong_target"); };
  const bind = (ctx: ExtensionContext) => {
    suspend(); context = ctx; sessionId = ctx.sessionManager.getSessionId(); suspended = false;
  };
  const reason = (): ReviewReason | undefined => {
    if (!context || suspended) return "unavailable";
    if (!runtime.enabled(context)) return "unavailable";
    if (!nativeReviewUI(context)) return "unavailable";
    if (!controls.reviewBlocked) return "unavailable";
    if (controls.reviewBlocked()) return "handoff";
  };
  const readiness = () => {
    const failure = reason();
    return { storeId: storeId(runtime), sessionId, generation, available: !failure, ...(failure ? { reason: failure } : {}) };
  };
  function checkTarget(request: ReviewRequest): ExtensionContext {
    const failure = reason(); if (failure) throw new ReviewFailure(failure);
    const sameTarget = request.sessionId === sessionId && request.generation === generation;
    if (!sameTarget) throw new ReviewFailure("wrong_target");
    if (context!.sessionManager.getSessionId() !== sessionId) throw new ReviewFailure("wrong_target");
    return context!;
  }
  async function review(request: ReviewRequest, check: () => void, signal: AbortSignal, committed: (write: WriteResult) => void): Promise<WriteResult> {
    try {
      check(); const ctx = checkTarget(request), identity = storeId(runtime);
      const store = await runtime.store(ctx), item = proposed(store, ctx, request.itemId);
      humanSource(store, item);
      const snapshot = fingerprint(store, item);
      check(); checkTarget(request);
      const answer = await ctx.ui.select(promptText(request, item), ["Refuse", "Yes, authorise"], { timeout: 30_000, signal });
      check(); checkTarget(request);
      if (answer !== "Yes, authorise") throw new ReviewFailure("refused");
      const currentStore = await runtime.store(ctx);
      check(); checkTarget(request);
      const current = proposed(currentStore, ctx, request.itemId);
      humanSource(currentStore, current);
      check(); checkTarget(request);
      if (storeId(runtime) !== identity || fingerprint(currentStore, current) !== snapshot) throw new ReviewFailure("stale");
      const result = write(runtime, ctx, currentStore, { item: current, action: request.action });
      committed(result); return result;
    } catch (error) { return reviewError(error); }
  }
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => { bind(ctx); });
    pi.on("session_tree", (_event, ctx) => { bind(ctx); });
    pi.on("session_compact", (_event, ctx) => { bind(ctx); });
    pi.on("session_compact_failed", (_event, ctx) => { bind(ctx); });
    pi.on("session_before_switch", suspend);
    pi.on("session_before_tree", suspend);
    pi.on("session_before_compact", suspend);
    pi.on("session_shutdown", suspend);
  }
  invalidate = registerReviewBridge(pi, { readiness, review, record: result => {
    if (context) controls.log?.(context, "memory_review_result", result);
  } });
  return () => registerLegacyIntentCommands(pi, runtime);
}

/** Keep the existing two-argument slash-command registration API. */
export function registerLegacyIntentCommands(pi: ExtensionAPI, runtime: IntentServices): void {
  registerMemoryCommands(pi, runtime, async (ctx, { verb, id }) => {
    const store = await runtime.store(ctx), item = proposed(store, ctx, id);
    if (verb === "confirm") humanSource(store, item);
    requireValid(await legacyPrompt(ctx, item), "refused: interactive TUI confirmation required, cancelled or unavailable");
    requireValid(runtime.enabled(ctx), MEMORY_DISABLED);
    return write(runtime, ctx, store, { item, action: verb });
  });
}
