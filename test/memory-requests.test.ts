import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import { INLINE_IDS, makeIdSet, resolveIdSet } from "../src/memory/idset.ts";
import { appendAnswer, pickLastAnswer, readAnswers } from "../src/memory/answers.ts";
import { readSessionState } from "../src/memory/requests.ts";
import { processLaunchFacts, deriveLaunchFacts } from "../src/memory/launch.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const SESSION = { id: "s1", role: "main" as const };
const ON = { journal: true, requests: true, scope: { mode: "all" } };

async function harness(memory: unknown = ON, launchFacts = () => ({ initialPrompt: null, relaunchPrompt: null }) as ReturnType<typeof deriveLaunchFacts>) {
  const dir = mkdtempSync(join(tmpdir(), "memory-requests-")); dirs.push(dir);
  const agentDir = join(dir, "agent"), configFile = join(dir, "config.json");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CONTEXT_BUDGET_CONFIG = configFile; process.env.PI_CONTEXT_BUDGET_STATE_DIR = join(dir, "state"); delete process.env.PI_MEMORY_HOME;
  writeFileSync(configFile, JSON.stringify({ mode: "observe", ...(memory === "absent" ? {} : { memory }) }));
  const handlers = new Map<string, (e: any, ctx: ExtensionContext) => Promise<any>>();
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); }, registerTool() {}, getActiveTools: () => ["read"], getAllTools: () => [{ name: "read" }] } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, model: { provider: "t", id: "t" },
    sessionManager: { getSessionId: () => "s1", getSessionFile: () => join(dir, "session.jsonl"), getSessionName: () => undefined, getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: 10 }), shutdown() {}, ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
  await createContextBudgetExtension({ agentDir, hosts: new SessionHosts(), launchFacts })(pi);
  await handlers.get("session_start")!({}, ctx);
  const home = join(agentDir, "memory");
  const fire = (name: string, e: any = {}) => handlers.get(name)!(e, ctx);
  const human = (text: string) => fire("input", { text, source: "interactive" });
  const assistant = async (content: unknown[], stopReason = "stop") => {
    await fire("message_start", { message: { role: "assistant" } });
    await fire("message_end", { message: { role: "assistant", content, stopReason, model: "m" } });
  };
  const state = () => readSessionState(home, "s1");
  return { dir, home, fire, human, assistant, state, agentDir, trace: () => [...handlers.keys()] };
}
const text = (value: string) => ({ type: "text", text: value });

test("idSet: inline up to 32 ids, blob above; tampered blob is unresolved, never guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "idset-")); dirs.push(dir); mkdirSync(join(dir, "blobs"));
  const small = makeIdSet(dir, ["b", "a", "a"]);
  assert.deepEqual(small, { count: 2, ids: ["a", "b"] });
  const ids = Array.from({ length: INLINE_IDS + 1 }, (_, i) => `id${String(i).padStart(3, "0")}`);
  const big = makeIdSet(dir, ids);
  assert.ok("blob" in big && big.count === ids.length);
  assert.deepEqual(resolveIdSet(dir, big), { count: ids.length, ids });
  writeFileSync(join(dir, "blobs", (big as { blob: string }).blob), "tampered");
  assert.deepEqual(resolveIdSet(dir, big), { count: ids.length, unresolved: true });
  assert.deepEqual(resolveIdSet(dir, { count: 40, sha256: "x", blob: "../escape" } as never), { count: 40, unresolved: true });
});

test("last answer: latest substantive final, else latest final, else latest interim", () => {
  const a = (kind: "final" | "interim", textBytes: number, id: string) => ({ kind, textBytes, id });
  assert.equal(pickLastAnswer([a("final", 300, "1"), a("final", 10, "2"), a("interim", 900, "3")])?.id, "1");
  assert.equal(pickLastAnswer([a("final", 10, "1"), a("interim", 900, "2")])?.id, "1");
  assert.equal(pickLastAnswer([a("interim", 5, "1"), a("interim", 6, "2")])?.id, "2");
  assert.equal(pickLastAnswer([]), undefined);
});

test("answers: large body keeps head+tail inline and whole body in a verified blob; a bad line is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "answers-")); dirs.push(dir); mkdirSync(join(dir, "blobs")); mkdirSync(join(dir, "answers"));
  const big = "x".repeat(70 * 1024);
  appendAnswer(dir, "a1", { session: SESSION, runId: "r", requests: { count: 0, ids: [] }, kind: "final", stopReason: "stop", turn: 1 }, { text: big, withheld: null, redactions: [] });
  appendFileSync(join(dir, "answers", "s1.jsonl"), "garbage\n");
  const [only, ...rest] = readAnswers(dir, "s1");
  assert.equal(rest.length, 0);
  assert.equal(only.text, big);
  assert.equal(only.textBytes, big.length);
});

test("flags off or requests off: no answers, no events, no files", async () => {
  for (const memory of [{}, { journal: true, scope: { mode: "all" } }, { requests: true, scope: { mode: "all" } }]) {
    const h = await harness(memory);
    await h.human("hello"); await h.assistant([text("answer")]);
    assert.equal(existsSync(join(h.home, "answers", "s1.jsonl")), false, String(JSON.stringify(memory)));
    const events = join(h.home, "events.jsonl");
    assert.doesNotMatch(existsSync(events) ? readFileSync(events, "utf8") : "", /boundary|request_close/);
  }
});

test("memory absent and empty are structurally identical through the same lifecycle", async () => {
  const absent = await harness("absent"), empty = await harness({});
  assert.deepEqual(absent.trace(), empty.trace());
  for (const h of [absent, empty]) {
    await h.human("same task"); await h.fire("agent_start"); await h.assistant([text("same answer")]);
    await h.fire("turn_end", {}); await h.fire("session_compact", { compactionEntry: { id: "boundary" } }); await h.fire("agent_settled", { aborted: false });
    assert.equal(existsSync(h.home), false);
  }
  assert.deepEqual(absent.state(), empty.state());
});

test("request opens on human input, a final stop answer closes it, interim answers do not", async () => {
  const h = await harness();
  await h.human("do the thing");
  assert.equal(h.state().open.length, 1);
  await h.assistant([text("looking"), { type: "toolCall", id: "t" }], "toolUse");
  assert.equal(h.state().open.length, 1);
  assert.equal(existsSync(join(h.home, "answers", "s1.jsonl")), false, "interim not journaled by default");
  await h.assistant([text("done")]);
  const s = h.state();
  assert.equal(s.open.length, 0);
  assert.equal(s.requests[0].status, "answered");
  assert.equal(s.requests[0].answerIds.length, 1);
  assert.equal(s.answers[0].text, "done");
});

test("answers=all keeps interim answers; stopReason other than stop leaves the request open", async () => {
  const h = await harness({ ...ON, answers: "all" });
  await h.human("go");
  await h.assistant([text("step"), { type: "toolCall" }], "toolUse");
  await h.assistant([text("cut off")], "length");
  const s = h.state();
  assert.equal(s.answers.length, 2);
  assert.equal(s.open.length, 1);
});

test("open set survives a restart: a new extension instance rebuilds it from the files", async () => {
  const h = await harness();
  await h.human("first");
  await h.fire("session_compact", { reason: "manual", compactionEntry: { id: "restart-boundary" } });
  const again = readSessionState(h.home, "s1");
  assert.deepEqual(again.open.map(r => r.id), h.state().open.map(r => r.id));
  assert.equal(again.open.length, 1);
  assert.equal(again.open[0].interruptions, 1);
});

test("abort with open requests writes an abort boundary; compaction writes one boundary per entry", async () => {
  const h = await harness();
  await h.human("work");
  await h.assistant([text("partial"), { type: "toolCall" }], "aborted");
  await h.fire("agent_settled", { aborted: true });
  const abort = h.state().boundaries.filter(b => b.event.kind === "abort");
  assert.equal(abort.length, 1);
  assert.equal(h.state().requests[0].aborted, true);
  assert.deepEqual(abort[0].open, { count: 1, ids: [h.state().open[0].id] });
  await h.fire("session_compact", { fromExtension: false, reason: "manual", compactionEntry: { id: "c1" } });
  await h.fire("session_compact", { fromExtension: false, reason: "manual", compactionEntry: { id: "c1" } });
  assert.equal(h.state().boundaries.filter(b => b.event.compactionEntryId === "c1").length, 1);
});

test("a failed answer write degrades loudly, keeps the request open and never throws into pi", async () => {
  const h = await harness();
  await h.human("task");
  mkdirSync(join(h.home, "answers"), { recursive: true }); chmodSync(join(h.home, "answers"), 0o500);
  try { await h.assistant([text("final answer")]); } finally { chmodSync(join(h.home, "answers"), 0o700); }
  assert.equal(h.state().open.length, 1);
  const events = readFileSync(join(h.dir, "state", "events.jsonl"), "utf8");
  assert.match(events, /memory_degraded/);
});

test("streaming answer closes only its message-start snapshot, not a queued human prompt", async () => {
  const h = await harness(); await h.human("first");
  await h.fire("message_start", { message: { role: "assistant" } });
  await h.human("typed while streaming");
  await h.fire("message_end", { message: { role: "assistant", content: [text("done")], stopReason: "stop" } });
  assert.deepEqual(h.state().open.map(r => r.text), ["typed while streaming"]);
});

test("default interims flush at a boundary; tailing unseen state flips only then and replays identically", async () => {
  const h = await harness(); await h.human("task"); await h.fire("agent_start");
  await h.assistant([text("substantive answer ".repeat(30))]);
  const before = h.state(), id = before.answers[0].id;
  assert.equal(before.possiblyUnseen.has(id), false);
  await h.assistant([text("compacting now"), { type: "toolCall", name: "context_handoff" }]);
  assert.equal(h.state().answers.length, 1);
  await h.fire("session_compact", { reason: "manual", compactionEntry: { id: "tail-boundary" } });
  const after = h.state();
  assert.equal(after.answers.length, 2); assert.equal(after.possiblyUnseen.has(id), true);
  assert.equal(after.boundaries[0].event.lastAnswerId, id);
  assert.deepEqual(readSessionState(h.home, "s1"), after);
  assert.equal(before.possiblyUnseen.size, 0, "immutable earlier reader snapshot");
});

for (const reason of ["aborted", "error", "length"]) test(`${reason} partial final text persists without closing`, async () => {
  const h = await harness(); await h.human("task"); await h.assistant([text("partial final")], reason);
  assert.equal(h.state().open.length, 1); assert.equal(h.state().answers[0].text, "partial final");
  assert.equal(h.state().answers[0].kind, "final");
});

test("500+ requests replay exact blob membership and every persisted record is below 8 KiB", async () => {
  const h = await harness(); for (let i = 0; i < 501; i++) await h.human(`request ${i}`);
  const ids = h.state().open.map(r => r.id).sort();
  await h.assistant([text("working"), { type: "toolCall" }]);
  await h.fire("session_compact", { reason: "manual", compactionEntry: { id: "many" } });
  const s = readSessionState(h.home, "s1");
  assert.deepEqual(s.boundaries[0].open, { count: 501, ids });
  assert.deepEqual(resolveIdSet(h.home, s.answers[0].requests), { count: 501, ids });
  assert.ok("blob" in s.answers[0].requests); assert.ok("blob" in s.boundaries[0].event.openRequests);
  for (const file of ["journal/s1.jsonl", "answers/s1.jsonl", "events.jsonl"]) {
    for (const line of readFileSync(join(h.home, file), "utf8").split("\n").filter(Boolean)) assert.ok(Buffer.byteLength(line) < 8192);
  }
  const set = s.answers[0].requests; assert.ok("blob" in set);
  rmSync(join(h.home, "blobs", set.blob));
  assert.deepEqual(resolveIdSet(h.home, set), { count: 501, unresolved: true });
  writeFileSync(join(h.home, "blobs", set.blob), "corrupt");
  assert.deepEqual(readSessionState(h.home, "s1").boundaries[0].open, { count: 501, unresolved: true });
});

test("real argv/TTY derivation makes the first interactive input human; relaunch env fails closed", async () => {
  const h = await harness(ON, () => processLaunchFacts(["node", "pi"], true, {}));
  await h.human("first human input"); assert.equal(h.state().open.length, 1);
  assert.equal(h.state().requests[0].origin, "human");
  for (const name of ["PI_SESSION_WRAPPER", "PI_SESSION_MARKER_DIR", "PI_SESSION_LAUNCH_ID", "PI_SESSION_WRAPPER_PID", "PI_RELAUNCH_MARKER", "PI_RELAUNCH_FUTURE"]) {
    const hostile = await harness(ON, () => processLaunchFacts(["node", "pi"], true, { [name]: "present" }));
    await hostile.human("unverified input"); assert.equal(hostile.state().open.length, 0, name);
  }
});

test("launch facts fail closed: only an argv with no prompt on a TTY is verified", () => {
  assert.deepEqual(deriveLaunchFacts([], true, {}), { initialPrompt: null, relaunchPrompt: null });
  assert.deepEqual(deriveLaunchFacts(["--model", "x", "-c"], true, {}), { initialPrompt: null, relaunchPrompt: null });
  for (const [args, tty] of [[[], false], [[], undefined], [["fix the bug"], true], [["@brief.md"], true], [["--", "x"], true], [["-p"], true],
    [["--model"], true], [["--model", "@x"], true], [["--plan"], true], [["continue from /h.md"], true]] as const) {
    assert.deepEqual(deriveLaunchFacts(args, tty, {}), { initialPrompt: undefined, relaunchPrompt: undefined }, JSON.stringify([args, tty]));
  }
});
