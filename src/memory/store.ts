import { mkdirSync, chmodSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendRecord, scanLog, JOURNAL_LINE_BYTES } from "./log.ts";
import { foldEvents, rejection } from "./fold.ts";
import { requireValid, safeName, utf8Head, validateEvent, validateMessage, ValidationError } from "./validate.ts";
import { newId } from "./types.ts";
import type { Actor, Classification, FoldedItem, FoldedState, FoldOptions, Health, Item, ItemQuery, JournalEntry, MemoryEvent,
  MessageInput, MessageQuery, Page, Redactor, RetireEvent, SearchHit, SearchQuery, Source, WriteResult } from "./types.ts";

export interface MemoryStoreCore {
  appendMessage(entry: MessageInput): JournalEntry;
  getMessage(id: string): JournalEntry | undefined;
  listMessages(query: MessageQuery): Page<JournalEntry>;
  search(query: SearchQuery): SearchHit[];
  addItem(item: Item, actor: Actor): WriteResult;
  confirm(itemId: string, actor: Actor): WriteResult;
  retireItem(itemId: string, status: RetireEvent["status"], reason: string, source: Source, actor: Actor): WriteResult;
  classify(classification: Classification, actor: Actor): WriteResult;
  /** Optional visibility is applied before paging; cursors index the filtered result. */
  list(query: ItemQuery, visible?: (item: FoldedItem) => boolean): Page<FoldedItem>;
  changesSince(cursor?: string): { events: MemoryEvent[]; cursor: string };
  health(): Health;
  readFolded(): FoldedState;
}
export type StoreOptions = FoldOptions & { agentDir?: string; home?: string; redactor?: Redactor };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
function page<T>(items: T[], query: Pick<ItemQuery, "limit" | "cursor">): Page<T> {
  const { limit, cursor } = query;
  requireValid(Number.isInteger(limit) && limit > 0 && limit <= 1000, "invalid_limit");
  const offset = Number(cursor ?? 0);
  requireValid(Number.isSafeInteger(offset) && offset >= 0, "invalid_cursor");
  const end = Math.min(offset + limit, items.length);
  return { items: items.slice(offset, end), ...(end < items.length ? { cursor: String(end) } : {}) };
}
function matchesScope(item: FoldedItem, scopes?: ItemQuery["scopes"]): boolean {
  return !scopes || scopes.some(scope => scope.kind === item.scope.kind && scope.key === item.scope.key);
}
function writeBlob(home: string, text: string): { sha256: string; bytes: number } {
  const sha256 = digest(text), target = join(home, "blobs", `${sha256}.txt`), temp = `${target}.${newId()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd); unlinkSync(temp); throw error;
  }
  closeSync(fd);
  try { renameSync(temp, target); }
  catch (error) { unlinkSync(temp); throw error; }
  return { sha256, bytes: Buffer.byteLength(text) };
}
function prepareMessage(home: string, input: MessageInput): JournalEntry {
  validateMessage(input);
  const text = input.text ?? "";
  const entry: JournalEntry = { ...input, schema: "memory.journal/2", textBytes: Buffer.byteLength(text), sha256: digest(text) };
  if (entry.textBytes > 64 * 1024) {
    entry.blob = writeBlob(home, text);
    const tail = [...utf8Head([...text].reverse().join(""), 1024)].reverse().join("");
    entry.text = `${utf8Head(text, 2048)}\n…\n${tail}`;
  }
  return entry;
}
function hydrateMessage(home: string, entry: JournalEntry): JournalEntry {
  if (!entry.blob) {
    requireValid(entry.sha256 === digest(entry.text ?? "") && entry.textBytes === Buffer.byteLength(entry.text ?? ""), "invalid_message");
    return entry;
  }
  const blob = entry.blob;
  requireValid(/^[a-f0-9]{64}$/.test(blob.sha256) && blob.sha256 === entry.sha256 && blob.bytes === entry.textBytes, "invalid_blob");
  try {
    const text = readFileSync(join(home, "blobs", `${blob.sha256}.txt`), "utf8");
    requireValid(digest(text) === blob.sha256 && Buffer.byteLength(text) === blob.bytes, "invalid_blob");
    return { ...entry, text };
  } catch { return { ...entry, text: null, withheld: "too_large" }; }
}
function readJournal(home: string, file: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const { record } of scanLog(file, JOURNAL_LINE_BYTES).records) {
    try {
      const entry = record as JournalEntry;
      requireValid(entry.schema === "memory.journal/2", "invalid_message");
      validateMessage(entry);
      entries.push(hydrateMessage(home, entry));
    } catch { /* CRC-valid malformed records cannot become provenance. */ }
  }
  return entries;
}
function searchMatches(entry: JournalEntry, query: SearchQuery, items?: FoldedItem[]): boolean {
  if (query.sessionIds && !query.sessionIds.includes(entry.session.id)) return false;
  if (query.since && entry.at < query.since) return false;
  if (items && !items.some(item => item.source.ref === entry.id)) return false;
  return true;
}
function searchHit(entry: JournalEntry, query: SearchQuery, redactor?: Redactor): SearchHit | undefined {
  if (!entry.text || !redactor) return;
  const start = entry.text.indexOf(query.query);
  if (start < 0) return;
  try {
    const redacted = redactor(entry.text);
    if (typeof redacted !== "string") return;
    const snippet = redacted.slice(Math.max(0, start - 80), start + query.query.length + 160);
    return { id: entry.id, at: entry.at, origin: entry.origin, snippet, span: { start, end: start + query.query.length } };
  } catch { return; }
}

function knownResult(state: FoldedState, event: MemoryEvent): WriteResult | undefined {
  if (state.events[event.id]) return state.events[event.id];
  if (event.type !== "add") return;
  const existing = state.items[event.item.id];
  return existing ? state.events[existing.eventId] : undefined;
}
function countActivePerScope(state: FoldedState): Health["activePerScope"] {
  const counts: Health["activePerScope"] = Object.create(null);
  for (const item of Object.values(state.items).filter(item => item.status === "active")) {
    const key = `${item.scope.kind}:${item.scope.key}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sourcedEvent(event: MemoryEvent, messages: Map<string, JournalEntry>): MemoryEvent {
  if (event.type !== "add") return event;
  if (event.item.kind === "decision") return event;
  const source = event.item.source;
  const text = messages.get(source.ref!)!.text!.slice(source.span!.start, source.span!.end);
  return { ...event, item: { ...event.item, text } };
}

/** Inert until explicitly constructed; no pi imports, extension hooks or flag changes. */
export class FileMemoryStore implements MemoryStoreCore {
  readonly home: string;
  private readonly options: StoreOptions;
  constructor(options: StoreOptions = {}) {
    this.options = options;
    this.home = options.home ?? process.env.PI_MEMORY_HOME ?? join(options.agentDir ?? join(homedir(), ".pi", "agent"), "memory");
    for (const directory of [this.home, ...["journal", "answers", "blobs"].map(name => join(this.home, name))]) privateDirectory(directory);
  }
  private journalFiles(): string[] {
    return readdirSync(join(this.home, "journal")).filter(name => /^[A-Za-z0-9_-]{1,200}\.jsonl$/.test(name)).sort().map(name => join(this.home, "journal", name));
  }
  private messages(): JournalEntry[] {
    const entries = new Map<string, JournalEntry>();
    for (const file of this.journalFiles()) for (const entry of readJournal(this.home, file)) if (!entries.has(entry.id)) entries.set(entry.id, entry);
    return [...entries.values()];
  }
  appendMessage(input: MessageInput): JournalEntry {
    const existing = this.getMessage(input.id);
    if (existing) return existing;
    const entry = prepareMessage(this.home, input);
    appendRecord(join(this.home, "journal", `${input.session.id}.jsonl`), entry, JOURNAL_LINE_BYTES);
    return hydrateMessage(this.home, entry);
  }
  getMessage(id: string): JournalEntry | undefined { return this.messages().find(entry => entry.id === id); }
  listMessages(query: MessageQuery): Page<JournalEntry> {
    const entries = this.messages().filter(entry => (!query.sessionId || entry.session.id === query.sessionId) &&
      (!query.origin || entry.origin === query.origin) && (!query.since || entry.at >= query.since));
    return page(entries, query);
  }
  search(query: SearchQuery): SearchHit[] {
    requireValid(typeof query.query === "string" && query.query.length > 0, "invalid_query");
    requireValid(Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 1000, "invalid_limit");
    return this.collectHits(query, this.scopedItems(query));
  }
  private scopedItems(query: SearchQuery): FoldedItem[] | undefined {
    if (!query.scopes) return;
    return Object.values(this.readFolded().items).filter(item => matchesScope(item, query.scopes));
  }
  private collectHits(query: SearchQuery, items?: FoldedItem[]): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const entry of this.messages()) {
      if (!searchMatches(entry, query, items)) continue;
      const hit = searchHit(entry, query, query.redactor ?? this.options.redactor);
      if (hit) hits.push(hit);
      if (hits.length === query.limit) break;
    }
    return hits;
  }
  readFolded(): FoldedState {
    return foldEvents(scanLog(join(this.home, "events.jsonl")).records, this.messages(), this.options);
  }
  private appendEvent(event: MemoryEvent): WriteResult {
    try { appendRecord(join(this.home, "events.jsonl"), event); }
    catch (error) {
      if (error instanceof Error && error.message === "too_large") return rejection(event.id, new ValidationError("too_large"));
      throw error;
    }
    return this.readFolded().events[event.id] ?? rejection(event.id, new ValidationError("append_not_read_back"));
  }
  private write(event: MemoryEvent): WriteResult {
    const entries = this.messages(), records = scanLog(join(this.home, "events.jsonl")).records;
    const state = foldEvents(records, entries, this.options);
    const existing = knownResult(state, event);
    if (existing) return existing;
    const messages = new Map(entries.map(entry => [entry.id, entry]));
    try { validateEvent(event, state, messages, this.options); }
    catch (error) { return rejection(event.id, error); }
    return this.appendEvent(sourcedEvent(event, messages));
  }
  private base(actor: Actor) { return { schema: "memory.event/2" as const, id: newId(), at: new Date().toISOString(), actor }; }
  addItem(item: Item, actor: Actor): WriteResult {
    return this.write({ ...this.base(actor), type: "add", item: { ...item } });
  }
  confirm(itemId: string, actor: Actor): WriteResult { return this.write({ ...this.base(actor), type: "confirm", itemId, via: "ui" }); }
  retireItem(itemId: string, status: RetireEvent["status"], reason: string, source: Source, actor: Actor): WriteResult {
    return this.write({ ...this.base(actor), type: "retire", itemId, status, reason, source });
  }
  classify(classification: Classification, actor: Actor): WriteResult {
    return this.write({ ...classification, ...this.base(actor), type: "classify" });
  }
  list(query: ItemQuery, visible?: (item: FoldedItem) => boolean): Page<FoldedItem> {
    const items = Object.values(this.readFolded().items).filter(item => matchesScope(item, query.scopes) &&
      (!query.kind || item.kind === query.kind) && (!query.status || item.status === query.status));
    return page(visible ? items.filter(visible) : items, query);
  }
  changesSince(cursor = "0"): { events: MemoryEvent[]; cursor: string } {
    const offset = Number(cursor);
    requireValid(Number.isSafeInteger(offset) && offset >= 0, "invalid_cursor");
    const records = scanLog(join(this.home, "events.jsonl")).records.filter(record => record.position >= offset);
    return { events: records.map(record => record.record as MemoryEvent), cursor: records.length ? String(records[records.length - 1].position + 1) : cursor };
  }
  private memoryFiles(): string[] {
    return [join(this.home, "events.jsonl"), ...this.journalFiles(),
      ...readdirSync(join(this.home, "answers")).filter(name => name.endsWith(".jsonl") && safeName(name.slice(0, -6))).map(name => join(this.home, "answers", name))];
  }
  health(): Health {
    const health: Health = { tornTail: 0, corrupt: 0, blank: 0, rejectedEvents: 0, activePerScope: Object.create(null) };
    for (const file of this.memoryFiles()) {
      const scan = scanLog(file, file.includes(`${join(this.home, "journal")}/`) ? JOURNAL_LINE_BYTES : undefined);
      health.tornTail += scan.tornTail; health.corrupt += scan.corrupt; health.blank += scan.blank;
    }
    const state = this.readFolded();
    health.rejectedEvents = state.rejectedEvents.length;
    health.activePerScope = countActivePerScope(state);
    return health;
  }
}
