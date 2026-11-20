import { join } from "node:path";
import { appendRecord } from "./log.ts";
import { makeIdSet, resolveIdSet, type BlobWriter, type ResolvedIdSet } from "./idset.ts";
import { newId, type Actor, type BoundaryEvent, type Session } from "./types.ts";

export const BOUNDARY_KINDS = ["handoff", "emergency", "hard", "idle", "overflow_native", "overflow_package", "manual", "abort"] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];
/** Only the harness writes boundaries and closures; the actor is never taken from model output. */
export const SYSTEM_ACTOR: Actor = { kind: "system", id: "context-budget", harness: "pi" };
export type BoundaryInput = { session: Session; runId: string; kind: BoundaryKind; open: string[]; compactionEntryId?: string;
  lastAnswerId?: string; sameRunAsAnswer: boolean; handoffPath?: string };

/** Open request ids go through an idSet (blob first), so every record stays inside the event line cap. */
export function buildBoundary(home: string, input: BoundaryInput, writer?: BlobWriter): BoundaryEvent {
  const { open, ...rest } = input;
  return { schema: "memory.event/2", id: newId(), at: new Date().toISOString(), actor: SYSTEM_ACTOR, type: "boundary",
    ...rest, openRequests: makeIdSet(home, open, writer) };
}
export const eventsFile = (home: string) => join(home, "events.jsonl");
export function appendEvent(home: string, event: object): void { appendRecord(eventsFile(home), event); }

export type ResolvedBoundary = { event: BoundaryEvent; open: ResolvedIdSet };
export const resolveBoundary = (home: string, event: BoundaryEvent): ResolvedBoundary => ({ event, open: resolveIdSet(home, event.openRequests) });
/** Derived, never stored: an answer is possibly unseen once a same-run boundary names it as the last answer. */
export function possiblyUnseen(boundaries: BoundaryEvent[]): Set<string> {
  return new Set(boundaries.filter(b => b.sameRunAsAnswer && b.lastAnswerId).map(b => b.lastAnswerId!));
}
