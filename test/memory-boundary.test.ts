import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FileMemoryStore } from "../src/memory/store.ts";
import { foldEvents } from "../src/memory/fold.ts";
import { appendEvent } from "../src/memory/boundary.ts";
import { readSessionState, type SessionState } from "../src/memory/requests.ts";
import { newId, type RequestCloseEvent } from "../src/memory/types.ts";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import { findRuntime } from "./runtime.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "boundary-review-")); dirs.push(dir);
  const store = new FileMemoryStore({ agentDir: dir });
  const message = (origin: "human" | "launch", at: string, injectedKind?: "relaunch") => store.appendMessage({ id: newId(), at,
    session: { id: "s1", role: "main" }, cwd: dir, origin, injectedKind, originEvidence: [], text: "request", withheld: null, redactions: [] });
  return { dir, store, message };
}
test("launch requests are open in reader and accepted as closure targets in fold; relaunch is excluded", () => {
  const h = setup(), initial = h.message("launch", "2026-01-01T00:00:00Z"), relaunch = h.message("launch", "2026-01-01T00:00:01Z", "relaunch");
  assert.deepEqual(readSessionState(h.store.home, "s1").open.map(r => r.id), [initial.id]);
  const event: RequestCloseEvent = { schema: "memory.event/2", id: newId(), at: "2026-01-01T00:00:02Z", actor: { kind: "human", id: "user", harness: "pi" }, type: "request_close", requestId: initial.id, status: "abandoned" };
  const folded = foldEvents([{ position: 0, record: event }], [initial, relaunch]);
  assert.equal(folded.closures.length, 1);
});

test("agent abandonment requires a later human source and is listed in the reader index and fold counts", () => {
  const h = setup(), request = h.message("human", "2026-01-01T00:00:01Z"), later = h.message("human", "2026-01-01T00:00:02Z"), older = h.message("human", "2026-01-01T00:00:00Z"), launch = h.message("launch", "2026-01-01T00:00:03Z");
  const entries = [request, later, older, launch];
  const event: RequestCloseEvent = { schema: "memory.event/2", id: newId(), at: "2026-01-01T00:00:04Z", actor: { kind: "agent", id: "agent", harness: "pi" }, type: "request_close", requestId: request.id, status: "abandoned", source: { type: "user_message", ref: later.id } };
  const folded = foldEvents([{ position: 0, record: event }], entries);
  assert.equal(folded.events[event.id].ok, true);
  assert.equal(folded.counts["requests:abandoned:agent"], 1);
  appendEvent(h.store.home, event);
  const state = readSessionState(h.store.home, "s1");
  assert.deepEqual(state.agentAbandonments.map(e => e.id), [event.id]);
  assert.equal(state.requests.find(r => r.id === request.id)?.status, "abandoned");
  for (const source of [undefined, { type: "agent_decision", ref: later.id }, { type: "user_message", ref: older.id }, { type: "user_message", ref: request.id }, { type: "user_message", ref: launch.id }, { type: "user_message", ref: "missing" }]) {
    const bad = { ...event, id: newId(), source };
    assert.equal(foldEvents([{ position: 0, record: bad }], entries).events[bad.id].ok, false);
  }
  const forged = { ...event, id: newId(), status: "answered", answerId: "a1" };
  assert.equal(foldEvents([{ position: 0, record: forged }], entries).events[forged.id].ok, false);
});

// CI pins pi 1.2.0. Exercise its awaited message_end -> turn_end -> compaction hook chain, not a source-text assertion.
test("installed runtime awaits durable answers before commit/backstop effects and reports compaction completion", async t => {
  const runtime = findRuntime(); assert.ok(runtime, "the CI runtime is required");
  const pc: any = await import(pathToFileURL(join(runtime, "dist/index.js")).href);
  const aiPath = [join(runtime, "node_modules/@earendil-works/pi-ai/dist/index.js"), join(dirname(dirname(runtime)), "@earendil-works/pi-ai/dist/index.js")].find(existsSync)!;
  const ai: any = await import(pathToFileURL(aiPath).href);
  const dir = mkdtempSync(join(tmpdir(), "answer-order-")); dirs.push(dir);
  const agentDir = join(dir, "agent"); mkdirSync(agentDir);
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json"); process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode: "enforce", memory: { journal: true, requests: true, scope: { mode: "all" } } }));
  const faux = ai.fauxProvider({ provider: `answer-order-${process.pid}`, models: [{ id: "m" }] });
  const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }); modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  let sessionId: string;
  const turns: SessionState[] = [], compactions: SessionState[] = [], backstops: SessionState[] = [];
  const observe = (pi: any) => {
    pi.on("turn_end", () => { turns.push(readSessionState(join(agentDir, "memory"), sessionId)); });
    pi.on("session_before_compact", () => { backstops.push(readSessionState(join(agentDir, "memory"), sessionId)); });
    pi.on("session_compact", () => { compactions.push(readSessionState(join(agentDir, "memory"), sessionId)); });
  };
  const resourceLoader = new pc.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [createContextBudgetExtension({ agentDir, hosts: new SessionHosts() }), observe] });
  await resourceLoader.reload();
  const sessionManager = pc.SessionManager.inMemory(dir); sessionId = sessionManager.getSessionId();
  const { session } = await pc.createAgentSession({ cwd: dir, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, noTools: "builtin", sessionManager, settingsManager });
  t.after(async () => { await session.abort(); session.dispose(); });
  await session.bindExtensions({ mode: "print" });
  faux.setResponses([ai.fauxAssistantMessage("durable answer")]); await session.prompt("task");
  assert.equal(turns.length, 1); assert.equal(turns[0].answers.at(-1)?.text, "durable answer");
  faux.setResponses([ai.fauxAssistantMessage("summary")]);
  const compacted = await session.compact();
  assert.match(compacted.summary, /Compaction instance:/);
  assert.equal(compactions.length, 1); assert.equal(compactions[0].boundaries.length, 1);
  assert.equal(backstops.length, 1); assert.equal(backstops[0].answers.at(-1)?.text, "durable answer");
  session.sessionManager.appendSessionInfo("L0");
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxText("commit interim"), ai.fauxToolCall("context_handoff", { goal: "finish", next_step: "resume", facts: "verified" })]), ai.fauxAssistantMessage("resumed")]);
  await session.prompt("work and hand off");
  assert.deepEqual(turns.map(s => s.answers.at(-1)?.text), ["durable answer", "commit interim", "resumed"]);
  assert.ok(turns[1].boundaries.some(b => b.event.kind === "handoff" && b.event.lastAnswerId === turns[1].answers.at(-1)?.id));
});
