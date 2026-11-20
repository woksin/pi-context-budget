import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRuntime } from "./runtime.ts";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import { overflowHarness } from "./overflow-harness.ts";
import { createCarrier } from "../src/memory/carrier.ts";
import { REQUEST_MARKER, renderRequests } from "../src/memory/render-requests.ts";

const block = renderRequests({ sessionId: "main", requests: [{ id: "r", text: "open user prompt" }] });
function fixture() {
  const sent: any[] = [], calls: any[] = [];
  const pi: any = { sendMessage: (...args: any[]) => sent.push(args) };
  const ctx: any = { isIdle: () => true };
  const native = async (...args: any[]) => { calls.push(args); return { summary: "native quality summary", firstKeptEntryId: "tail", tokensBefore: 99, details: { native: true } }; };
  let text = block;
  const carrier = createCarrier({ render: async () => text, summarize: native });
  return { carrier, ctx, pi, calls, sent, setText: (value: string) => { text = value; } };
}

test("(f,h) threshold/pre-request, overflow and manual overrides precede retry, retain native summary and tail", async () => {
  for (const mode of ["observe", "guard-off", "enforce"]) for (const reason of ["threshold", "overflow", "manual"]) {
    const h = fixture();
    const preparation = { firstKeptEntryId: "tail", tokensBefore: 99 };
    const result = await h.carrier.beforeCompact({ reason, preparation }, h.ctx, undefined);
    assert.match(result!.compaction!.summary, /native quality summary/);
    assert.match(result!.compaction!.summary, /open user prompt/, mode);
    assert.equal(result!.compaction!.firstKeptEntryId, "tail");
    assert.deepEqual(result!.compaction!.details, { native: true }); assert.equal(h.calls.length, 1);
    await h.carrier.compacted(h.pi, { compactionEntry: { id: reason, summary: result!.compaction!.summary } }, h.ctx);
    assert.equal(h.sent.length, 0); // summary, not a streaming queued message, is the next-request carrier
  }
});

test("(g) package mechanical/backstop/handoff summaries embed exactly once without another model call", async () => {
  const h = fixture();
  const base: any = { compaction: { summary: "mechanical fallback", firstKeptEntryId: null, tokensBefore: 100 } };
  const one = await h.carrier.beforeCompact({}, h.ctx, base);
  const two = await h.carrier.beforeCompact({}, h.ctx, one);
  assert.equal(two!.compaction!.summary.split(REQUEST_MARKER).length - 1, 1);
  assert.equal(h.calls.length, 0);
  await h.carrier.compacted(h.pi, { compactionEntry: { id: "package", summary: two!.compaction!.summary } }, h.ctx);
  assert.equal(h.sent.length, 0);
});

test("idle-only fallback persists one custom carrier before next request; streaming never relies on queueing", async () => {
  const h = fixture(), event = { compactionEntry: { id: "boundary", summary: "native" } };
  await h.carrier.compacted(h.pi, event, h.ctx); await h.carrier.compacted(h.pi, event, h.ctx);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0][0].customType, "context-budget-requests");
  assert.equal(h.sent[0][1].triggerTurn, false); assert.match(h.sent[0][0].content, /open user prompt/);
  h.ctx.isIdle = () => false;
  await h.carrier.compacted(h.pi, { compactionEntry: { id: "streaming", summary: "native" } }, h.ctx);
  assert.equal(h.sent.length, 1);
});

test("(j) prompt queued during summarization is included in the resulting primary carrier", async () => {
  let text = block;
  const carrier = createCarrier({ render: async () => text, summarize: async () => {
    text = block + "\nnew prompt arrived during compaction";
    return { summary: "native", firstKeptEntryId: "tail", tokensBefore: 1 };
  } });
  const result = await carrier.beforeCompact({}, {} as any, undefined);
  assert.match(result!.compaction!.summary, /new prompt arrived during compaction/);
});

test("(g) real overflow episode mechanical recovery embeds the requests once", async () => {
  const h = await overflowHarness({ mode: "enforce", config: { memory: { journal: true, requests: true, scope: { mode: "all" } } } });
  (h.ctx as any).hasUI = true;
  await h.emit("input", { text: "first launch", source: "interactive" });
  await h.emit("input", { text: "still open package request", source: "interactive" });
  await h.recover();
  const summary = h.lastCompactResult()?.compaction?.summary;
  assert.ok(summary); assert.match(summary, /still open package request/);
  assert.equal(summary.split(REQUEST_MARKER).length - 1, 1);
});

test("(f,h) real pi streaming overflow and threshold carry into the very next provider request in every enforcement mode", async t => {
  const runtime = findRuntime(); assert.ok(runtime);
  const pc: any = await import(pathToFileURL(join(runtime, "dist/index.js")).href);
  const ai: any = await import("@earendil-works/pi-ai");
  for (const mode of ["observe", "guard-off", "enforce"]) for (const reason of ["threshold", "overflow"]) await t.test(`${mode}/${reason}`, async t => {
    const root = resolve(import.meta.dirname, "../.ai-work/carrier-runtime"); mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "case-")), agentDir = join(dir, "agent"); mkdirSync(agentDir);
    delete process.env.PI_MEMORY_HOME;
    process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "config.json"); process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state");
    writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, JSON.stringify({ mode: mode === "guard-off" ? "enforce" : mode, memory: { journal: true, requests: true, scope: { mode: "all" } } }));
    if (mode === "guard-off") { mkdirSync(join(agentDir, "lib")); writeFileSync(join(agentDir, "lib/guards.ts"), "export const isGuardOff = () => true;"); }
    const faux = ai.fauxProvider({ provider: `delivery-${mode}-${reason}`, models: [{ id: "m", contextWindow: 1000000 }] });
    const modelRuntime = await pc.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }); modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = pc.SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16 }, retry: { enabled: false } });
    const resourceLoader = new pc.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noExtensions: true,
      extensionFactories: [createContextBudgetExtension({ agentDir, hosts: new SessionHosts(), launchFacts: () => ({ initialPrompt: null, relaunchPrompt: null }) })] });
    await resourceLoader.reload();
    const { session } = await pc.createAgentSession({ cwd: dir, agentDir, model: faux.getModel(), thinkingLevel: "off", modelRuntime, resourceLoader, noTools: "builtin", sessionManager: pc.SessionManager.inMemory(dir), settingsManager });
    t.after(async () => { await session.abort(); session.dispose(); });
    await session.bindExtensions({ mode: "interactive", uiContext: { notify() {}, setStatus() {} } });
    faux.setResponses([ai.fauxAssistantMessage("prior delivered answer")]); await session.prompt("prior question");
    const next = (context: any) => {
      const contextText = JSON.stringify(context.messages);
      assert.ok(contextText.includes(REQUEST_MARKER), `${mode}/${reason} next request missing carrier`);
      assert.ok(contextText.includes(reason === "overflow" ? "open retry question" : "prior delivered answer"));
      return ai.fauxAssistantMessage("retried answer");
    };
    if (reason === "threshold") {
      faux.setResponses(mode === "enforce" ? [] : [ai.fauxAssistantMessage("native model summary")]);
      await session._runAutoCompaction("threshold", false);
      faux.setResponses([next]); await session.prompt("follow up after threshold");
    } else {
      faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 1000464 tokens > 1000000 maximum" }),
        ...(mode === "enforce" ? [] : [ai.fauxAssistantMessage("native model summary"), ai.fauxAssistantMessage("native prefix summary")]), next]);
      await session.prompt("open retry question");
    }
    const entries = session.sessionManager.getEntries();
    const boundary = entries.findLast((e: any) => e.type === "compaction");
    assert.ok(boundary);
    assert.match(boundary.summary, mode === "enforce" ? /Emergency handoff/ : /native model summary/);
    assert.equal(boundary.summary.split(REQUEST_MARKER).length - 1, 1);
    assert.equal(entries.filter((e: any) => e.customType === "context-budget-requests").length, 0);
    assert.equal(faux.state.callCount, mode === "enforce" ? (reason === "threshold" ? 2 : 3) : (reason === "threshold" ? 3 : 5));
  });
});

test("(l) disabled/empty projection does not override native compaction or send a message; cancellation is preserved", async () => {
  const h = fixture(); h.setText("");
  assert.equal(await h.carrier.beforeCompact({}, h.ctx, undefined), undefined);
  await h.carrier.compacted(h.pi, { compactionEntry: { id: "off", summary: "native" } }, h.ctx);
  assert.equal(h.sent.length, 0); assert.equal(h.calls.length, 0);
  h.setText(block); assert.deepEqual(await h.carrier.beforeCompact({}, h.ctx, { cancel: true }), { cancel: true });
});
