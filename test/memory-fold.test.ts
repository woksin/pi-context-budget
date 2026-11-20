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

test("orders require an allowlisted injected coordinator; directives cannot be overridden", () => {
  const store = fixture({ coordinators: ["lead"] });
  const source = message({ origin: "injected", injectedKind: "lane_message", injectedFrom: "lead" });
  store.appendMessage(source);
  const order = decision({ kind: "order", text: source.text!, source: { type: "coordinator_order", ref: source.id,
    span: { start: 0, end: source.text!.length } } });
  assert.equal(store.addItem(order, agent).status, "applied");
  assert.equal(new FileMemoryStore({ home: store.home }).readFolded().items[order.id], undefined);
  assert.equal(store.addItem(decision({ kind: "order", source: { ...order.source, ref: "missing" } }), agent).status, "rejected");
});
