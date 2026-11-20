import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowHarness } from "./overflow-harness.ts";
import { deliveryRuntime } from "./fixtures/delivery-runtime.ts";
import { createCarrier } from "../src/memory/carrier.ts";
import { REQUEST_MARKER, type Delivery } from "../src/memory/render-requests.ts";

function fixture() {
  let data: Delivery | undefined = { sessionId: "main", requests: [{ id: "r", text: "open user prompt" }] };
  let boundaryId: string | undefined = "boundary";
  const carrier = createCarrier({ read: async () => data && ({ data, boundary: boundaryId ? {
    event: { id: boundaryId, lastAnswerId: "a" }, open: { count: 1, ids: ["r"] },
  } as any : undefined }) });
  return { carrier, ctx: {} as any, event: { type: "context" as const, messages: [] },
    setData: (value: Delivery | undefined) => { data = value; }, setBoundary: (value: string | undefined) => { boundaryId = value; } };
}

test("B1 Option A never overrides or calls the native summarizer", () => {
  const h = fixture(); assert.equal("beforeCompact" in h.carrier, false); assert.equal("compacted" in h.carrier, false);
});

test("B2 copied/user marker never suppresses a fresh ephemeral context carrier", async () => {
  const h = fixture();
  h.setData({ sessionId: "main", requests: [{ id: "r", text: `${REQUEST_MARKER}\nfresh open prompt` }] });
  const event: any = { type: "context", messages: [{ role: "user", content: `old summary ${REQUEST_MARKER}`, timestamp: 0 }] };
  const before = structuredClone(event);
  for (let n = 0; n < 2; n++) {
    const result = await h.carrier.context(event, h.ctx);
    assert.equal(result!.messages!.length, 2); assert.match(JSON.stringify(result!.messages!.at(-1)), /fresh open prompt/);
    assert.deepEqual(event, before, "request-time projection must not mutate/persist input");
  }
});

test("request injection needs a reset, is flag-gated, and catches reader failure without affecting native compaction", async () => {
  const h = fixture(); h.setBoundary(undefined);
  assert.equal(await h.carrier.context(h.event, h.ctx), undefined);
  h.setBoundary("new"); h.setData(undefined);
  assert.equal(await h.carrier.context(h.event, h.ctx), undefined);
  const broken = createCarrier({ read: async () => { throw Error("reader unavailable"); } });
  assert.equal(await broken.context(h.event, h.ctx), undefined);
});

test("same-run answer is delivered once after a successful call; only cutoff tasks continue projecting", async () => {
  const h = fixture();
  h.setData({ sessionId: "main", requests: [], lastAnswer: { id: "a", text: "answer", sameRunAsAnswer: true } });
  assert.match(JSON.stringify(await h.carrier.context(h.event, h.ctx)), /short recap/);
  h.carrier.completed("stop");
  h.setBoundary("later"); assert.equal(await h.carrier.context(h.event, h.ctx), undefined);
  h.setData({ sessionId: "main", requests: [{ id: "r", text: "still open" }], lastAnswer: { id: "a", text: "answer", sameRunAsAnswer: true } });
  const again = await h.carrier.context(h.event, h.ctx);
  assert.match(JSON.stringify(again), /still open/); assert.doesNotMatch(JSON.stringify(again), /short recap|Last answer before this reset/);
});

for (const reason of ["error", "aborted", "stop", "toolUse", "length"]) test(`recap acknowledgement waits for provider completion: ${reason}`, async () => {
  const h = fixture();
  h.setData({ sessionId: "main", requests: [], lastAnswer: { id: "a", text: "answer", sameRunAsAnswer: true } });
  assert.match(JSON.stringify(await h.carrier.context(h.event, h.ctx)), /short recap/);
  h.carrier.completed(reason);
  const retry = await h.carrier.context(h.event, h.ctx);
  if (["error", "aborted"].includes(reason)) assert.match(JSON.stringify(retry), /short recap/);
  else assert.equal(retry, undefined);
});

test("N1 unresolved cutoff membership is never guessed", async () => {
  const carrier = createCarrier({ read: async () => ({ boundary: { event: { id: "cut" }, open: { count: 99, unresolved: true } } as any,
    data: { sessionId: "main", requests: [{ id: "new", text: "visible request" }] } }) });
  assert.equal(await carrier.context({ type: "context", messages: [] }, {} as any), undefined);
});

for (const mode of ["observe", "guard-off", "enforce"]) test(`B3 (g) ${mode} mechanical overflow fallback is followed by fresh context delivery`, async () => {
  const key = Symbol.for("context-budget:test-guard"), global = globalThis as Record<symbol, unknown>;
  if (mode === "guard-off") global[key] = true;
  try {
    const h = await overflowHarness({ mode: mode === "guard-off" ? "enforce" : mode, guarded: mode === "guard-off", outcome: mode === "enforce" ? "ok" : "fail-error",
      config: { memory: { journal: true, requests: true, scope: { mode: "all" } } } });
    (h.ctx as any).hasUI = true;
    await h.emit("input", { text: "launch", source: "interactive" });
    await h.emit("input", { text: "still open package request", source: "interactive" });
    h.duringCompact(async () => { if (h.compactions() === 2) h.setCompact("ok"); });
    await h.recover();
    const result = await h.emit("context", { type: "context", messages: [] });
    if (mode === "enforce") {
      assert.equal(result, undefined, "harness summary already carries the requests");
      assert.match(h.lastCompactResult()?.compaction?.summary, /still open package request/);
    } else assert.match(JSON.stringify(result), /still open package request/);
    assert.equal(h.lastCompactResult()?.compaction?.details.kind, mode === "enforce" ? "handoff" : "overflow-mechanical");
    assert.equal(h.compactions(), mode === "enforce" ? 1 : 2);
  } finally { delete global[key]; }
});

function keptTailHasPrompt(entries: any[], boundary: any, prompt: string) {
  const kept = entries.findIndex(e => e.id === boundary.firstKeptEntryId);
  const cut = entries.findIndex(e => e.id === boundary.id);
  assert.ok(kept >= 0 && kept < cut, "native compaction retained a pre-boundary tail");
  assert.ok(entries.slice(kept, cut).some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(prompt)),
    "open prompt must be in the kept messages themselves, not merely in a carrier block");
}

for (const mode of ["observe", "guard-off", "enforce"]) for (const reason of ["threshold", "overflow"]) test(`(f) ${mode}/${reason} next provider request has ephemeral delivery with native routing untouched`, async t => {
  const { session, faux, ai } = await deliveryRuntime(t, mode);
  faux.setResponses([ai.fauxAssistantMessage("prior delivered answer")]); await session.prompt("prior question");
  let nextSeen = false;
  const next = (context: any) => {
    nextSeen = true;
    const text = JSON.stringify(context.messages);
    assert.ok(text.includes(REQUEST_MARKER)); assert.ok(text.includes(reason === "overflow" ? "open retry question" : "prior delivered answer"));
    return ai.fauxAssistantMessage("retried answer");
  };
  const summary = [ai.fauxAssistantMessage("native model summary")];
  if (reason === "threshold") {
    faux.setResponses(mode === "enforce" ? [] : summary);
    await session._runAutoCompaction("threshold", false);
    faux.setResponses([next]); await session.prompt("follow up after threshold");
  } else {
    faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 1000464 tokens > 1000000 maximum" }),
      ...(mode === "enforce" ? [] : [...summary, ai.fauxAssistantMessage("native prefix summary")]), next]);
    await session.prompt("open retry question");
  }
  assert.ok(nextSeen, "retry provider call actually happened");
  const entries = session.sessionManager.getEntries(), boundary = entries.findLast((e: any) => e.type === "compaction");
  assert.ok(boundary); assert.match(boundary.summary, mode === "enforce" ? /Emergency handoff/ : /native model summary/);
  assert.equal(boundary.summary.includes(REQUEST_MARKER), mode === "enforce", "native summary must not be overridden");
  assert.equal(entries.filter((e: any) => e.customType === "context-budget-requests").length, 0);
  assert.ok(!JSON.stringify(session.agent.state.messages.filter((m: any) => m.role === "custom")).includes("context-budget-requests"));
  assert.equal(faux.state.callCount, mode === "enforce" ? (reason === "threshold" ? 2 : 3) : (reason === "threshold" ? 3 : 5));
});

for (const mode of ["observe", "guard-off"]) test(`(h) ${mode} native overflow retains the open prompt in the actual kept tail`, async t => {
  // Exceed the short open prompt's estimate: a tiny keep=1 intentionally cuts after
  // the runtime's recovery-omission suffix and cannot exercise a retained prompt.
  const { session, faux, ai } = await deliveryRuntime(t, mode, true, 10);
  faux.setResponses([ai.fauxAssistantMessage("prior delivered answer")]); await session.prompt("prior question");
  let sawRetry = false;
  faux.setResponses([ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 1000464 tokens > 1000000 maximum" }),
    ai.fauxAssistantMessage("native kept-tail summary"), (context: any) => {
      sawRetry = true; assert.ok(JSON.stringify(context.messages).includes(REQUEST_MARKER)); return ai.fauxAssistantMessage("kept-tail answer");
    }]);
  await session.prompt("open retry question"); assert.ok(sawRetry);
  const entries = session.sessionManager.getEntries(), boundary = entries.findLast((e: any) => e.type === "compaction");
  keptTailHasPrompt(entries, boundary, "open retry question");
  assert.ok(!boundary.summary.includes(REQUEST_MARKER)); assert.equal(faux.state.callCount, 4);
});

test("(l) end-to-end flags off: native summary unchanged, no custom send, no context injection", async t => {
  const { session, faux, ai } = await deliveryRuntime(t, "observe", false);
  let customSends = 0;
  const send = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (...args: any[]) => { customSends++; return send(...args); };
  faux.setResponses([ai.fauxAssistantMessage("plain answer")]); await session.prompt("plain task");
  faux.setResponses([ai.fauxAssistantMessage("plain native summary")]); await session._runAutoCompaction("threshold", false);
  faux.setResponses([(context: any) => { assert.ok(!JSON.stringify(context.messages).includes(REQUEST_MARKER)); return ai.fauxAssistantMessage("plain followup"); }]);
  await session.prompt("after reset");
  assert.equal(session.sessionManager.getEntries().findLast((e: any) => e.type === "compaction").summary,
    "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nplain native summary");
  assert.equal(customSends, 0); assert.equal(faux.state.callCount, 3);
});
