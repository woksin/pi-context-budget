/** Offline checks against real pi event ordering; no paid provider or external state. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRuntime } from "./runtime.ts";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";

const runtime = findRuntime(), skip = runtime ? false : "pi runtime unavailable";
const root = resolve(import.meta.dirname, "../.ai-work/real-runtime");
mkdirSync(root, { recursive: true });
let sequence = 0;
async function setup(t: { after(fn: () => Promise<void>): void }, options: { hosts?: SessionHosts; parent?: string; idle?: boolean; mode?: string; before?: (pi: any) => void } = {}) {
  const pc: any = await import(pathToFileURL(join(runtime!, "dist/index.js")).href);
  const aiPath = [join(runtime!, "node_modules/@earendil-works/pi-ai/dist/index.js"), join(dirname(dirname(runtime!)), "@earendil-works/pi-ai/dist/index.js")].find(existsSync)!;
  const ai: any = await import(pathToFileURL(aiPath).href);
  const dir = mkdtempSync(join(root, "case-")), agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
  process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json");
  delete process.env.PI_SESSION_WRAPPER;
  writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode: options.mode ?? "enforce", main: { soft: 100, handoff: 200, hard: 1000, minProgress: 50 }, idleMinTokens: options.idle ? 50 : 100000 }));
  const faux = ai.fauxProvider({ provider: `context-budget-faux-${process.pid}-${++sequence}`, models: [{ id: "m" }] });
  const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  let probes = 0;
  const probe = (pi: any) => pi.registerTool({ name: "probe", label: "Probe", description: "A test probe", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => { probes++; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  const resourceLoader = new pc.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [...(options.before ? [options.before] : []), createContextBudgetExtension({ agentDir, hosts: options.hosts ?? new SessionHosts() }), probe] });
  await resourceLoader.reload();
  const sessionManager = pc.SessionManager.inMemory(dir);
  if (options.parent) sessionManager.newSession({ parentSession: options.parent });
  const { session } = await pc.createAgentSession({ cwd: dir, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime,
    resourceLoader, noTools: "builtin", sessionManager, settingsManager });
  await session.bindExtensions({ mode: "print" });
  // Keep real lifecycle/compaction routing, but isolate the policy from faux-provider
  // bootstrap estimates (which otherwise exceed these deliberately tiny thresholds).
  let observedTokens = 100;
  session.extensionRunner.getContextUsageFn = () => ({ tokens: observedTokens });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  };
  t.after(close);
  const reply = (text: string | any[], tokens = 100) => {
    const m = ai.fauxAssistantMessage(text, { stopReason: Array.isArray(text) ? "toolUse" : "stop" });
    m.usage = { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return m;
  };
  return { session, sessionManager, faux, ai, dir, reply, close, probes: () => probes, setTokens: (n: number) => { observedTokens = n; },
    status: () => JSON.parse(readFileSync(join(dir, "state/status", `${sessionManager.getSessionId()}.json`), "utf8")) };
}
test("real pi agent_start during settle continuation does not reset the one-continuation bound", { skip }, async t => {
  const h = await setup(t);
  h.faux.setResponses([h.reply("first"), h.reply("second", 300), h.reply("settled", 300)]);
  await h.session.prompt("first request");
  h.setTokens(1200); // Hard recovery is independent of faux's synthesized usage/floor.
  await h.session.prompt("next request");
  assert.equal(h.faux.state.callCount, 3); // second prompt: exactly one continuation
});
test("real pi warm-cache continuation commits a handoff at turn end", { skip }, async t => {
  const key = Symbol.for("pi-jobs.liveManagers"), global = globalThis as Record<symbol, unknown>, old = global[key];
  global[key] = new Set([{ list: () => [{ status: "running" }] }]);
  try {
    const h = await setup(t, { idle: true });
    h.faux.setResponses([h.reply("waiting"), h.reply([h.ai.fauxToolCall("context_handoff", { goal: "wait", next_step: "consume job", facts: "pending work" })]), h.reply("stored")]);
    await h.session.prompt("work waits on a job");
    assert.equal(h.faux.state.callCount, 3);
    assert.equal(h.sessionManager.getBranch().filter((e: any) => e.type === "compaction").length, 1);
    assert.ok(h.status().lastHandoffPath);
  } finally { global[key] = old; }
});
test("real pi Nothing-to-compact failure does not block the next tool", { skip }, async t => {
  const h = await setup(t);
  await assert.rejects(h.session.compact(), /Nothing to compact/);
  h.faux.setResponses([h.reply([h.ai.fauxToolCall("probe", {})]), h.reply("complete")]);
  await h.session.prompt("use probe");
  assert.equal(h.probes(), 1);
  assert.equal(h.status().fallbackReason, null);
});
test("real pi cancellation after our backstop hook disarms the active attempt", { skip }, async t => {
  let session: any, intercepted = false;
  const h = await setup(t, { before: (pi: any) => pi.on("session_before_compact", () => { intercepted = true; session.abortCompaction(); }) });
  session = h.session;
  h.faux.setResponses([h.reply("history ".repeat(100))]);
  await session.prompt("establish compactable history");
  await assert.rejects(session.compact(), /cancelled/);
  assert.equal(intercepted, true);
  h.faux.setResponses([h.reply([h.ai.fauxToolCall("probe", {})]), h.reply("complete")]);
  await session.prompt("use probe after cancellation");
  assert.equal(h.probes(), 1);
  assert.equal(h.status().fallbackReason, null);
});
for (const mode of ["observe", "off"]) test(`real pi ${mode} keeps its native compaction summary and provider call`, { skip }, async t => {
  const h = await setup(t, { mode });
  h.faux.setResponses([h.reply("history ".repeat(100)), h.reply("native-summary")]);
  await h.session.prompt("establish history");
  const compacted = await h.session.compact();
  assert.match(compacted.summary, /native-summary$/); // Pi may add its normal split-turn wrapper.
  assert.doesNotMatch(compacted.summary, /Compaction instance:|# Emergency handoff/);
  assert.equal(h.faux.state.callCount, 2);
  const entry = h.sessionManager.getBranch().findLast((e: any) => e.type === "compaction");
  assert.notEqual(entry.fromHook, true);
});
test("real SDK hosting marks in-memory children and releases the primary before fork/resume replacement", { skip }, async t => {
  const hosts = new SessionHosts();
  const main = await setup(t, { hosts, parent: "/old-main.jsonl" });
  assert.equal(main.status().role, "main");
  const child = await setup(t, { hosts });
  assert.equal(child.sessionManager.getHeader().parentSession, undefined);
  assert.equal(child.status().role, "subagent");
  await child.close(); await main.close();
  const fork = await setup(t, { hosts, parent: "/fork-source.jsonl" });
  assert.equal(fork.status().role, "main");
});
