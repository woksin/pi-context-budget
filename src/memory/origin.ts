import { isSubagent } from "../core.ts";
import type { JournalEntry, Origin } from "./types.ts";
import { laneSender, syntheticInput } from "./synthetic.ts";

/** Adapter facts, not input-event fields or model/tool arguments. Missing facts never grant trust.
 * Launch texts are the exact assembled CLI input (including @file wrappers and continuation),
 * supplied by the adapter before input hooks run. null verifies none; undefined is unverified.
 * firstInput counts inputs, not human decisions. Always inspect untransformed input.
 */
export type OriginContext = {
  hasUI?: boolean;
  hostSubagent?: boolean;
  identity?: { sessionId: string; primarySessionId: string };
  firstInput?: boolean;
  initialPrompt?: string | null;
  relaunchPrompt?: string | null;
};
type Provenance = Pick<JournalEntry, "originEvidence" | "injectedKind" | "injectedFrom">;
export type OriginDecision = Provenance & (
  { journal: false; origin?: never } | { journal: true; origin: Origin }
);
type Input = { text: string; source?: unknown };
type Match = Pick<Provenance, "injectedKind" | "injectedFrom"> & { origin: Origin; reason: string };
type Facts = {
  text: string;
  source: string;
  context: OriginContext;
  synthetic: ReturnType<typeof syntheticInput>;
};

function normaliseSource(input: Input): string {
  return ["interactive", "rpc", "extension"].includes(input.source as string) ? input.source as string : "unknown";
}

function childSkip(context: OriginContext): boolean {
  if (context.hostSubagent === true) return true;
  return context.identity !== undefined && isSubagent(context.identity);
}

function knownMain(context: OriginContext): boolean {
  const identity = context.identity;
  return context.hostSubagent === false && !!identity?.sessionId && !!identity.primarySessionId && !isSubagent(identity);
}

function normaliseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function containsLaunch(text: string, prompts: (string | null)[]): boolean {
  const normalised = normaliseWhitespace(text);
  return prompts.some(prompt => {
    if (prompt === null) return false;
    const launch = normaliseWhitespace(prompt);
    return launch.length > 0 && normalised.includes(launch);
  });
}

function launchMatch(text: string, context: OriginContext): Match | undefined {
  if (context.firstInput !== true) return undefined;
  const { initialPrompt, relaunchPrompt } = context;
  if (initialPrompt === undefined || relaunchPrompt === undefined) {
    return { origin: "unattended", reason: "launch-unverified" };
  }
  if (text === relaunchPrompt) return { origin: "launch", reason: "relaunch-prompt", injectedKind: "relaunch" };
  if (text === initialPrompt) return { origin: "launch", reason: "initial-cli-prompt", injectedKind: "brief" };
  if (containsLaunch(text, [initialPrompt, relaunchPrompt])) return { origin: "unattended", reason: "launch-near-match" };
  return undefined;
}

function extensionMatch({ source, synthetic, text }: Facts): Match | undefined {
  if (source !== "extension") return undefined;
  return {
    origin: "injected", reason: synthetic ? `extension-input;synthetic=${synthetic.name}` : "extension-input",
    injectedKind: synthetic?.kind ?? "unknown", injectedFrom: laneSender(text),
  };
}

function syntheticMatch({ synthetic }: Facts): Match | undefined {
  if (!synthetic) return undefined;
  return { origin: "injected", reason: `synthetic=${synthetic.name}`, injectedKind: synthetic.kind, injectedFrom: synthetic.from };
}

// First matching rule wins. The final human rule makes the table exhaustive.
const RULES: readonly ((facts: Facts) => Match | undefined)[] = [
  extensionMatch,
  syntheticMatch,
  ({ source, context }) => source !== "interactive" || context.hasUI !== true
    ? { origin: "unattended", reason: "not-interactive-ui" } : undefined,
  ({ text, context }) => launchMatch(text, context),
  ({ context }) => typeof context.firstInput !== "boolean"
    ? { origin: "unattended", reason: "input-position-unverified" } : undefined,
  ({ context }) => !knownMain(context)
    ? { origin: "unattended", reason: "main-session-unverified" } : undefined,
  () => ({ origin: "human", reason: "verified-main;not-launch;not-synthetic" }),
];

function decide(match: Match, evidence: string[]): OriginDecision {
  const { reason, ...provenance } = match;
  return { journal: true, ...provenance, originEvidence: [...evidence, reason] };
}

/** Pure origin gate. No persistence, config reads or runtime registration; S3b owns flag gating. */
export function classifyOrigin(input: Input, context: OriginContext): OriginDecision {
  const facts: Facts = { text: input.text, source: normaliseSource(input), context, synthetic: syntheticInput(input.text) };
  const evidence = [`source=${facts.source}`, `hasUI=${context.hasUI === true}`];
  if (childSkip(context)) return { journal: false, originEvidence: [...evidence, "child-session"] };
  const match = RULES.reduce<Match | undefined>((match, rule) => match ?? rule(facts), undefined)!;
  return decide(match, evidence);
}
