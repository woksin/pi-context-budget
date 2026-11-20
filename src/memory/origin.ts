import { isSubagent } from "../core.ts";
import type { JournalEntry, Origin } from "./types.ts";
import { laneSender, syntheticInput } from "./synthetic.ts";

/** Adapter facts, not input-event fields or model/tool arguments. Missing facts never grant trust.
 * Launch texts are the exact assembled CLI input (including @file wrappers and continuation),
 * supplied by the adapter before input hooks run. firstInput counts inputs, not human decisions.
 */
export type OriginContext = {
  hasUI?: boolean;
  hostSubagent?: boolean;
  identity?: { sessionId: string; primarySessionId: string };
  firstInput?: boolean;
  initialPrompt?: string;
  relaunchPrompt?: string;
};
type Provenance = Pick<JournalEntry, "originEvidence" | "injectedKind" | "injectedFrom">;
export type OriginDecision = Provenance & (
  { journal: false; origin?: never } | { journal: true; origin: Origin }
);

function knownMain(context: OriginContext): boolean {
  const identity = context.identity;
  return context.hostSubagent === false && !!identity?.sessionId && !!identity.primarySessionId && !isSubagent(identity);
}

/** Pure origin gate. No persistence, config reads or runtime registration; S3b owns flag gating. */
export function classifyOrigin(input: { text: string; source?: unknown }, context: OriginContext): OriginDecision {
  const source = ["interactive", "rpc", "extension"].includes(input.source as string) ? input.source : "unknown";
  const originEvidence = [`source=${source}`, `hasUI=${context.hasUI === true}`];
  const decide = (origin: Origin, reason: string, extra: Partial<Provenance> = {}): OriginDecision =>
    ({ journal: true, origin, ...extra, originEvidence: [...originEvidence, reason] });

  if (context.hostSubagent === true || (context.identity && isSubagent(context.identity))) {
    return { journal: false, originEvidence: [...originEvidence, "child-session"] };
  }
  const synthetic = syntheticInput(input.text);
  if (source === "extension") {
    return decide("injected", synthetic ? `extension-input;synthetic=${synthetic.name}` : "extension-input", {
      injectedKind: synthetic?.kind ?? "unknown", injectedFrom: laneSender(input.text),
    });
  }
  if (synthetic) {
    return decide("injected", `synthetic=${synthetic.name}`, { injectedKind: synthetic.kind, injectedFrom: synthetic.from });
  }
  if (source !== "interactive" || context.hasUI !== true) return decide("unattended", "not-interactive-ui");
  if (context.firstInput === true) {
    if (input.text === context.relaunchPrompt) return decide("launch", "relaunch-prompt", { injectedKind: "relaunch" });
    if (input.text === context.initialPrompt) return decide("launch", "initial-cli-prompt", { injectedKind: "brief" });
  }
  if (typeof context.firstInput !== "boolean") return decide("unattended", "input-position-unverified");
  if (!knownMain(context)) return decide("unattended", "main-session-unverified");
  return decide("human", "verified-main;not-launch;not-synthetic");
}
