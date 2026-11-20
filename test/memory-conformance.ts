import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryStoreCore } from "../src/memory/store.ts";
import { newId } from "../src/memory/types.ts";
import type { Actor, Item, MessageInput } from "../src/memory/types.ts";

export const agent: Actor = { kind: "agent", id: "test", harness: "other" };
export const human: Actor = { kind: "human", id: "operator", harness: "other" };
export function message(overrides: Partial<MessageInput> = {}): MessageInput {
  return { id: newId(), at: "2026-01-01T00:00:00.000Z", session: { id: "session", role: "main" },
    cwd: "/tmp", origin: "human", originEvidence: ["test adapter"], text: "Run tests", withheld: null,
    redactions: [], ...overrides };
}
export function decision(overrides: Partial<Item> = {}): Item {
  return { id: newId(), kind: "decision", scope: { kind: "global", key: "*" }, text: "Use a log",
    source: { type: "agent_decision" }, supersedes: [], ...overrides };
}
export function directive(source: MessageInput, overrides: Partial<Item> = {}): Item {
  return decision({ kind: "directive", text: source.text!, source: { type: "user_message", ref: source.id,
    span: { start: 0, end: source.text!.length } }, authority: { mode: "none", ruleVersion: 1 }, ...overrides });
}

/** Backends register only capabilities they implement; projection is added by S2b. */
export function memoryConformance(capability: "core", create: () => MemoryStoreCore): void {
  assert.equal(capability, "core");
  test("core: idempotent add by item id and message id", () => {
    const store = create(), entry = message(), item = decision();
    assert.deepEqual(store.appendMessage(entry), store.appendMessage({ ...entry, text: "ignored" }));
    const first = store.addItem(item, agent);
    assert.equal(first.status, "applied");
    assert.deepEqual(store.addItem({ ...item, text: "ignored" }, agent), first);
    assert.equal(store.list({ limit: 10 }).items.length, 1);
    assert.equal(store.changesSince().events.length, 1);
  });
  test("core: directive origin and authority are derived at fold", () => {
    const store = create();
    for (const origin of ["human", "unattended", "launch", "injected"] as const) {
      const entry = message({ origin });
      store.appendMessage(entry);
      const item = directive(entry, { authority: { mode: "auto", ruleVersion: 1 } });
      const result = store.addItem(item, agent);
      assert.equal(result.status, origin === "injected" ? "rejected" : "applied");
      if (origin !== "injected") assert.equal(store.readFolded().items[item.id].status, "proposed");
    }
  });
  test("core: UI confirmation, directive retirement and supersession restrictions", () => {
    const store = create(), entry = message();
    store.appendMessage(entry);
    const item = directive(entry);
    store.addItem(item, agent);
    assert.equal(store.confirm(item.id, agent).status, "rejected");
    assert.equal(store.confirm(item.id, human).status, "applied");
    assert.equal(store.addItem(decision({ supersedes: [item.id] }), agent).status, "rejected");
    assert.equal(store.retireItem(item.id, "withdrawn", "changed", { type: "agent_decision" }, agent).status, "rejected");
    assert.equal(store.retireItem(item.id, "done", "verified", { type: "agent_decision" }, agent).status, "applied");
    assert.equal(store.retireItem(item.id, "done", "again", { type: "agent_decision" }, agent).status, "conflict");
  });
  test("core: literal search is redacted at return and fails closed", () => {
    const store = create(), entry = message({ text: "literal .* SECRET" });
    store.appendMessage(entry);
    assert.deepEqual(store.search({ query: ".*", limit: 10 }), []);
    assert.deepEqual(store.search({ query: ".*", limit: 10, redactor: () => { throw Error("offline"); } }), []);
    const hits = store.search({ query: ".*", limit: 10, redactor: text => text.replace("SECRET", "[redacted]") });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].snippet, "literal .* [redacted]");
    assert.equal(store.search({ query: "absent", limit: 10, redactor: text => text }).length, 0);
  });
  test("core: paging and raw classification, withheld messages require human whole-none", () => {
    const store = create(), entries = [message(), message({ text: null, withheld: "redactor_failed" })];
    entries.forEach(entry => store.appendMessage(entry));
    const page = store.listMessages({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(store.listMessages({ limit: 1, cursor: page.cursor }).items.length, 1);
    assert.equal(store.classify({ messageId: entries[1].id, spans: [], whole: "none", reason: "withheld" }, agent).status, "rejected");
    assert.equal(store.classify({ messageId: entries[1].id, spans: [], whole: "none", reason: "withheld" }, human).status, "applied");
    assert.equal(store.readFolded().classifications.length, 1);
  });
}
