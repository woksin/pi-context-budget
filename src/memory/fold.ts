import type { AddEvent, BoundaryEvent, ConfirmEvent, RequestCloseEvent, FoldedState, FoldOptions, ItemStatus, JournalEntry, LocatedRecord, MemoryEvent, RetireEvent, WriteResult } from "./types.ts";
import { validateEvent, ValidationError } from "./validate.ts";
import { validateRequestEvent } from "./requests.ts";

type FoldContext = { state: FoldedState; messages: Map<string, JournalEntry>; options: FoldOptions };

export function emptyFold(): FoldedState {
  return { items: Object.create(null), events: Object.create(null), rejectedEvents: [], classifications: [],
    boundaries: [], closures: [], counts: Object.create(null) };
}
export function rejection(eventId: string, error: unknown): WriteResult {
  const reason = error instanceof ValidationError ? error.message : "invalid_event";
  const winningEventId = error instanceof ValidationError ? error.winningEventId : undefined;
  return { ok: false, status: winningEventId ? "conflict" : "rejected", eventId, reason,
    ...(winningEventId ? { winningEventId } : {}) };
}
function applyAdd(event: AddEvent, status: ItemStatus, state: FoldedState): void {
  for (const id of event.item.supersedes) {
    state.items[id] = { ...state.items[id], status: "superseded", changedBy: event.id };
  }
  state.items[event.item.id] = { ...event.item, status, at: event.at, eventId: event.id, changedBy: event.id };
}
function applyConfirm(event: ConfirmEvent, state: FoldedState): void {
  state.items[event.itemId] = { ...state.items[event.itemId], status: "active", changedBy: event.id };
}
function applyRetire(event: RetireEvent, ctx: FoldContext): void {
  const source = ctx.messages.get(event.source.ref!);
  ctx.state.items[event.itemId] = { ...ctx.state.items[event.itemId], status: event.status, changedBy: event.id,
    retiredByAgent: event.actor.kind !== "human" && source?.origin !== "human" };
}
function apply(event: MemoryEvent, status: ItemStatus | undefined, ctx: FoldContext): void {
  switch (event.type) {
    case "add": applyAdd(event, status!, ctx.state); break;
    case "confirm": applyConfirm(event, ctx.state); break;
    case "retire": applyRetire(event, ctx); break;
    case "classify": ctx.state.classifications.push(event); break;
  }
}
function existingAdd(event: MemoryEvent, state: FoldedState): WriteResult | undefined {
  if (event.type !== "add") return;
  const existing = state.items[event.item?.id];
  return existing ? state.events[existing.eventId] : undefined;
}
function recordRejection(ctx: FoldContext, id: string, error: unknown): void {
  const result = rejection(id, error);
  ctx.state.events[id] = result;
  ctx.state.rejectedEvents.push({ eventId: id, reason: result.reason!, ...(result.winningEventId ? { winningEventId: result.winningEventId } : {}) });
}
/** Request closures and boundaries are fold-validated like every event but never change intent state. */
function foldRequestEvent(event: BoundaryEvent | RequestCloseEvent, id: string, ctx: FoldContext): void {
  try {
    validateRequestEvent(event, ctx.messages);
    if (event.type === "boundary") ctx.state.boundaries.push(event); else ctx.state.closures.push(event);
    ctx.state.events[id] = { ok: true, status: "applied", eventId: id };
  } catch (error) { recordRejection(ctx, id, error); }
}
function foldOne(event: MemoryEvent, position: number, ctx: FoldContext): void {
  const id = typeof event.id === "string" ? event.id : `invalid:${position}`;
  if (Object.hasOwn(ctx.state.events, id)) return;
  if (event.type === "boundary" || event.type === "request_close") return foldRequestEvent(event, id, ctx);
  const existing = existingAdd(event, ctx.state);
  if (existing) { ctx.state.events[id] = existing; return; }
  try {
    const status = validateEvent(event, ctx.state, ctx.messages, ctx.options);
    apply(event, status, ctx);
    ctx.state.events[id] = { ok: true, status: "applied", eventId: id };
  } catch (error) { recordRejection(ctx, id, error); }
}
function countItems(state: FoldedState): void {
  const agentAbandonments = state.closures.filter(event => event.status === "abandoned" && event.actor.kind === "agent");
  if (agentAbandonments.length) state.counts["requests:abandoned:agent"] = agentAbandonments.length;
  for (const item of Object.values(state.items)) {
    const key = `${item.kind}:${item.scope.kind}:${item.scope.key}:${item.status}`;
    state.counts[key] = (state.counts[key] ?? 0) + 1;
  }
}
/** Only file positions define history; callers may supply records in any delivery order. */
export function foldEvents(records: LocatedRecord[], entries: JournalEntry[], options: FoldOptions = {}): FoldedState {
  const ctx: FoldContext = { state: emptyFold(), messages: new Map(), options };
  for (const entry of entries) if (!ctx.messages.has(entry.id)) ctx.messages.set(entry.id, entry);
  for (const { record, position } of [...records].sort((a, b) => a.position - b.position)) foldOne(record as MemoryEvent, position, ctx);
  countItems(ctx.state);
  return ctx.state;
}
