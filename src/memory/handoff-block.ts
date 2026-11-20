import type { AutoState, HandoffInput } from "../core.ts";

export function constraintLint(input: HandoffInput, memoryIntent = false): string[] {
  return memoryIntent && input.user_constraints
    ? ["user_constraints is agent-reported, not verified against user messages; classify source journal spans for binding directives."] : [];
}

/** Already bounded, harness-rendered projection; never model-supplied narrative. */
export type HandoffMemory = { text: string };
export const AGENT_CONSTRAINTS = "Agent-reported constraints (not verified against user messages)";

/** Keep legacy layout and byte accounting exactly unchanged when intent memory is absent. */
export function handoffBlocks(auto: Pick<AutoState, "requests" | "userMessages">, memory?: HandoffMemory) {
  const block = [auto.requests, memory?.text].filter(Boolean).join("\n\n");
  return {
    afterGoal: memory ? block : undefined,
    requests: memory ? undefined : auto.requests,
    userMessages: memory ? undefined : auto.userMessages,
    constraints: memory ? AGENT_CONSTRAINTS : "User constraints (verbatim)",
    excludedBytes: memory ? Buffer.byteLength(block) + 2 : Buffer.byteLength(auto.requests ?? ""),
  };
}
