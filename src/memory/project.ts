import type { MemoryStoreCore } from "./store.ts";
import type { FoldedItem, JournalEntry, MessageQuery, Page, Scope } from "./types.ts";
import { requireValid } from "./validate.ts";
import { spanResolver } from "./spans.ts";
import type { Disposition } from "./spans.ts";
import { compare, MESSAGE_SECTION, pointerExcerpt, projectionBudgets, renderMemory, singleLine } from "./render.ts";
import type { Budgets, IndexRow, MemoryIndex, MessageRow, Projection, RenderRecord } from "./render.ts";

export type { Budgets, Projection } from "./render.ts";
export type ProjectQuery = { scopes: Scope[]; session: string; sessions?: string[]; taskItemIds?: readonly string[]; reportOtherScopes?: boolean; projectedItems?: readonly FoldedItem[]; budgets?: Partial<Budgets> };
export type ProjectionMessageQuery = MessageQuery & { unresolvedOnly?: boolean };
export interface MemoryStore extends MemoryStoreCore {
  project(query: ProjectQuery): Projection;
  listMessages(query: ProjectionMessageQuery): Page<JournalEntry>;
}

function allMessages(store: MemoryStoreCore, query: Partial<MessageQuery> = {}): JournalEntry[] {
  const entries: JournalEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = store.listMessages({ ...query, limit: 1000, cursor });
    entries.push(...page.items); cursor = page.cursor;
  } while (cursor !== undefined);
  return entries;
}
function scopeMatches(item: FoldedItem, scopes: Scope[]): boolean {
  return scopes.some(scope => scope.kind === item.scope.kind && scope.key === item.scope.key);
}
function sourcePointer(item: FoldedItem): string {
  const source = item.source, span = source.span ? `[${source.span.start}:${source.span.end}]` : "";
  const prefix = source.type === "question_item" ? "question_item" : "journal";
  return source.ref ? `${prefix}:${singleLine(source.ref)}${span}` : `source:${singleLine(source.type)}`;
}
function itemRecord(item: FoldedItem): RenderRecord {
  const scope = `${singleLine(item.scope.kind)}:${singleLine(item.scope.key)}`, pointer = sourcePointer(item);
  const titles = { directive: "User directives (verbatim, from source)", order: "Coordinator orders", decision: "Agent decisions" };
  const section = item.status === "proposed" ? "Proposed directives (not binding)" : titles[item.kind];
  const identity = `[${singleLine(item.id)}] (${scope}, ${pointer}, ${singleLine(item.at)})`;
  const gloss = item.gloss ? `\nagent gloss: ${singleLine(item.gloss)}` : "";
  return { id: item.id, type: "item", scope: item.scope, at: item.at, section,
    full: `${identity} ${singleLine(item.text)}${gloss}`, pointer: `${identity} ${singleLine(pointerExcerpt(item.text))}`,
    eligible: item.status === "active" || item.status === "proposed", withheld: false };
}
function messageRecord(entry: JournalEntry, disposition: Disposition): RenderRecord {
  const ranges = disposition.uncovered, first = ranges[0];
  const remainder = ranges.map(span => entry.text!.slice(span.start, span.end)).join("\n");
  const range = first ? `[${first.start}:${first.end}]` : "";
  const gaps = ranges.length > 1 ? ` (+${ranges.length - 1} more gap${ranges.length === 2 ? "" : "s"})` : "";
  const identity = `[${singleLine(entry.id)}] (session:${singleLine(entry.session.id)}, journal:${singleLine(entry.id)}${range}${gaps}, ${singleLine(entry.at)})`;
  const excerpt = first ? entry.text!.slice(first.start, first.end) : "";
  const reason = entry.text === null ? `withheld: ${singleLine(entry.withheld ?? "unavailable")}` : singleLine(pointerExcerpt(excerpt));
  return { id: entry.id, type: "message", scope: { kind: "session", key: entry.session.id }, at: entry.at, section: MESSAGE_SECTION,
    full: `${identity} ${singleLine(remainder)}`, pointer: `${identity} ${reason}`, eligible: !disposition.resolved, withheld: entry.text === null };
}
function itemRows(items: FoldedItem[]): IndexRow[] {
  const rows = new Map<string, IndexRow>();
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.scope.kind, item.scope.key, item.status]);
    const row = rows.get(key) ?? { kind: item.kind, scope: item.scope, status: item.status, count: 0 };
    row.count++; rows.set(key, row);
  }
  return [...rows].sort(([a], [b]) => compare(a, b)).map(([, row]) => row);
}
function unresolvedRows(entries: JournalEntry[]): MessageRow[] {
  const rows = new Map<string, MessageRow>();
  for (const entry of [...entries].sort((a, b) => compare(a.at, b.at) || compare(a.id, b.id))) {
    const day = entry.at.slice(0, 10), key = JSON.stringify([day, entry.session.id]);
    const row = rows.get(key) ?? { day, session: entry.session.id, count: 0, oldest: entry.id, newest: entry.id };
    row.count++; row.newest = entry.id; rows.set(key, row);
  }
  return [...rows].sort(([a], [b]) => compare(a, b)).map(([, row]) => row);
}
function hygieneScopes(items: FoldedItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items.filter(item => item.status === "active")) {
    const key = `${item.scope.kind}:${item.scope.key}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 50).map(([scope]) => scope).sort(compare);
}

function sourceKey(item: FoldedItem): string | undefined {
  return item.source.ref ? JSON.stringify([item.source.type, item.source.ref]) : undefined;
}
function mergedItems(stored: FoldedItem[], projected: readonly FoldedItem[] = []): FoldedItem[] {
  const refs = new Set(stored.map(sourceKey).filter(Boolean));
  const additions = projected.filter(item => {
    const ref = sourceKey(item);
    if (ref && refs.has(ref)) return false;
    if (ref) refs.add(ref);
    return true;
  });
  return [...stored, ...additions];
}

/** Pure read-side projection; no boundary cursor, writes, extension hooks or pi dependencies. */
export function project(store: MemoryStoreCore, query: ProjectQuery): Projection {
  const budgets = projectionBudgets(query.budgets), state = store.readFolded(), resolve = spanResolver(state);
  const taskItemIds = new Set(query.taskItemIds);
  const allItems = mergedItems(Object.values(state.items), query.projectedItems);
  const items = allItems.filter(item => scopeMatches(item, query.scopes) || taskItemIds.has(item.id)).sort((a, b) => compare(a.id, b.id));
  const sessions = [...new Set(query.sessions ?? [query.session])];
  const messages = sessions.flatMap(sessionId => allMessages(store, { sessionId, origin: "human" })
    .filter(entry => entry.session.id === sessionId && entry.origin === "human")).sort((a, b) => compare(a.id, b.id));
  const dispositions = messages.map(entry => ({ entry, disposition: resolve(entry) }));
  const unresolved = dispositions.filter(row => !row.disposition.resolved).map(row => row.entry);
  const index: MemoryIndex = { items: items.length, messages: messages.length, unresolved: unresolved.length,
    withheld: messages.filter(entry => entry.text === null).length, proposed: items.filter(item => item.status === "proposed").length,
    rejected: state.rejectedEvents.length, rows: itemRows(items), unresolvedRows: unresolvedRows(unresolved),
    dispositions: dispositions.filter(row => row.disposition.wholeNone).map(row => ({ messageId: row.entry.id, reason: row.disposition.wholeNone!.reason! })),
    hygiene: hygieneScopes(items) };
  const records = [...items.map(itemRecord), ...dispositions.map(({ entry, disposition }) => messageRecord(entry, disposition))];
  const otherScopes = query.reportOtherScopes ? allItems.length - items.length : 0;
  return renderProjection(records, index, budgets, otherScopes);
}

/** Reserve the optional cross-scope count inside both the index and total budgets. */
function renderProjection(records: RenderRecord[], index: MemoryIndex, budgets: Budgets, otherScopes: number): Projection {
  const notice = otherScopes ? `${otherScopes} items in other scopes; memory_list scope=<..> cursor=<..>.\n` : "";
  const reserved = Buffer.byteLength(notice);
  // Tiny caller-supplied budgets may not have room even for the extra count line.
  const include = budgets.index - reserved >= 512;
  const extra = include ? notice : "";
  const result = renderMemory(records, index, include ? { ...budgets, index: budgets.index - reserved } : budgets);
  result.text += extra;
  result.sections.index += extra;
  return result;
}

/** Filter before paging, so a page full of resolved messages cannot hide later unresolved ones. */
export function listUnresolvedMessages(store: MemoryStoreCore, query: ProjectionMessageQuery): Page<JournalEntry> {
  requireValid(Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 1000, "invalid_limit");
  const offset = Number(query.cursor ?? 0);
  requireValid(Number.isSafeInteger(offset) && offset >= 0, "invalid_cursor");
  const resolve = spanResolver(store.readFolded());
  const entries = allMessages(store, { sessionId: query.sessionId, origin: query.origin, since: query.since }).filter(entry => !resolve(entry).resolved);
  const end = Math.min(offset + query.limit, entries.length);
  return { items: entries.slice(offset, end), ...(end < entries.length ? { cursor: String(end) } : {}) };
}

/** Add the projection capability to any core backend without modifying it or changing its defaults. */
export function withProjection(core: MemoryStoreCore): MemoryStore {
  return {
    project: query => project(core, query),
    listMessages: query => query.unresolvedOnly ? listUnresolvedMessages(core, query) : core.listMessages(query),
    appendMessage: core.appendMessage.bind(core), getMessage: core.getMessage.bind(core), search: core.search.bind(core),
    addItem: core.addItem.bind(core), confirm: core.confirm.bind(core), retireItem: core.retireItem.bind(core),
    classify: core.classify.bind(core), list: core.list.bind(core), changesSince: core.changesSince.bind(core),
    health: core.health.bind(core), readFolded: core.readFolded.bind(core),
  };
}
