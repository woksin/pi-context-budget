import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReleaseRuntime, releaseFixture, STAGE_ZERO } from "./fixtures/release-runtime.ts";

// Golden generated once from tag v0.10.1, not from current sources:
//   git archive v0.10.1 src | tar -xf - -C <empty .ai-work/tag-dir>
//   JSON.stringify(await releaseFixture(undefined, pathToFileURL("<tag-dir>/src/")), null, 2) + "\n"
// Run that expression from this package with the installed peer. The fixture normalises
// only its temporary root and handoff timestamp; provider messages and tool schemas are untouched.
const baseline = JSON.parse(readFileSync(new URL("./fixtures/release-v0.10.1.json", import.meta.url), "utf8"));

for (const [name, memory] of [["absent memory block", undefined], ["stage-0 all flags false", STAGE_ZERO]] as const) {
  test(`v0.10.1 bytes: ${name} preserves handoff, provider contexts and registered tools`, async () => {
    assert.deepEqual(await releaseFixture(memory), baseline);
  });
}

async function finalAnswer(emit: Awaited<ReturnType<typeof createReleaseRuntime>>["emit"], text: string) {
  await emit("agent_start");
  await emit("message_start", { message: { role: "assistant" } });
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
}

test("requests rollback on next input removes carrier, stops answer/boundary/closure writes and restores baseline handoff", async () => {
  const memory = { journal: true, requests: true, scope: { mode: "all" } };
  const h = await createReleaseRuntime(memory);
  await h.emit("input", { text: "answer this first", source: "interactive" });
  await finalAnswer(h.emit, "first answer");
  await h.emit("input", { text: "still open", source: "interactive" });
  await h.emit("session_compact", { reason: "manual", fromExtension: false, compactionEntry: { id: "before" } });
  const event = { type: "context", messages: [] };
  assert.match(JSON.stringify(await h.emit("context", event)), /still open/);
  const eventsFile = join(h.agentDir, "memory/events.jsonl");
  const answersFile = join(h.agentDir, "memory/answers/s.jsonl");
  const events = readFileSync(eventsFile, "utf8"), answers = readFileSync(answersFile, "utf8");
  assert.match(events, /"type":"boundary"/);
  assert.match(events, /"type":"request_close"/);
  assert.match(answers, /first answer/);

  writeFileSync(h.configFile, JSON.stringify({ mode: "enforce", memory: { ...memory, requests: false } }));
  await h.emit("input", { text: "after rollback", source: "interactive" });
  await finalAnswer(h.emit, "must not persist");
  await h.emit("session_compact", { reason: "manual", fromExtension: false, compactionEntry: { id: "after" } });
  assert.equal(await h.emit("context", event), undefined);
  assert.equal(await h.handoff(), baseline.handoff);
  assert.equal(readFileSync(eventsFile, "utf8"), events);
  assert.equal(readFileSync(answersFile, "utf8"), answers);
});
