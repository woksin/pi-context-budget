/** Resume-check and watch reminders injected after a handoff boundary. */
import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { Handoff } from "../core.ts";
import { runResumeCheck } from "../resume-check.ts";
import { watchCheck } from "../storage.ts";
import { mode } from "./mode.ts";
import { checkCommand } from "./observe.ts";
import type { Runtime } from "./runtime.ts";

type Details = { kind?: string; path?: string } | undefined;
type Boundary = { id: string; details: Details };

function handoffBoundary(ctx: ExtensionContext): Boundary | undefined {
  const boundary = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "compaction");
  if (!boundary || (boundary.details as Details)?.kind !== "handoff") return undefined;
  return { id: boundary.id, details: boundary.details as Details };
}

function recordedHandoff(rt: Runtime, path: string | undefined): Handoff | undefined {
  if (rt.state.lastHandoff?.path === path) return rt.state.lastHandoff;
  return path ? JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf8")) as Handoff : undefined;
}

function watchMessage(rt: Runtime, boundary: Boundary): string | undefined {
  try {
    const handoff = recordedHandoff(rt, (boundary.details as { path?: string }).path);
    return handoff && watchCheck(handoff);
  } catch { return undefined; } // Optional recorded/live watch state unavailable.
}

/** First sight of a boundary: run the resume check once and read watch state. */
async function firstSight(rt: Runtime, ctx: ExtensionContext, boundary: Boundary): Promise<string | undefined> {
  rt.resumeBoundary = boundary.id; rt.resumeMessage = undefined;
  const command = checkCommand(rt, ctx);
  const checks: string[] = [];
  if (command) checks.push(`## Resume check (after context reset)\n${await runResumeCheck(command, ctx.cwd)}`);
  const watch = watchMessage(rt, boundary);
  rt.resumeMessage = checks.join("\n\n") || undefined;
  return watch;
}

// Context runs after Pi has installed the boundary and before the resumed
// provider call, including retain-none commits returned from turn_end.
export async function requestContext(rt: Runtime, event: ContextEvent, ctx: ExtensionContext) {
  if (mode(rt, ctx) !== "enforce") return;
  const boundary = handoffBoundary(ctx);
  if (!boundary) return;
  const watch = rt.resumeBoundary !== boundary.id ? await firstSight(rt, ctx, boundary) : undefined;
  const message = [rt.resumeMessage, watch].filter(Boolean).join("\n\n");
  if (message) return { messages: [...event.messages, { role: "custom" as const, customType: "context-budget-resume-check", content: message, display: false, timestamp: Date.now() }] };
}
