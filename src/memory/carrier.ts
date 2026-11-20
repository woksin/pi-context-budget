import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedBoundary } from "./boundary.ts";
import { renderRequests, type Delivery } from "./render-requests.ts";

type Projection = { boundary?: ResolvedBoundary; data: Delivery };
type CarrierDeps = { read: (ctx: ExtensionContext) => Promise<Projection | undefined> };

/** Only structured ownership counts; copied marker text never suppresses delivery.
 * Native threshold resets also use kind=emergency, while mechanical fallback needs a carrier.
 */
function summaryCarriesRequests(boundary: ResolvedBoundary, ctx: ExtensionContext): boolean {
  const event = boundary.event;
  if (["handoff", "idle", "hard"].includes(event.kind) || event.handoffPath) return true;
  if (!event.compactionEntryId) return false;
  const entry = ctx.sessionManager.getBranch?.().find(entry => entry.id === event.compactionEntryId);
  if (entry?.type !== "compaction") return false;
  const details = entry.details;
  return !!details && typeof details === "object" && "kind" in details && details.kind === "handoff";
}
function cutoffDelivery(data: Delivery, boundary: ResolvedBoundary, delivered: Set<string>): Delivery {
  const ids = new Set("ids" in boundary.open ? boundary.open.ids : []);
  const answer = data.lastAnswer;
  const carryAnswer = answer && answer.id === boundary.event.lastAnswerId && !delivered.has(answer.id);
  return { ...data, requests: data.requests.filter(request => ids.has(request.id)), lastAnswer: carryAnswer ? answer : undefined };
}
const needed = (data: Delivery) => data.requests.length > 0 || data.lastAnswer?.sameRunAsAnswer;

/** Pi 1.2.0 `context` is a cloned per-LLM-call projection, not a transcript write.
 * Native compaction, routing/auth/retries and summaries are never intercepted here.
 */
export function createCarrier(deps: CarrierDeps) {
  const delivered = new Set<string>();
  let pending: string | undefined;
  return {
    reset(): void { delivered.clear(); pending = undefined; },
    completed(stopReason: string | undefined): void {
      if (pending && ["stop", "toolUse", "length"].includes(stopReason ?? "")) delivered.add(pending);
      pending = undefined;
    },
    async context(event: ContextEvent, ctx: ExtensionContext): Promise<ContextEventResult | undefined> {
      pending = undefined;
      try {
        const projection = await deps.read(ctx);
        if (!projection?.boundary || summaryCarriesRequests(projection.boundary, ctx)) return;
        const data = cutoffDelivery(projection.data, projection.boundary, delivered);
        if (!needed(data)) return;
        const content = renderRequests(data);
        if (data.lastAnswer) pending = data.lastAnswer.id;
        return { messages: [...event.messages, { role: "custom", customType: "context-budget-requests", content,
          display: false, timestamp: Date.now(), details: { boundaryId: projection.boundary.event.id } }] };
      } catch { return; } // A projection failure must not cancel native compaction or a provider request.
    },
  };
}
