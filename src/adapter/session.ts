/** Session (re)start: rebind the host, reset hooks and restore machine state from the branch. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoreHistory, type Handoff, type HistoryItem } from "../core.ts";
import { frame } from "./mode.ts";
import { status } from "./status.ts";
import { reload, type Runtime } from "./runtime.ts";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type Message = Extract<Entry, { type: "message" }>["message"];

function messageItems(m: Message): HistoryItem[] {
  if (m.role === "user") return [{ type: "input" }];
  if (m.role === "assistant") return [{ type: "usage", tokens: m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite }];
  if (m.role === "toolResult") return [{ type: "tool", handoff: m.toolName === "context_handoff" ? (m.details as { handoff?: Handoff })?.handoff : undefined, error: m.isError }];
  return [];
}

function historyItems(e: Entry): HistoryItem[] {
  if (e.type === "compaction") {
    const details = e.details as { kind?: string; source?: string } | undefined;
    return [{ type: "compaction", owned: details?.kind === "handoff", source: details?.source === "idle" ? "idle" : "budget" }];
  }
  return e.type === "message" ? messageItems(e.message) : [];
}

function resetHooks(rt: Runtime, ctx: ExtensionContext): void {
  rt.host?.release(); rt.host = rt.hosts.acquire(ctx.sessionManager.getSessionId()); rt.intent.start(ctx); rt.recall.start(ctx);
  reload(rt, ctx); rt.journal.reset(); rt.requests.reset(); rt.overflow.reset(ctx); rt.knownIds.clear(); rt.handoffRejections = 0;
  rt.resumeBoundary = rt.resumeMessage = rt.mismatchLogged = undefined;
}

export function reset(rt: Runtime, ctx: ExtensionContext): void {
  resetHooks(rt, ctx);
  const history = ctx.sessionManager.getBranch().flatMap(historyItems);
  rt.state = restoreHistory(history, frame(rt, ctx).mode);
  rt.sequence = Math.max(rt.sequence, rt.state.lastHandoff?.n ?? 0);
  status(rt, ctx);
}
