import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { REQUEST_MARKER } from "./render-requests.ts";

type BeforeEvent = { preparation?: unknown; customInstructions?: string; signal?: AbortSignal; reason?: string };
type CompactEvent = { compactionEntry?: { id?: string; summary?: string } };
type CarrierDeps = { render: (ctx: ExtensionContext) => Promise<string>;
  summarize?: (event: BeforeEvent, ctx: ExtensionContext) => Promise<CompactionResult> };

/** The runtime's own lower-level summarizer, not ctx.compact() (which would recursively re-enter the hook).
 * The registry stream retains provider request-time authentication and registered provider implementations.
 */
async function summarize(event: BeforeEvent, ctx: ExtensionContext): Promise<CompactionResult> {
  const { compact } = await import("@earendil-works/pi-coding-agent");
  if (!ctx.model || !event.preparation) throw Error("Request carrier requires native compaction preparation and model");
  return compact(event.preparation as Parameters<typeof compact>[0], ctx.model, undefined, undefined,
    event.customInstructions, event.signal, ctx.thinkingLevel,
    (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options));
}
function embed(result: SessionBeforeCompactResult, block: string): SessionBeforeCompactResult {
  if (!result.compaction || result.compaction.summary.includes(REQUEST_MARKER)) return result;
  return { ...result, compaction: { ...result.compaction, summary: `${result.compaction.summary}\n\n${block}` } };
}
/** One carrier per committed compaction entry. The summary is primary; idle custom messages are fallback only. */
export function createCarrier(deps: CarrierDeps) {
  const sent = new Set<string>();
  return {
    reset(): void { sent.clear(); },
    async beforeCompact(event: BeforeEvent, ctx: ExtensionContext, result: SessionBeforeCompactResult | undefined): Promise<SessionBeforeCompactResult | undefined> {
      if (result?.cancel) return result;
      const block = await deps.render(ctx);
      if (!block) return result;
      if (result?.compaction) return embed(result, block);
      const compaction = await (deps.summarize ?? summarize)(event, ctx);
      // A human prompt may have arrived while the model was summarizing. It must not disappear at the cut.
      return embed({ compaction }, await deps.render(ctx));
    },
    async compacted(pi: ExtensionAPI, event: CompactEvent, ctx: ExtensionContext): Promise<void> {
      const entry = event.compactionEntry;
      if (!entry?.id || sent.has(entry.id)) return;
      if (entry.summary?.includes(REQUEST_MARKER)) { sent.add(entry.id); return; }
      // While streaming sendMessage queues, so it is not a safe next-request carrier.
      if (!ctx.isIdle()) return;
      const block = await deps.render(ctx);
      if (!block) return;
      pi.sendMessage({ customType: "context-budget-requests", content: block, display: true,
        details: { boundaryId: entry.id } }, { triggerTurn: false });
      sent.add(entry.id);
    },
  };
}
