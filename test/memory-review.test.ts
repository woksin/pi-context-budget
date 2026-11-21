import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIntentHook } from "../src/memory/tools.ts";
import { FileMemoryStore } from "../src/memory/store.ts";
import { eligibilityCheck } from "../src/memory/authorize.ts";
import { singleLine } from "../src/memory/render.ts";
import { agent, directive, human, message } from "./memory-conformance.ts";

const prefix = "context-budget:memory-review/v1:";
const root = join(import.meta.dirname, "../.ai-work/review-tests");
mkdirSync(root, { recursive: true });
function fixture() {
  const home = mkdtempSync(join(root, "case-")), configFile = join(home, "config.json");
  const configure = (intent: boolean) => writeFileSync(configFile, JSON.stringify({ memory: { intent, journal: true, scope: { mode: "all" } } }));
  configure(true);
  const events = new EventEmitter(), handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const commands = new Map<string, any>(), tools: any[] = [], results: any[] = [], readiness: any[] = [], prompts: any[] = [], receipts: any[] = [];
  let subagent = false, handoff = false, sessionId = "session";
  const ctx: any = { mode: "tui", hasUI: true, cwd: home, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { confirm: async () => true, custom: async (factory: any, settings: any) => {
      let answer: string | undefined;
      const component = factory({ terminal: { rows: 24, columns: 80 }, requestRender: () => {} }, {},
        { matches: (data: string, action: string) => data === action }, (value: string) => { answer = value; });
      prompts.push({ screen: component.render(80).map((line: string) => line.trimEnd()), settings });
      component.handleInput("tui.editor.cursorRight"); component.handleInput("tui.select.confirm");
      return answer;
    }, notify: () => {} } };
  const pi: any = { events, on: (name: string, callback: any) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
    registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: () => {} };
  const hook = createIntentHook(pi, { agentDir: home, configFile, host: () => ({ subagent }), reviewBlocked: () => handoff,
    log: (_ctx, event, data) => receipts.push({ event, data }) });
  hook.start(ctx);
  const fire = async (name: string) => { for (const callback of handlers.get(name) ?? []) await callback({}, ctx); };
  const store = new FileMemoryStore({ home: join(home, "memory"), eligibilityCheck });
  const entry = message({ text: "Full canonical\ntext \u001b[31m " + "x".repeat(700) }), item = directive(entry);
  store.appendMessage(entry); store.addItem(item, agent);
  events.on(prefix + "result", result => results.push(result));
  events.on(prefix + "readiness", state => readiness.push(state));
  const probe = () => { events.emit(prefix + "probe", { version: 1 }); return readiness.at(-1); };
  const request = (extra: any = {}) => ({ requestId: "request-1", itemId: item.id, action: "confirm", sessionId,
    generation: probe().generation, expiresAt: Date.now() + 20_000, ...extra });
  const send = async (input: any) => {
    const result = new Promise<any>(resolve => {
      const receive = (result: any) => {
        if (result.requestId !== input.requestId) return;
        events.off(prefix + "result", receive); resolve(result);
      };
      events.on(prefix + "result", receive);
    });
    events.emit(prefix + "request", input); return result;
  };
  return { ctx, hook, store, entry, item, events, prompts, tools, commands, results, receipts, probe, request, send, fire, configure,
    primary: (value: boolean) => { subagent = !value; }, handoff: (value: boolean) => { handoff = value; },
    session: (value: string) => { sessionId = value; } };
}
async function readyFixture() { const f = fixture(); await f.fire("session_start"); return f; }
function deferredPrompt(f: ReturnType<typeof fixture>) {
  let answer!: (value: string | undefined) => void, opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  f.ctx.ui.custom = () => { opened(); return new Promise<string | undefined>(resolve => { answer = resolve; }); };
  return { ready, yes: () => answer("Yes, authorise"), no: () => answer(undefined) };
}

for (const action of ["confirm", "reject"]) test(`review ${action} reports the producer result without item text`, async () => {
  const f = await readyFixture(), result = await f.send(f.request({ action }));
  assert.equal(result.reason, "applied");
  assert.equal(result.action, action); assert.equal(result.itemId, f.item.id);
  const event = f.store.changesSince().events.find(event => event.id === result.eventId)!;
  assert.equal(event.actor.kind, "human");
  assert.equal(event.type, action === "confirm" ? "confirm" : "retire");
  assert.equal(f.store.readFolded().items[f.item.id].status, action === "confirm" ? "active" : "rejected");
  assert.equal(JSON.stringify(result).includes("canonical"), false);
  assert.equal(f.receipts[0].event, "memory_review_result"); assert.equal(f.receipts[0].data.eventId, result.eventId);
  assert.equal(JSON.stringify(f.receipts).includes("canonical"), false);
  const prompt = f.prompts[0];
  for (const text of [action, f.item.id, "directive", "global", f.entry.id, singleLine(f.item.text).slice(0, 25)]) assert.ok(prompt.screen.join("\n").includes(text));
  assert.ok(prompt.screen.includes("> Refuse")); assert.ok(prompt.screen.includes("  Yes, authorise"));
  assert.equal(prompt.settings.overlay, true);
  assert.equal(f.tools.some(tool => /confirm|review/.test(tool.name)), false);
});

const failures: [string, string, (f: ReturnType<typeof fixture>, request: any) => void][] = [
  ["RPC", "unavailable", f => { f.ctx.mode = "rpc"; }],
  ["hasUI only", "unavailable", f => { delete f.ctx.mode; }],
  ["no native custom dialog", "unavailable", f => { delete f.ctx.ui.custom; }],
  ["disabled", "unavailable", f => f.configure(false)],
  ["subagent", "unavailable", f => f.primary(false)],
  ["wrong session", "wrong_target", (_f, request) => { request.sessionId = "other"; }],
  ["wrong generation", "wrong_target", (_f, request) => { request.generation = "old"; }],
  ["handoff", "handoff", f => f.handoff(true)],
  ["non-human directive", "not_human", (f, request) => {
    const entry = message({ origin: "unattended" }); f.store.appendMessage(entry);
    const item = directive(entry); f.store.addItem(item, agent); request.itemId = item.id;
  }],
  ["expired", "expired", (_f, request) => { request.expiresAt = Date.now() - 1; }],
  ["extra fields", "invalid_request", (_f, request) => { request.actor = human; }],
  ["not visible", "no_source", (f, request) => {
    const item = directive(f.entry, { scope: { kind: "lane", key: "chain:other" } });
    f.store.addItem(item, agent); request.itemId = item.id;
  }],
];
for (const [name, reason, arrange] of failures) test(`review fails closed: ${name}`, async () => {
  const f = await readyFixture(), request = f.request(); arrange(f, request);
  const result = await f.send(request);
  assert.equal(result.reason, reason); assert.equal(f.prompts.length, 0);
  assert.equal(f.store.readFolded().items[f.item.id].status, "proposed");
});

test("readiness is advisory, versioned and contains an opaque store identity", async () => {
  const f = await readyFixture(), state = f.probe();
  assert.equal(state.version, 1); assert.equal(state.available, true); assert.equal(state.sessionId, "session");
  assert.match(state.storeId, /^[a-f0-9]{64}$/); assert.ok(state.generation);
  assert.equal(f.probe().storeId, state.storeId);
  const states: any[] = []; f.events.on(prefix + "readiness", state => states.push(state));
  f.events.emit(prefix + "probe", {}); assert.equal(states.at(-1).available, false);
  f.events.emit(prefix + "probe", { version: 2 }); assert.equal(states.at(-1).reason, "unsupported_version");
  f.events.emit("context-budget:memory-review/v2:probe", { version: 2 }); assert.equal(states.length, 2);
});

test("duplicate request IDs never prompt or write twice", async () => {
  const f = await readyFixture(), prompt = deferredPrompt(f), request = f.request();
  const running = f.send(request); await prompt.ready;
  assert.equal((await f.send(request)).reason, "duplicate");
  prompt.yes(); const first = await running;
  assert.equal(first.reason, "duplicate"); // Both listeners observe the immediate duplicate receipt.
  await new Promise(setImmediate);
  const applied = f.results.find(result => result.reason === "applied"); assert.ok(applied);
  assert.deepEqual(await f.send(request), applied);
  assert.equal(f.store.changesSince().events.filter(event => event.type === "confirm").length, 1);
});

test("one in-flight native prompt; cancellation invalidates a later yes", async () => {
  const f = await readyFixture(), prompt = deferredPrompt(f), request = f.request();
  const running = f.send(request); await prompt.ready;
  assert.equal((await f.send({ ...request, requestId: "second" })).reason, "busy");
  f.events.emit(prefix + "cancel", { requestId: request.requestId });
  await running; prompt.yes(); await new Promise(setImmediate);
  assert.equal(f.results.find(result => result.requestId === request.requestId && result.reason === "cancelled")?.reason, "cancelled");
  assert.equal(f.results.filter(result => result.requestId === request.requestId).length, 1);
  assert.equal(f.store.readFolded().items[f.item.id].status, "proposed");
});

test("cancel before dispatch is a tombstone; extra cancel fields cannot cancel", async () => {
  const f = await readyFixture(), request = f.request();
  f.events.emit(prefix + "cancel", { requestId: request.requestId });
  assert.equal((await f.send(request)).reason, "cancelled");
  const second = f.request({ requestId: "second" });
  f.events.emit(prefix + "cancel", { requestId: second.requestId, confirmed: true });
  assert.equal((await f.send(second)).reason, "applied");
  assert.equal(f.prompts.length, 1);
});

test("expiry invalidates even a late affirmative native response", async t => {
  const f = await readyFixture(), prompt = deferredPrompt(f);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const running = f.send(f.request({ expiresAt: Date.now() + 100 })); await prompt.ready;
  t.mock.timers.tick(101); assert.equal((await running).reason, "expired");
  prompt.yes(); await new Promise(setImmediate);
  assert.equal(f.store.readFolded().items[f.item.id].status, "proposed");
});

for (const answer of [undefined, "Refuse", "yes", true]) test(`refusal is the default, not ${String(answer)}`, async () => {
  const f = await readyFixture(); f.ctx.ui.custom = async () => answer;
  assert.equal((await f.send(f.request())).reason, "refused");
  assert.equal(f.store.readFolded().items[f.item.id].status, "proposed");
});

for (const change of ["status", "content", "source", "mode", "session", "generation", "handoff", "disabled", "host"]) test(`rechecks ${change} after the prompt`, async () => {
  const f = await readyFixture(), prompt = deferredPrompt(f), running = f.send(f.request()); await prompt.ready;
  if (change === "status") f.store.confirm(f.item.id, human);
  if (change === "mode") f.ctx.mode = "rpc";
  if (change === "session") f.session("other");
  if (change === "generation") await f.fire("session_tree");
  if (change === "handoff") f.handoff(true);
  if (change === "disabled") f.configure(false);
  if (change === "host") f.primary(false);
  if (change === "content" || change === "source") {
    const original = FileMemoryStore.prototype.readFolded;
    // Simulate a changed canonical fold without rewriting the producer log.
    f.ctx.ui.custom = async () => "Refuse";
    const restore = original;
    FileMemoryStore.prototype.readFolded = function () {
      const state = restore.call(this), item = state.items[f.item.id];
      if (item) { if (change === "content") item.text += "changed"; else item.source.ref = "changed"; }
      return state;
    };
    try { prompt.yes(); assert.notEqual((await running).reason, "applied"); }
    finally { FileMemoryStore.prototype.readFolded = original; }
  } else { prompt.yes(); assert.notEqual((await running).reason, "applied"); }
  assert.equal(f.store.changesSince().events.filter(event => event.type === "confirm").length, change === "status" ? 1 : 0);
});

for (const path of ["bridge", "slash"]) test(`${path} rejects an unattended-origin proposed directive after native approval`, async () => {
  const f = await readyFixture(), entry = message({ origin: "unattended" }), item = directive(entry);
  f.store.appendMessage(entry); f.store.addItem(item, agent);
  assert.equal(f.store.readFolded().items[item.id].status, "proposed");
  if (path === "bridge") assert.equal((await f.send(f.request({ itemId: item.id, action: "reject" }))).reason, "applied");
  else await f.commands.get("memory").handler(`reject ${item.id}`, f.ctx);
  assert.equal(f.store.readFolded().items[item.id].status, "rejected");
});

test("native review escapes bidi and other invisible Unicode format characters", async () => {
  const f = await readyFixture(), entry = message({ text: "go \u202Edanger\u2066\u200b " + "x".repeat(700) }), item = directive(entry);
  f.store.appendMessage(entry); f.store.addItem(item, agent);
  assert.equal((await f.send(f.request({ itemId: item.id }))).reason, "applied");
  const screen = f.prompts[0].screen.join("\n");
  assert.doesNotMatch(screen, /\p{Cf}/u);
  for (const escape of ["\\u{202e}", "\\u{2066}", "\\u{200b}"]) assert.ok(screen.includes(escape));
});

test("a busy request ID can be retried after the current prompt closes", async () => {
  const f = await readyFixture(), custom = f.ctx.ui.custom, prompt = deferredPrompt(f), running = f.send(f.request());
  await prompt.ready;
  const request = f.request({ requestId: "retry" });
  assert.equal((await f.send(request)).reason, "busy");
  prompt.no(); assert.equal((await running).reason, "refused"); await new Promise(setImmediate);
  f.ctx.ui.custom = custom;
  assert.equal((await f.send(request)).reason, "applied");
});

test("cancel tombstones are bounded and expire instead of permanently disabling review", async t => {
  const f = await readyFixture(), now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  for (let index = 0; index < 1024; index++) f.events.emit(prefix + "cancel", { requestId: `cancel-${index}` });
  assert.equal((await f.send(f.request())).reason, "unavailable");
  t.mock.timers.setTime(now + 60_001);
  assert.equal((await f.send(f.request())).reason, "applied");
});

test("finished receipts survive the request deadline plus grace, then are pruned", async t => {
  const f = await readyFixture(), now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const request = f.request(), applied = await f.send(request);
  assert.equal(applied.reason, "applied");
  t.mock.timers.setTime(request.expiresAt + 59_999);
  assert.deepEqual(await f.send(request), applied);
  t.mock.timers.setTime(request.expiresAt + 60_001);
  assert.equal((await f.send(request)).reason, "expired");
  assert.equal(f.prompts.length, 1);
});

test("expiry during the final fingerprint refuses before the writer is called", async t => {
  const f = await readyFixture(), now = Date.now(), request = f.request(), custom = f.ctx.ui.custom;
  t.mock.timers.enable({ apis: ["Date"], now });
  let reads = 0;
  f.ctx.ui.custom = async (...args: any[]) => {
    const answer = await custom(...args), original = FileMemoryStore.prototype.getMessage;
    t.mock.method(FileMemoryStore.prototype, "getMessage", function (this: FileMemoryStore, id: string) {
      const entry = original.call(this, id);
      if (++reads === 2) t.mock.timers.setTime(request.expiresAt + 1);
      return entry;
    });
    return answer;
  };
  assert.equal((await f.send(request)).reason, "expired");
  assert.equal(reads, 2);
  assert.equal(f.store.changesSince().events.filter(event => event.type === "confirm").length, 0);
});

test("reports the writer's actual conflict rather than assuming the human response won", async t => {
  const f = await readyFixture();
  t.mock.method(FileMemoryStore.prototype, "confirm", () => ({ ok: false, status: "conflict", eventId: "producer-event", reason: "conflict", winningEventId: "winner" }));
  const result = await f.send(f.request());
  assert.equal(result.reason, "conflict"); assert.equal(result.eventId, "producer-event"); assert.equal(result.winningEventId, "winner");
});
