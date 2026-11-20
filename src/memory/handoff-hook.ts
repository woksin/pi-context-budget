import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Handoff } from "../core.ts";
import type { IntentServices } from "./tools.ts";
import type { HandoffMemory } from "./handoff-block.ts";
import { selectedHandoffScopes } from "./handoff-scopes.ts";
import { project } from "./project.ts";
import { singleLine } from "./render.ts";
import { userMessagesSince } from "../collect.ts";

export function legacyBranch(runtime: IntentServices, ctx: ExtensionContext, branch: readonly unknown[]) {
  return runtime.enabled(ctx) ? [] : branch;
}
export function legacyReplay(runtime: IntentServices, ctx: ExtensionContext, branch: readonly unknown[], previousAt?: string) {
  return runtime.enabled(ctx) ? undefined : userMessagesSince(branch, previousAt);
}

/** Keep fallback replay bounded even after JSON encoding and prevent forged binding headers. */
function degradedMemory(ctx: ExtensionContext, previous?: Pick<Handoff, "path" | "at">): HandoffMemory {
  const replay = userMessagesSince(ctx.sessionManager.getBranch(), previous?.at, 3072);
  return { text: ["## Memory index\nmemory degraded: projection unavailable; use memory_list and recall before trusting prior intent.",
    "## User messages since previous handoff (legacy fallback; unverified)", singleLine(replay)].join("\n\n") + "\n" };
}

/** The same mechanical projection serves explicit handoffs and every emergency backstop. */
export async function handoffMemory(runtime: IntentServices, ctx: ExtensionContext, previous?: Pick<Handoff, "path" | "at">): Promise<HandoffMemory | undefined> {
  if (!runtime.enabled(ctx)) return undefined;
  try {
    const store = await runtime.store(ctx), selected = selectedHandoffScopes(ctx, store, previous?.path);
    // Reserve the inter-block separator inside the combined 32 KiB requests/memory cap.
    return project(store, { scopes: selected.scopes, taskItemIds: selected.taskItemIds, session: ctx.sessionManager.getSessionId(), sessions: selected.sessionIds,
      reportOtherScopes: true, budgets: { total: 20 * 1024 - 2, index: 4094 } });
  } catch {
    return degradedMemory(ctx, previous);
  }
}
