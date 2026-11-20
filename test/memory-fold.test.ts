import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryStore } from "../src/memory/store.ts";
import { appendRecord, scanLog } from "../src/memory/log.ts";
import { foldEvents } from "../src/memory/fold.ts";
import { newId } from "../src/memory/types.ts";
import { agent, human, message, directive, decision } from "./memory-conformance.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "memory-fold-"));
  directories.push(home);
  return new FileMemoryStore({ home, ...options });
}
test("only a confirmed human rejection can retire a proposed directive", () => {
  const store = fixture(), entry = message({ text: "Do not run tests" });
  store.appendMessage(entry);
  const item = directive(entry); store.addItem(item, agent);
  const rejection = message({ text: `/memory reject ${item.id}`, originEvidence: ["tui-confirm"] });
  store.appendMessage(rejection);
  const source = { type: "user_message" as const, ref: rejection.id };
  assert.equal(store.retireItem(item.id, "withdrawn", "No", source, human).reason, "conflict");
  assert.equal(store.retireItem(item.id, "rejected", "No", source, agent).reason, "not_authorised");
  assert.equal(store.retireItem(item.id, "rejected", "No", { type: "user_message", ref: entry.id }, human).reason, "not_authorised");
  const extended = message({ text: `/memory reject ${item.id}\n${item.text}`, originEvidence: ["tui-confirm"] });
  store.appendMessage(extended);
  assert.equal(store.retireItem(item.id, "rejected", "No", { type: "user_message", ref: extended.id }, human).reason, "not_authorised");
  assert.equal(store.retireItem(item.id, "rejected", "No", source, human).ok, true);
  assert.equal(store.readFolded().items[item.id]!.status, "rejected");
  assert.equal(store.retireItem(item.id, "rejected", "No", source, human).reason, "not_proposed");
  assert.equal(store.confirm(item.id, human).reason, "not_proposed");
});
test("fold ignores an active status on an order add without a human UI confirmation event", () => {
  const store = fixture({ coordinators: ["L0"] });
  const source = message({ origin: "injected", injectedKind: "lane_message", injectedFrom: "L0" }); store.appendMessage(source);
  const item = decision({ kind: "order", text: source.text!, source: { type: "coordinator_order", ref: source.id,
    span: { start: 0, end: source.text!.length } } });
  const eventId = forged(store, { type: "add", item: { ...item, status: "active" }, actor: { ...agent, kind: "coordinator", id: "L0" } });
  assert.equal(store.readFolded().events[eventId].ok, true);
  assert.equal(store.readFolded().items[item.id].status, "proposed");
  const invalid = forged(store, { type: "confirm", itemId: item.id, actor: human, via: "tool" });
  assert.equal(store.readFolded().events[invalid].reason, "not_authorised");
  assert.equal(store.readFolded().items[item.id].status, "proposed");
  assert.equal(store.confirm(item.id, human).ok, true);
  assert.equal(store.readFolded().items[item.id].status, "active");
});
test("fold cannot auto-activate an overlapping source after a human withdrawal", () => {
  const store = fixture({ eligibilityCheck: () => ({ eligible: true, reasons: [] }) });
  const source = message(); store.appendMessage(source);
  const item = directive(source, { authority: { mode: "auto", ruleVersion: 1 } }); store.addItem(item, agent);
  const withdrawal = message({ text: "Withdraw", at: new Date(Date.now() + 1000).toISOString() }); store.appendMessage(withdrawal);
  assert.equal(store.retireItem(item.id, "withdrawn", "Withdraw", { type: "user_message", ref: withdrawal.id }, human).ok, true);
  const readded = { ...item, id: newId() };
  forged(store, { type: "add", item: readded });
  assert.equal(store.readFolded().items[readded.id].status, "proposed");
});
test("human retirement is remembered even without a human source; agent completion does not block re-add", () => {
  for (const actor of [human, agent]) {
    const store = fixture({ eligibilityCheck: () => ({ eligible: true, reasons: [] }) });
    const source = message(); store.appendMessage(source);
    const item = directive(source, { authority: { mode: "auto", ruleVersion: 1 } }); store.addItem(item, agent);
    assert.equal(store.retireItem(item.id, "done", "Finished", { type: "agent_decision" }, actor).ok, true);
    const readded = { ...item, id: newId() }; store.addItem(readded, agent);
    assert.equal(store.readFolded().items[readded.id].status, actor.kind === "human" ? "proposed" : "active");
  }
});
test("fold rejects non-exact quote code units", () => {
  const store = fixture(), source = message({ text: "Never\u00a0run tests" }); store.appendMessage(source);
  const event = forged(store, { type: "add", item: directive(source, { text: "Never run tests" }) });
  assert.equal(store.readFolded().events[event].reason, "quote_mismatch");
});
test("source quotes over the item cap are refused rather than truncated", () => {
  const store = fixture(), source = message({ text: "word ".repeat(1000) }); store.appendMessage(source);
  assert.equal(store.addItem(directive(source), agent).reason, "too_large");
});
function forged(store: FileMemoryStore, fields: object) {
  const id = newId();
  appendRecord(join(store.home, "events.jsonl"), { schema: "memory.event/2", id, at: "2026-01-02T00:00:00Z", actor: agent, ...fields });
  return id;
}

test("raw forged lines: missing source, injected directive and quote mismatch are rejected", () => {
  const store = fixture(), missing = message(), injected = message({ origin: "injected" }), humanEntry = message();
  store.appendMessage(injected);
  store.appendMessage(humanEntry);
  for (const item of [directive(missing), directive(injected), directive(humanEntry, { text: "forged quote" })]) {
    const id = forged(store, { type: "add", item });
    assert.equal(store.readFolded().events[id].status, "rejected");
    assert.equal(store.readFolded().items[item.id], undefined);
  }
  assert.equal(store.health().rejectedEvents, 3);
});

test("fold determinism: shuffled delivery preserves the same canonical log positions", () => {
  const store = fixture(), item = decision();
  store.addItem(item, agent);
  store.retireItem(item.id, "done", "tested", { type: "agent_decision" }, agent);
  const records = scanLog(join(store.home, "events.jsonl")).records;
  assert.deepEqual(foldEvents(records, []), foldEvents([...records].reverse(), []));
  assert.equal(foldEvents(records, []).items[item.id].status, "done");
});

test("authorisation: auto checker is re-run; unknown versions and invalid commands stay proposed", () => {
  const homeStore = fixture({ eligibilityCheck: (_text: string, _span: object, version: number) => ({ eligible: version === 1, reasons: [] }) });
  const entry = message(); homeStore.appendMessage(entry);
  for (const ruleVersion of [1, 999]) {
    const item = directive(entry, { authority: { mode: "auto", ruleVersion } });
    homeStore.addItem(item, agent);
    assert.equal(homeStore.readFolded().items[item.id].status, ruleVersion === 1 ? "active" : "proposed");
  }
  const command = message({ text: "/directive Run tests" }); homeStore.appendMessage(command);
  const valid = directive(command, { text: "Run tests", source: { type: "user_message", ref: command.id, span: { start: 11, end: 20 } },
    authority: { mode: "command", ruleVersion: 1, commandRef: command.id } });
  homeStore.addItem(valid, human);
  assert.equal(homeStore.readFolded().items[valid.id].status, "active");
  const invalid = directive(entry, { authority: { mode: "command", ruleVersion: 1, commandRef: entry.id } });
  homeStore.addItem(invalid, agent);
  assert.equal(homeStore.readFolded().items[invalid.id].status, "proposed");
  const replay = new FileMemoryStore({ home: homeStore.home });
  assert.equal(replay.readFolded().items[valid.id].status, "active");
});

test("fold rejects forged confirmation and malformed classification", () => {
  const store = fixture(), entry = message(); store.appendMessage(entry);
  const item = directive(entry); store.addItem(item, agent);
  const confirm = forged(store, { type: "confirm", itemId: item.id, via: "ui" });
  const classify = forged(store, { type: "classify", messageId: entry.id, whole: null,
    spans: [{ start: -1, end: 100, result: "none", itemIds: [] }] });
  assert.equal(store.readFolded().events[confirm].status, "rejected");
  assert.equal(store.readFolded().events[classify].status, "rejected");
  assert.equal(store.readFolded().items[item.id].status, "proposed");
});

test("orders stay proposed with or without a configured sender until a human UI confirmation", () => {
  const store = fixture({ coordinators: ["lead"] });
  const source = message({ origin: "injected", injectedKind: "lane_message", injectedFrom: "lead" });
  store.appendMessage(source);
  const order = decision({ kind: "order", text: source.text!, source: { type: "coordinator_order", ref: source.id,
    span: { start: 0, end: source.text!.length } } });
  assert.equal(store.addItem(order, agent).status, "applied");
  assert.equal(store.readFolded().items[order.id].status, "proposed");
  assert.equal(new FileMemoryStore({ home: store.home }).readFolded().items[order.id].status, "proposed");
  assert.equal(store.confirm(order.id, agent).reason, "not_authorised");
  assert.equal(store.confirm(order.id, human).ok, true);
  assert.equal(store.readFolded().items[order.id].status, "active");
  assert.equal(store.addItem(decision({ kind: "order", source: { ...order.source, ref: "missing" } }), agent).status, "rejected");
});
