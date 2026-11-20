import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { answerRequestIds, readAnswers, type AnswerRecord } from "./answers.ts";
import { BOUNDARY_KINDS, eventsFile, possiblyUnseen, resolveBoundary, SYSTEM_ACTOR, type ResolvedBoundary } from "./boundary.ts";
import { newId, type BoundaryEvent, type JournalEntry, type RequestCloseEvent } from "./types.ts";
import { JOURNAL_LINE_BYTES, scanLog } from "./log.ts";
import { requireValid, safeName, validateMessage } from "./validate.ts";

/** Contract 10.1: a human prompt, or a launch prompt that is not a relaunch, needs an answer. */
export const isRequest = (entry: Pick<JournalEntry, "origin" | "injectedKind">): boolean =>
  entry.origin === "human" || (entry.origin === "launch" && entry.injectedKind !== "relaunch");

export type RequestStatus = "open" | "answered" | "abandoned";
export type RequestInfo = { id: string; at: string; origin: JournalEntry["origin"]; text: string | null; withheld: JournalEntry["withheld"];
  status: RequestStatus; answerIds: string[]; interruptions: number; aborted: boolean };
export type SessionState = { requests: RequestInfo[]; open: RequestInfo[]; answers: AnswerRecord[]; boundaries: ResolvedBoundary[];
  possiblyUnseen: Set<string>; agentAbandonments: RequestCloseEvent[] };

export function closeEvent(requestId: string, answerId: string): RequestCloseEvent {
  return { schema: "memory.event/2", id: newId(), at: new Date().toISOString(), actor: SYSTEM_ACTOR, type: "request_close", requestId, status: "answered", answerId };
}

/** An agent may abandon only by citing a later human journal entry, never a launch or model decision. */
function authorisedAbandonment(event: RequestCloseEvent, request: JournalEntry, messages: Map<string, JournalEntry>): boolean {
  if (event.status !== "abandoned") return false;
  if (event.actor.kind === "human") return true;
  if (event.actor.kind !== "agent" || event.source?.type !== "user_message") return false;
  return laterHuman(messages.get(event.source.ref ?? ""), request, event);
}
function laterHuman(source: JournalEntry | undefined, request: JournalEntry, event: RequestCloseEvent): boolean {
  if (source?.origin !== "human") return false;
  return Date.parse(source.at) > Date.parse(request.at) && Date.parse(source.at) <= Date.parse(event.at);
}
function validateBoundary(event: BoundaryEvent): void {
  requireValid(BOUNDARY_KINDS.includes(event.kind), "invalid_event");
  requireValid(typeof event.sameRunAsAnswer === "boolean", "invalid_event");
  requireValid(typeof event.runId === "string", "invalid_event");
  requireValid(typeof event.openRequests?.count === "number", "invalid_event");
  requireValid(typeof event.session?.id === "string", "invalid_event");
}
function isHarnessAnswer(event: RequestCloseEvent): boolean {
  return event.status === "answered" && event.actor.kind === "system" && safeName(event.answerId ?? "");
}

/** Fold-time validation (shared by `foldEvents` and the reader): a closure needs a real request, and only the harness answers. */
export function validateRequestEvent(event: BoundaryEvent | RequestCloseEvent, messages: Map<string, JournalEntry>): void {
  requireValid(event.schema === "memory.event/2", "invalid_event");
  requireValid(safeName(event.id), "invalid_event");
  requireValid(Number.isFinite(Date.parse(event.at)), "invalid_event");
  requireValid(["human", "agent", "coordinator", "system"].includes(event.actor?.kind), "invalid_actor");
  if (event.type === "boundary") {
    validateBoundary(event);
    return;
  }
  const request = messages.get(event.requestId);
  requireValid(request && isRequest(request), "no_source");
  requireValid(isHarnessAnswer(event) || authorisedAbandonment(event, request, messages), "not_authorised");
}

function readJournal(home: string, sessionId: string): JournalEntry[] {
  const seen = new Set<string>(), entries: JournalEntry[] = [];
  for (const { record } of scanLog(join(home, "journal", `${sessionId}.jsonl`), JOURNAL_LINE_BYTES).records) {
    const entry = record as JournalEntry;
    try { validateMessage(entry); } catch { continue; }
    if (entry.schema === "memory.journal/2" && !seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
  }
  return entries;
}
function validEvents(home: string, messages: Map<string, JournalEntry>): Array<BoundaryEvent | RequestCloseEvent> {
  const events: Array<BoundaryEvent | RequestCloseEvent> = [], seen = new Set<string>();
  for (const { record } of scanLog(eventsFile(home)).records) {
    const event = record as BoundaryEvent | RequestCloseEvent;
    if (!["boundary", "request_close"].includes(event.type) || seen.has(event.id)) continue;
    try { validateRequestEvent(event, messages); } catch { continue; }
    seen.add(event.id); events.push(event);
  }
  return events;
}
function readEvents(home: string, sessionId: string, messages: Map<string, JournalEntry>) {
  const events = validEvents(home, messages);
  const boundaries = events.filter((event): event is BoundaryEvent => event.type === "boundary").filter(event => event.session.id === sessionId);
  const closed = new Map<string, RequestCloseEvent>();
  for (const event of events.filter((event): event is RequestCloseEvent => event.type === "request_close")) {
    if (!closed.has(event.requestId)) closed.set(event.requestId, event);
  }
  return { boundaries, closed };
}
function answered(home: string, answers: AnswerRecord[]): Map<string, string[]> {
  const byRequest = new Map<string, string[]>();
  for (const answer of answers) {
    const ids = answerRequestIds(home, answer);
    if ("ids" in ids) for (const id of ids.ids) byRequest.set(id, [...(byRequest.get(id) ?? []), answer.id]);
  }
  return byRequest;
}

/** Everything derives from the files: a restarted process or a console tailing them sees the same state. Never writes. */
export function readSessionState(home: string, sessionId: string): SessionState {
  const entries = readJournal(home, sessionId), messages = new Map(entries.map(entry => [entry.id, entry]));
  const { boundaries, closed } = readEvents(home, sessionId, messages), answers = readAnswers(home, sessionId);
  const resolved = boundaries.map(event => resolveBoundary(home, event)), answerIds = answered(home, answers);
  const requests = entries.filter(isRequest).map((entry): RequestInfo => {
    const interruptions = resolved.filter(b => "ids" in b.open && b.open.ids.includes(entry.id));
    return { id: entry.id, at: entry.at, origin: entry.origin, text: entry.text, withheld: entry.withheld,
      status: closed.get(entry.id)?.status ?? "open", answerIds: answerIds.get(entry.id) ?? [], interruptions: interruptions.length,
      aborted: interruptions.some(b => b.event.kind === "abort") };
  });
  const agentAbandonments = [...closed.values()].filter(event => event.status === "abandoned" && event.actor.kind === "agent");
  return { requests, open: requests.filter(r => r.status === "open"), answers, boundaries: resolved, possiblyUnseen: possiblyUnseen(boundaries), agentAbandonments };
}
/** Session volume includes every distinct referenced body/id-set blob, not just the small JSONL previews. */
export function answersBytes(home: string, sessionId: string): number {
  const file = join(home, "answers", `${sessionId}.jsonl`);
  if (!existsSync(file)) return 0;
  const blobs = new Set<string>();
  for (const { record } of scanLog(file).records) {
    const answer = record as AnswerRecord;
    if (answer.blob) blobs.add(`${answer.blob.sha256}.txt`);
    if (answer.requests && "blob" in answer.requests) blobs.add(answer.requests.blob);
  }
  let bytes = statSync(file).size;
  for (const blob of blobs) {
    if (/^[a-f0-9]{64}\.txt$/.test(blob)) bytes += statSync(join(home, "blobs", blob)).size;
  }
  return bytes;
}
