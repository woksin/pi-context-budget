import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderRequests, type Delivery } from "./render-requests.ts";

type Projection = { boundaryId?: string; data: Delivery };
type CarrierDeps = { read: (ctx: ExtensionContext) => Promise<Projection | undefined> };

function afterDelivery(data: Delivery, delivered: Set<string>): Delivery {
  const answer = data.lastAnswer;
  if (!answer || !delivered.has(answer.id)) return data;
  return { ...data, lastAnswer: { ...answer, sameRunAsAnswer: false } };
}
const needed = (data: Delivery) => data.requests.length > 0 || data.lastAnswer?.sameRunAsAnswer;

/** Pi 1.2.0 `context` is a cloned per-LLM-call projection, not a transcript write.
 * Native compaction, routing/auth/retries and summaries are never intercepted here.
 */
export function createCarrier(deps: CarrierDeps) {
  const delivered = new Set<string>();
  return {
    reset(): void { delivered.clear(); },
    async context(event: ContextEvent, ctx: ExtensionContext): Promise<ContextEventResult | undefined> {
      try {
        const projection = await deps.read(ctx);
        if (!projection?.boundaryId) return;
        const data = afterDelivery(projection.data, delivered);
        if (!needed(data)) return;
        const content = renderRequests(data);
        if (data.lastAnswer?.sameRunAsAnswer) delivered.add(data.lastAnswer.id);
        return { messages: [...event.messages, { role: "custom", customType: "context-budget-requests", content,
          display: false, timestamp: Date.now(), details: { boundaryId: projection.boundaryId } }] };
      } catch { return; } // A projection failure must not cancel native compaction or a provider request.
    },
  };
}
