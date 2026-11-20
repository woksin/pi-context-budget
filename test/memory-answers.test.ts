import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAnswer, readAnswers } from "../src/memory/answers.ts";
import { createRequestsHook } from "../src/memory/requests-hook.ts";
import { makeIdSet } from "../src/memory/idset.ts";
import { answersBytes } from "../src/memory/requests.ts";
import { FileMemoryStore } from "../src/memory/store.ts";
import { newId } from "../src/memory/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = { id: "s1", role: "main" as const };
const parts = { session, runId: "run", requests: { count: 0, ids: [] }, kind: "final" as const, stopReason: "stop", turn: 1 };
function home() {
  const dir = mkdtempSync(join(tmpdir(), "answer-review-")); dirs.push(dir);
  return new FileMemoryStore({ agentDir: dir }).home;
}
async function hook(options: { capBytes?: number; failBlob?: boolean; scanner?: string; all?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "answer-hook-")); dirs.push(dir);
  const configFile = join(dir, "config.json"), logs: unknown[] = [];
  writeFileSync(configFile, JSON.stringify({ memory: { journal: true, requests: true, answers: options.all ? "all" : "final", scope: { mode: "all" } } }));
  if (options.scanner) { mkdirSync(join(dir, "lib")); writeFileSync(join(dir, "lib/secret-mask.ts"), options.scanner); }
  const store = new FileMemoryStore({ agentDir: dir });
  const request = store.appendMessage({ id: newId(), at: new Date().toISOString(), session, cwd: dir, origin: "human", originEvidence: [], text: "task", withheld: null, redactions: [] });
  const ctx = { cwd: dir, sessionManager: { getSessionId: () => session.id } };
  const h = createRequestsHook({ agentDir: dir, configFile, host: () => undefined, capBytes: options.capBytes,
    ...(options.failBlob ? { blobWriter: () => { throw Error(["private", "failure"].join("-")); } } : {}), log: (_ctx, event, data) => logs.push({ event, data }) });
  h.reload(); await h.onJournaled(request, ctx); h.agentStart();
  const answer = async (value: string, interim = false, model?: string) => {
    await h.messageStart({ role: "assistant" }, ctx);
    await h.messageEnd({ role: "assistant", content: [{ type: "text", text: value }, ...(interim ? [{ type: "toolCall" }] : [])], stopReason: "stop", model }, ctx);
  };
  return { h, ctx, answer, logs, home: store.home, request };
}

test("answer records use serialized bytes (including escaping/metadata), strictly below 8 KiB", () => {
  const dir = home();
  for (const value of ["x".repeat(9000), '"'.repeat(4500), "🙂".repeat(2300)]) {
    appendAnswer(dir, newId(), parts, { text: value, withheld: null, redactions: [] });
  }
  for (const line of readFileSync(join(dir, "answers/s1.jsonl"), "utf8").split("\n").filter(Boolean)) assert.ok(Buffer.byteLength(line) < 8192);
  assert.deepEqual(readAnswers(dir, "s1").map(a => a.text), ["x".repeat(9000), '"'.repeat(4500), "🙂".repeat(2300)]);
});

test("the exact serialized 8191/8192-byte boundary includes CRC and metadata", () => {
  const dir = home();
  const seed = appendAnswer(dir, "edge0", parts, { text: "x".repeat(7000), withheld: null, redactions: [] });
  const size = Buffer.byteLength(JSON.stringify({ ...seed, crc: "00000000" }));
  const length = 7000 + 8191 - size;
  const below = appendAnswer(dir, "edge1", parts, { text: "x".repeat(length), withheld: null, redactions: [] });
  assert.equal(Buffer.byteLength(JSON.stringify({ ...below, crc: "00000000" })), 8191);
  assert.equal(below.blob, undefined);
  const at = appendAnswer(dir, "edge2", parts, { text: "x".repeat(length + 1), withheld: null, redactions: [] });
  assert.ok(at.blob);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...at, crc: "00000000" })) < 8192);
});

test("volume accounting includes answer bodies and request-set blobs without double counting", () => {
  const dir = home(), value = "body ".repeat(4000);
  appendAnswer(dir, "a1", parts, { text: value, withheld: null, redactions: [] });
  appendAnswer(dir, "a2", parts, { text: value, withheld: null, redactions: [] });
  const requests = makeIdSet(dir, Array.from({ length: 501 }, (_, i) => `r${i}`));
  appendAnswer(dir, "a3", { ...parts, requests }, { text: "small", withheld: null, redactions: [] });
  const fileBytes = Buffer.byteLength(readFileSync(join(dir, "answers/s1.jsonl")));
  assert.equal(answersBytes(dir, "s1"), fileBytes + Buffer.byteLength(value) + Buffer.byteLength(Array.from({ length: 501 }, (_, i) => `r${i}`).sort().join("\n")));
});

for (const all of [false, true]) test(`cap applies to ${all ? "immediate" : "boundary-flushed"} interims; finals always kept`, async () => {
  const h = await hook({ capBytes: 1000, all });
  await h.answer("large final ".repeat(2000));
  await h.answer("compacting now", true);
  await h.h.commit(h.ctx, undefined, false);
  assert.deepEqual(readAnswers(h.home, "s1").map(a => a.kind), ["final"]);
  assert.equal(h.h.carried().lastAnswer?.kind, "final");
  assert.equal(h.h.health().interimsDropped, 1);
});

test("blob failure is loud, omits raw error text and closures, carries last answer and open request", async () => {
  const h = await hook({ failBlob: true });
  await h.answer("large answer ".repeat(1000));
  assert.equal(readAnswers(h.home, "s1").length, 0);
  assert.deepEqual(h.h.carried().open, [h.request.id]);
  assert.equal(h.h.carried().lastAnswer?.body.text, "large answer ".repeat(1000));
  assert.equal(h.h.carried().degraded, "answer_write");
  assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(["private", "failure"].join("-")));
  assert.ok(h.logs.length);
});

test("answer redactor failure withholds body and metadata fail-closed", async () => {
  const h = await hook({ scanner: "export const scan = () => { throw Error('scanner'); };" });
  await h.answer("answer body", false, ["model", "private"].join("-"));
  const [answer] = readAnswers(h.home, "s1");
  assert.equal(answer.text, null); assert.equal(answer.withheld, "redactor_failed");
  assert.equal(answer.model, undefined);
});

test("boundary flush enforces the cap between each pending interim, including blob bodies", async () => {
  const h = await hook({ capBytes: 1000 });
  for (let i = 0; i < 3; i++) await h.answer(`interim ${i} `.repeat(1000), true);
  await h.h.commit(h.ctx, undefined, false);
  assert.equal(readAnswers(h.home, "s1").length, 1);
  assert.equal(h.h.health().interimsDropped, 2);
});

test("model metadata is redacted, not an alternate plaintext persistence path", async () => {
  const h = await hook();
  const canary = ["gh", "p_", "A".repeat(36)].join("");
  await h.answer("answer", false, canary);
  assert.ok(!readFileSync(join(h.home, "answers/s1.jsonl"), "utf8").includes(canary));
});
