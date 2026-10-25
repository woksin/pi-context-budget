/** Bounded provider-overflow recovery, independent of threshold enforcement. */
import type { ExtensionAPI, ExtensionContext, BoundaryResult, ToolCallEventResult, SessionBeforeCompactResult, TurnEndEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { isContextOverflowError, guardOffCrossings, type Frame, type MachineEvent, type HandoffInput } from "./core.ts";

type ActionResult = BoundaryResult & ToolCallEventResult & SessionBeforeCompactResult;
type EventLog = (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void;
interface OverflowAdapter {
  pi: ExtensionAPI;
  log: EventLog;
  frame(ctx: ExtensionContext): Frame;
  refresh(ctx: ExtensionContext): void;
  guardOff(ctx: ExtensionContext): boolean;
  model(ctx: ExtensionContext): string;
  emergencyInput(ctx: ExtensionContext): HandoffInput;
  relaunchSent(): boolean;
  tokens(): number | null;
  run(event: MachineEvent, ctx: ExtensionContext): Promise<ActionResult | undefined>;
}
const OVERFLOW_CONTINUE = "The previous request exceeded the model's context window, so the session was compacted automatically. Continue the interrupted task from where you stopped; re-check state from files and git before relying on earlier results.";
const OVERFLOW_EXHAUSTED = "Context overflow persists after one automatic compact-and-retry; reduce context (/compact, /new) or switch to a larger-context model.";
type OverflowEpisode = { id: number; sessionId: string };
function assistantFailure(message: TurnEndEvent["message"]): "none" | "aborted" | "overflow" | "error" {
  if (message.role !== "assistant") return "none";
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason !== "error") return "none";
  if (isContextOverflowError(message.errorMessage ?? "")) return "overflow";
  return /context|overflow|too many tokens/i.test(message.errorMessage ?? "") ? "overflow" : "error";
}
export class OverflowRecovery {
  private pending = false;
  private attempted = false;
  private native = false;
  private mechanical = false;
  private episode = 0;
  private sessionId = "";
  private shutDown = false;
  private warnings = new GuardOffWarnings();
  private adapter: OverflowAdapter;
  constructor(adapter: OverflowAdapter) { this.adapter = adapter; }
  private invalidate(): void { this.pending = false; this.mechanical = false; this.episode++; }
  reset(ctx: ExtensionContext): void {
    this.invalidate(); this.attempted = this.native = this.shutDown = false;
    this.warnings.reset(); this.sessionId = ctx.sessionManager.getSessionId();
  }
  shutdown(): void { this.shutDown = true; this.invalidate(); }
  input(source: string | undefined): void {
    this.invalidate();
    if (source !== "extension") this.attempted = false;
  }
  private allowed(ctx: ExtensionContext): boolean {
    const config = this.adapter.frame(ctx).config;
    return config.mode !== "off" && config.overflowRecovery;
  }
  private current(ctx: ExtensionContext, episode: OverflowEpisode): boolean {
    if (this.shutDown || episode.id !== this.episode) return false;
    if (episode.sessionId !== this.sessionId || episode.sessionId !== ctx.sessionManager.getSessionId()) return false;
    this.adapter.refresh(ctx);
    return this.allowed(ctx);
  }
  async turn(event: TurnEndEvent, ctx: ExtensionContext): Promise<ActionResult | undefined> {
    const message = event.message, usage = message.role === "assistant" ? message.usage : undefined;
    const result = await this.adapter.run({ type: "turn_end", usage: usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : undefined,
      failure: assistantFailure(message) }, ctx);
    this.detect(message, ctx);
    this.warnings.observe(ctx, this.adapter, this.adapter.frame(ctx));
    return result;
  }
  private detect(message: TurnEndEvent["message"], ctx: ExtensionContext): void {
    if (!this.allowed(ctx)) { this.invalidate(); return; }
    if (message.role !== "assistant") return;
    if (message.stopReason === "aborted") { this.invalidate(); return; }
    if (message.stopReason !== "error") { this.invalidate(); this.attempted = false; return; }
    if (!isContextOverflowError(message.errorMessage ?? "")) return;
    this.invalidate();
    const error = (message.errorMessage ?? "").slice(0, 200);
    if (this.attempted) {
      this.adapter.log(ctx, "overflow_recovery_exhausted", { error });
      ctx.ui?.notify?.(OVERFLOW_EXHAUSTED, "error");
      return;
    }
    this.pending = true; this.native = false;
    this.adapter.log(ctx, "overflow_detected", { error, tokens: this.adapter.tokens(), model: this.adapter.model(ctx) });
  }
  nativeCompaction(ctx: ExtensionContext, reason: string): void {
    if (reason !== "overflow") return;
    if (!this.pending || this.native) return;
    this.native = true; this.invalidate();
    this.adapter.log(ctx, "overflow_native");
  }
  async settled(ctx: ExtensionContext, aborted: boolean): Promise<void> {
    if (aborted) { this.invalidate(); return; }
    if (!this.pending) return;
    this.adapter.refresh(ctx);
    if (!this.allowed(ctx)) { this.invalidate(); return; }
    if (this.native || this.adapter.relaunchSent()) { this.invalidate(); return; }
    this.pending = false; this.attempted = true;
    const episode = { id: this.episode, sessionId: this.sessionId };
    this.adapter.log(ctx, "overflow_compact_start", { mode: this.adapter.frame(ctx).mode });
    await this.compact(ctx, episode);
  }
  private compact(ctx: ExtensionContext, episode: OverflowEpisode): Promise<void> {
    return new Promise(done => {
      const onComplete = () => { this.complete(ctx, episode); done(); };
      const onError = (error: Error) => { void this.failed(ctx, episode, error).finally(done); };
      try { ctx.compact({ onComplete, onError }); }
      catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private complete(ctx: ExtensionContext, episode: OverflowEpisode): void {
    if (!this.current(ctx, episode)) return;
    this.adapter.log(ctx, "overflow_compacted", { method: this.mechanical ? "mechanical" : "native" });
    this.mechanical = false;
    this.adapter.log(ctx, "overflow_retry");
    try {
      if (ctx.isIdle()) this.adapter.pi.sendUserMessage(OVERFLOW_CONTINUE);
      else this.adapter.pi.sendUserMessage(OVERFLOW_CONTINUE, { deliverAs: "followUp" });
    } catch (error) { this.failure(ctx, String(error)); }
  }
  private async failed(ctx: ExtensionContext, episode: OverflowEpisode, error: Error): Promise<void> {
    if (!this.current(ctx, episode)) return;
    const benign = /Nothing to compact|Already compacted|cancel/i.test(error.message);
    if (this.canFallback(ctx, benign)) {
      this.mechanical = true;
      this.adapter.log(ctx, "overflow_compact_fallback", { error: error.message });
      await this.compact(ctx, episode);
      return;
    }
    this.mechanical = false;
    this.failure(ctx, error.message);
  }
  private canFallback(ctx: ExtensionContext, benign: boolean): boolean {
    if (benign || this.mechanical) return false;
    return this.adapter.frame(ctx).mode !== "enforce";
  }
  private failure(ctx: ExtensionContext, error: string): void {
    this.adapter.log(ctx, "overflow_recovery_failed", { error });
    ctx.ui?.notify?.(`Context overflow recovery failed: ${error}`, "error");
  }
  async beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, run: () => Promise<SessionBeforeCompactResult | undefined>): Promise<SessionBeforeCompactResult | undefined> {
    this.nativeCompaction(ctx, event.reason);
    return this.mechanicalCompaction(ctx, event.preparation) ?? run();
  }
  private mechanicalCompaction(ctx: ExtensionContext, preparation: SessionBeforeCompactEvent["preparation"]): SessionBeforeCompactResult | undefined {
    if (!this.mechanical || !preparation || !this.allowed(ctx)) return;
    if (this.adapter.frame(ctx).mode === "enforce") return;
    const input = this.adapter.emergencyInput(ctx);
    const summary = `# Emergency compaction after context overflow\n${input.goal}\n${input.facts}\n${input.next_step}\nCompaction instance: ${randomUUID()}\n`;
    return { compaction: { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
      details: { kind: "overflow-mechanical" } } };
  }
}
class GuardOffWarnings {
  private crossed = { handoff: false, hard: false };
  reset(): void { this.crossed = { handoff: false, hard: false }; }
  observe(ctx: ExtensionContext, adapter: OverflowAdapter, frame: Frame): void {
    if (!adapter.guardOff(ctx)) { this.reset(); return; }
    if (frame.config.mode === "off") return;
    const tokens = ctx.getContextUsage()?.tokens ?? null, t = frame.thresholds;
    const result = guardOffCrossings(this.crossed, tokens, t);
    this.crossed = result.crossed;
    for (const level of result.fired) adapter.log(ctx, "guard_off_threshold", { threshold: level, tokens, limit: t[level], configured: frame.config.mode, reason: "context guard off" });
  }
}
