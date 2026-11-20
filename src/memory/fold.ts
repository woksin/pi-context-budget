import type { AddEvent, FoldedState, FoldOptions, ItemStatus, JournalEntry, LocatedRecord, MemoryEvent, WriteResult } from "./types.ts";
import { validateEvent, ValidationError } from "./validate.ts";

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
function apply(event: MemoryEvent, status: ItemStatus | undefined, state: FoldedState, messages: Map<string, JournalEntry>): void {
  switch (event.type) {
    case "add": applyAdd(event, status!, state); break;
    case "confirm": state.items[event.itemId] = { ...state.items[event.itemId], status: "active", changedBy: event.id }; break;
    case "retire": {
      const source = messages.get(event.source.ref!);
      state.items[event.itemId] = { ...state.items[event.itemId], status: event.status, changedBy: event.id,
        retiredByAgent: source?.origin !== "human" };
      break;
    }
    case "classify": state.classifications.push(event); break;
  }
}
function existingAdd(event: MemoryEvent, state: FoldedState): WriteResult | undefined {
  if (event.type !== "add") return;
  const existing = state.items[event.item?.id];
  return existing ? state.events[existing.eventId] : undefined;
}
function foldOne(event: MemoryEvent, position: number, state: FoldedState, messages: Map<string, JournalEntry>, options: FoldOptions): void {
  const id = typeof event.id === "string" ? event.id : `invalid:${position}`;
  if (Object.hasOwn(state.events, id)) return;
  const existing = existingAdd(event, state);
  if (existing) { state.events[id] = existing; return; }
  try {
    const status = validateEvent(event, state, messages, options);
    apply(event, status, state, messages);
    state.events[id] = { ok: true, status: "applied", eventId: id };
  } catch (error) {
    const result = rejection(id, error);
    state.events[id] = result;
    state.rejectedEvents.push({ eventId: id, reason: result.reason!, ...(result.winningEventId ? { winningEventId: result.winningEventId } : {}) });
  }
}
/** Only file positions define history; callers may supply records in any delivery order. */
export function foldEvents(records: LocatedRecord[], entries: JournalEntry[], options: FoldOptions = {}): FoldedState {
  const state = emptyFold(), messages = new Map<string, JournalEntry>();
  for (const entry of entries) if (!messages.has(entry.id)) messages.set(entry.id, entry);
  for (const { record, position } of [...records].sort((a, b) => a.position - b.position)) foldOne(record as MemoryEvent, position, state, messages, options);
  for (const item of Object.values(state.items)) {
    const key = `${item.kind}:${item.scope.kind}:${item.scope.key}:${item.status}`;
    state.counts[key] = (state.counts[key] ?? 0) + 1;
  }
  return state;
}
