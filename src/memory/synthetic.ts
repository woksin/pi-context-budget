import type { JournalEntry } from "./types.ts";

type Synthetic = { name: string; kind: NonNullable<JournalEntry["injectedKind"]>; from?: string };

/** Known user-role traffic from context-budget, provider-fallback, subagents and pi-orch.
 * Keep prefixes anchored: quoted examples inside ordinary human text are not senders.
 * A forged header is still synthetic, never evidence of human authority.
 */
const SYNTHETIC_TEXTS: readonly { name: string; kind: Synthetic["kind"]; pattern: RegExp }[] = [
  { name: "provider-continue", kind: "notice", pattern: /^\s*Provider limits have lifted \([^\n]*\)\. Continue where you stopped\.$/ },
  { name: "settle-recovery", kind: "notice", pattern: /^\s*Context recovery is required\. Call context_handoff\b/ },
  { name: "settle-idle", kind: "notice", pattern: /^\s*Pending background work remains and context is large\. Call context_handoff\b/ },
  { name: "handoff-retry", kind: "notice", pattern: /^\s*Re-call context_handoff with the same fields, corrected\./ },
  { name: "structured-retry", kind: "notice", pattern: /^\s*(?:You did not call StructuredOutput, so your answer was not recorded\.|Your last StructuredOutput call did not match the required schema:)/ },
  { name: "task-notification", kind: "notice", pattern: /^\s*<task-notification(?:\s|>)/ },
  { name: "overflow-continue", kind: "notice", pattern: /^\s*The previous request exceeded the model's context window, so the session was compacted automatically\. Continue the interrupted task/ },
  { name: "lane-header", kind: "lane_message", pattern: /^\s*\[orch(?:\s|\])/ },
];

/** Sender syntax matches pi-orch formatMessage, optionally wrapped by its reminder/maintenance prefix. */
export function laneSender(text: string): string | undefined {
  return /^\s*(?:\[orch (?:reminder|maintenance)\]\n)?\[orch [^\s\]]+ from ([^\]\r\n]+)\]/.exec(text)?.[1];
}

export function syntheticInput(text: string): Synthetic | undefined {
  const match = SYNTHETIC_TEXTS.find(entry => entry.pattern.test(text));
  if (!match) return undefined;
  return { name: match.name, kind: match.kind, ...(match.kind === "lane_message" ? { from: laneSender(text) } : {}) };
}
