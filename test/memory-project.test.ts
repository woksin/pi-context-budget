import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryStore } from "../src/memory/store.ts";
import { project, withProjection } from "../src/memory/project.ts";
import { foldEvents } from "../src/memory/fold.ts";
import type { FoldedState, JournalEntry } from "../src/memory/types.ts";
import type { MemoryStoreCore } from "../src/memory/store.ts";
import { agent, human, message, directive, decision, memoryConformance } from "./memory-conformance.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "memory-project-"));
  directories.push(home);
  return withProjection(new FileMemoryStore({ home }));
}
const query = { scopes: [{ kind: "global" as const, key: "*" }], session: "session" };
memoryConformance("projection", fixture);

test("one of two directives remains unresolved across three boundaries; second add resolves", () => {
  const store = fixture(), entry = message({ text: "Run tests\nKeep logs" });
  store.appendMessage(entry);
  store.addItem(directive(entry, { text: "Run tests", source: { type: "user_message", ref: entry.id, span: { start: 0, end: 9 } } }), agent);
  for (let boundary = 0; boundary < 3; boundary++) {
    const result = store.project(query);
    assert.equal(result.index.unresolved, 1);
    assert.match(result.text, /Keep logs/);
    assert.equal(store.listMessages({ unresolvedOnly: true, limit: 10 }).items[0].id, entry.id);
    store.addItem(decision(), agent);
  }
  store.addItem(directive(entry, { text: "Keep logs", source: { type: "user_message", ref: entry.id, span: { start: 10, end: 19 } } }), agent);
  assert.equal(store.project(query).index.unresolved, 0);
  assert.equal(store.listMessages({ unresolvedOnly: true, limit: 10 }).items.length, 0);
});

test("whole-none is recorded with reason and resolves; filtered paging remains complete", () => {
  const store = fixture(), entries = [message(), message(), message()];
  entries.forEach(entry => store.appendMessage(entry));
  store.classify({ messageId: entries[0].id, spans: [], whole: "none", reason: "No binding intent" }, human);
  const first = store.listMessages({ unresolvedOnly: true, limit: 1 });
  const second = store.listMessages({ unresolvedOnly: true, limit: 1, cursor: first.cursor });
  assert.deepEqual([...first.items, ...second.items].map(entry => entry.id), entries.slice(1).map(entry => entry.id));
  assert.match(store.project(query).text, /No binding intent/);
  assert.equal(store.project(query).index.dispositions[0].messageId, entries[0].id);
});

// The bulk fixtures use the backend-neutral read seam rather than quadratic file writes.
function bulk(messages: JournalEntry[], state: FoldedState): MemoryStoreCore {
  return { ...fixture(), readFolded: () => state, listMessages: ({ limit, cursor }) => {
    const offset = Number(cursor ?? 0), end = offset + limit;
    return { items: messages.slice(offset, end), ...(end < messages.length ? { cursor: String(end) } : {}) };
  } };
}
function journal(text: string, id: string): JournalEntry {
  return { ...message({ id, text }), schema: "memory.journal/2", textBytes: Buffer.byteLength(text), sha256: "" };
}
const empty = () => foldEvents([], []);

test("470 messages / 115 KiB are counted, paged and labelled within 20 KiB", () => {
  const messages = Array.from({ length: 470 }, (_, i) => journal("x".repeat(i < 260 ? 251 : 250), `message-${i}`));
  assert.equal(messages.reduce((sum, entry) => sum + entry.textBytes, 0), 115 * 1024);
  const store = withProjection(bulk(messages, empty())), result = store.project(query);
  assert.ok(Buffer.byteLength(result.text) <= 20 * 1024);
  assert.ok(Buffer.byteLength(result.sections.messages) <= 8 * 1024);
  assert.ok(Buffer.byteLength(result.sections.items) <= 8 * 1024);
  assert.ok(Buffer.byteLength(result.sections.index) <= 4 * 1024);
  const pointers = result.text.split("\n").filter(line => line.startsWith("[pointer]")).map(line => line + "\n").join("");
  assert.ok(Buffer.byteLength(pointers) <= 3 * 1024);
  assert.equal(result.index.unresolvedRows.reduce((sum, row) => sum + row.count, 0), 470);
  assert.equal(result.index.messages, 470);
  assert.equal(result.index.unresolved, 470);
  assert.equal(result.counts.inline + result.counts.pointer + result.counts.indexOnly, 470);
  assert.equal(result.entries.length, 470);
  assert.equal(store.listMessages({ unresolvedOnly: true, limit: 1000 }).items.length, 470);
  for (const label of ["inline", "pointer", "index-only"]) assert.match(result.text, new RegExp(label));
  assert.match(result.text, /memory_list scope=<\.\.> cursor=<\.\.>/);
  assert.match(result.text, /recall/);
});

test("5000 items: priority selects task then recency; render order stable; hygiene warning", () => {
  const state = empty();
  for (let i = 0; i < 5000; i++) {
    const item = decision({ id: `item-${String(i).padStart(4, "0")}`, text: "x".repeat(180),
      scope: i >= 4900 ? { kind: "task", key: "work" } : query.scopes[0] });
    state.items[item.id] = { ...item, status: "active", at: String(i).padStart(5, "0"), eventId: item.id, changedBy: item.id };
  }
  const store = bulk([], state), options = { ...query, scopes: [...query.scopes, { kind: "task" as const, key: "work" }] };
  const result = project(store, options);
  const inline = result.entries.filter(entry => entry.label === "inline");
  assert.ok(inline.length > 0);
  assert.ok(inline.every(entry => Number(entry.id.slice(5)) >= 5000 - inline.length));
  const ids = inline.map(entry => entry.id).sort();
  assert.ok(ids.every((id, i) => i === 0 || result.text.indexOf(`[inline] [${ids[i - 1]}]`) < result.text.indexOf(`[inline] [${id}]`)));
  assert.equal(result.index.items, 5000);
  assert.equal(result.index.rows.reduce((sum, row) => sum + row.count, 0), 5000);
  assert.match(result.text, /Hygiene warning/);
  assert.ok(Buffer.byteLength(result.text) <= 20 * 1024);
  assert.deepEqual(project(store, options), result);
});

test("multibyte text, pointer excerpts and small budgets never split a code point", () => {
  const store = bulk([journal("漢😀".repeat(9000), "unicode")], empty());
  for (const total of [1024, 2048, 20 * 1024]) {
    const result = project(store, { ...query, budgets: { total, messages: total - 512, index: 512, items: 0 } });
    assert.ok(Buffer.byteLength(result.text) <= total);
    assert.equal(Buffer.from(result.text).toString("utf8"), result.text);
  }
});

test("withheld text is pointer-only with reason, proposed directives are not binding", () => {
  const store = fixture(), withheld = message({ text: null, withheld: "redactor_failed" }), entry = message();
  store.appendMessage(withheld); store.appendMessage(entry);
  store.addItem(directive(entry), agent);
  const result = store.project(query);
  assert.equal(result.entries.find(row => row.id === withheld.id)?.label, "pointer");
  assert.match(result.text, /withheld: redactor_failed/);
  assert.match(result.text, /Proposed directives \(not binding\)/);
  assert.equal(result.index.proposed, 1);
});

test("index coarsens many scopes without losing structured counts", () => {
  const state = empty(), messages = [];
  for (let i = 0; i < 150; i++) {
    const item = decision({ id: `item-${i}`, scope: { kind: "task", key: `scope-${i}` } });
    state.items[item.id] = { ...item, status: "active", at: "2026", eventId: item.id, changedBy: item.id };
    messages.push(journal("pending", `message-${i}`));
  }
  const result = project(bulk(messages, state), { ...query, scopes: Object.values(state.items).map(item => item.scope), budgets: { index: 512 } });
  assert.equal(result.index.rows.length, 150);
  assert.equal(result.index.unresolved, 150);
  assert.ok(Buffer.byteLength(result.sections.index) <= 512);
  assert.match(result.text, /summar/);
});

test("rejected events and resolved messages remain indexed, other sessions excluded", () => {
  const state = empty(), resolved = journal("handled", "resolved"), other = journal("other", "other");
  other.session.id = "other-session";
  state.classifications.push({ schema: "memory.event/2", id: "classify", at: "2026", actor: agent,
    type: "classify", messageId: resolved.id, spans: [], whole: "none", reason: "handled" });
  state.rejectedEvents.push({ eventId: "rejected", reason: "invalid" });
  const result = project(bulk([resolved, other], state), query);
  assert.equal(result.index.messages, 1);
  assert.equal(result.index.unresolved, 0);
  assert.equal(result.index.rejected, 1);
  assert.equal(result.entries[0].label, "index-only");
});
