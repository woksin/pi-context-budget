import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowHarness } from "./overflow-harness.ts";

function assertRecovery(h: Awaited<ReturnType<typeof overflowHarness>>, compact: number, sent: number) {
  assert.deepEqual({ compact: h.compactions(), sent: h.sent().length }, { compact, sent });
}
async function withGuardOff(check: (key: symbol, global: Record<symbol, unknown>) => Promise<void>) {
  const key = Symbol.for("context-budget:test-guard"), global = globalThis as Record<symbol, unknown>;
  global[key] = true;
  try { await check(key, global); } finally { delete global[key]; }
}
test("guard-off overflow compacts and continues once, then exhausts until real progress", async () => {
  const h = await overflowHarness({ mode: "enforce", guarded: true });
  await withGuardOff(async () => {
    await h.recover();
    assertRecovery(h, 1, 1);
    assert.match(h.sent()[0].text, /Continue the interrupted task/);
    assert.equal(h.status().mode, "off");
    await h.emit("input", { source: "extension" });
    await h.recover();
    assertRecovery(h, 1, 1);
    assert.ok(h.events().some(e => e.event === "overflow_recovery_exhausted"));
    assert.match(h.notifications.at(-1)!, /Context overflow persists after one automatic compact-and-retry/);
    await h.turn(100);
    await h.recover();
    assertRecovery(h, 2, 2);
  });
});
for (const hook of ["session_before_compact", "session_compact", "session_compact_failed"]) test(`native overflow ${hook} suppresses package recovery`, async () => {
  const h = await overflowHarness();
  await h.overflow();
  await h.emit(hook, { reason: "overflow", errorMessage: "failed", fromExtension: false });
  await h.settle();
  assertRecovery(h, 0, 0);
  assert.equal(h.events().filter(e => e.event === "overflow_native").length, 1);
});
for (const variant of ["aborted", "off", "disabled", "rate-limit"]) test(`${variant} does not recover overflow`, async () => {
  const h = await overflowHarness({ mode: variant === "off" ? "off" : "observe", config: { overflowRecovery: variant !== "disabled" } });
  if (variant === "rate-limit") await h.overflow("rate limit: too many tokens per minute");
  else await h.overflow();
  await h.settle(variant === "aborted");
  assertRecovery(h, 0, 0);
});
test("failed native summarizer gets exactly one mechanical compaction in the same retry", async () => {
  const h = await overflowHarness({ outcome: "fail-error" });
  h.duringCompact(async () => { if (h.compactions() === 2) h.setCompact("ok"); });
  await h.recover();
  assertRecovery(h, 2, 1);
  const c = h.lastCompactResult().compaction;
  assert.equal(c.firstKeptEntryId, "k1"); assert.equal(c.tokensBefore, 999);
  assert.equal(c.details.kind, "overflow-mechanical");
  assert.match(c.summary, /# Emergency compaction after context overflow/);
  assert.match(c.summary, /Compaction instance:/);
  assert.ok(h.events().some(e => e.event === "overflow_compacted" && e.method === "mechanical"));
  assert.equal(h.status().handoffCount, 0);
});
test("mechanical failure stops after two compactions", async () => {
  const h = await overflowHarness({ outcome: "fail-error" });
  await h.recover();
  assertRecovery(h, 2, 0);
  assert.ok(h.events().some(e => e.event === "overflow_recovery_failed"));
});
test("busy continuation is queued as follow-up", async () => {
  const h = await overflowHarness();
  h.ctx.isIdle = () => false;
  await h.recover();
  assert.deepEqual(h.sent()[0].opts, { deliverAs: "followUp" });
});
test("aborted pending overflow cannot leak into a successful user turn and settle", async () => {
  const h = await overflowHarness();
  await h.overflow(); await h.settle(true);
  await h.emit("input", { source: "interactive" }); await h.turn(100);
  await h.settle();
  assertRecovery(h, 0, 0);
});
for (const invalidation of ["input", "success", "abort", "off", "disabled"]) test(`${invalidation} clears pending overflow before settle`, async () => {
  const h = await overflowHarness(); await h.overflow();
  if (invalidation === "input") await h.emit("input", { source: "interactive" });
  if (invalidation === "success") await h.turn(100);
  if (invalidation === "abort") await h.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
  if (invalidation === "off") h.setConfig({ mode: "off" });
  if (invalidation === "disabled") h.setConfig({ overflowRecovery: false });
  await h.settle();
  h.setConfig({ mode: "observe", overflowRecovery: true });
  await h.settle();
  assertRecovery(h, 0, 0);
});
for (const outcome of ["ok", "fail-error"]) for (const invalidation of ["input", "off", "disabled", "shutdown", "session", "new-overflow"]) {
  test(`${invalidation} during ${outcome} compaction invalidates callbacks`, async () => {
    const h = await overflowHarness({ outcome });
    h.duringCompact(async () => {
      if (invalidation === "input") await h.emit("input", { source: "interactive" });
      if (invalidation === "off") h.setConfig({ mode: "off" });
      if (invalidation === "disabled") h.setConfig({ overflowRecovery: false });
      if (invalidation === "shutdown") await h.emit("session_shutdown");
      if (invalidation === "session") await h.emit("session_start");
      if (invalidation === "new-overflow") await h.overflow();
    });
    await h.recover();
    assertRecovery(h, 1, 0);
    assert.ok(!h.events().some(e => e.event === "overflow_compact_fallback"));
  });
}
test("external input re-arms exhausted recovery", async () => {
  const h = await overflowHarness();
  await h.recover();
  await h.emit("input", { source: "interactive" });
  await h.recover();
  assertRecovery(h, 2, 2);
});
test("guard-off threshold warnings latch independently, re-arm, and never notify or enable guard", async () => {
  const h = await overflowHarness({ mode: "enforce", guarded: true });
  await withGuardOff(async (key, global) => {
    await h.turn(200); await h.turn(300); await h.turn(1000); await h.turn(1200);
    const warnings = () => h.events().filter(e => e.event === "guard_off_threshold");
    assert.deepEqual(warnings().map(e => e.threshold), ["handoff", "hard"]);
    assert.equal(warnings()[0].limit, 200); assert.equal(warnings()[0].configured, "enforce");
    await h.turn(199); await h.turn(1000);
    assert.deepEqual(warnings().map(e => e.threshold), ["handoff", "hard", "handoff", "hard"]);
    global[key] = false; await h.turn(10); global[key] = true; await h.turn(1000);
    assert.equal(warnings().length, 6); assert.equal(global[key], true);
    assert.equal(h.notifications.length, 0);
    h.setConfig({ mode: "off" }); await h.emit("input", { source: "interactive" });
    await h.turn(10); await h.turn(1000); assert.equal(warnings().length, 6);
  });
});
test("guard-on sessions never log guard-off threshold warnings", async () => {
  const h = await overflowHarness({ guarded: true }); await h.turn(1200);
  assert.ok(!h.events().some(e => e.event === "guard_off_threshold"));
});
