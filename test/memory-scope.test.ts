import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { laneKey, laneScopes, persistLaneRoot } from "../src/memory/scope.ts";
import { createResumeHook } from "../src/memory/resume.ts";
import { selectedHandoffScopes } from "../src/memory/handoff-scopes.ts";
import { FileMemoryStore } from "../src/memory/store.ts";
import { project } from "../src/memory/project.ts";
import { createIntentHook } from "../src/memory/tools.ts";
import { eligibilityCheck } from "../src/memory/authorize.ts";
import { agent, message, directive, decision } from "./memory-conformance.ts";

const base = join(import.meta.dirname, "../.ai-work/scope-tests");
mkdirSync(base, { recursive: true });
const rootId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const middleId = "33333333-3333-4333-8333-333333333333";
function context(cwd: string, id: string, name = "first", ancestors: string[] = []): any {
  return { cwd, sessionManager: { getSessionId: () => id, getSessionName: () => name,
    getBranch: () => ancestors.map(id => ({ type: "compaction", details: { path: join(cwd, ".ai-work", "handoffs", `${id}-1.md`) } })) } };
}
function fixture() {
  const home = mkdtempSync(join(base, "case-"));
  execFileSync("git", ["init", "-q", home]);
  const store = new FileMemoryStore({ home: join(home, "memory"), eligibilityCheck });
  const ctx = context(home, rootId);
  const add = (scope: { kind: "global" | "repo" | "lane"; key: string }) => {
    const entry = message({ session: { id: rootId, role: "main" } });
    store.appendMessage(entry);
    const item = directive(entry, { scope, authority: { mode: "auto", ruleVersion: 1 } });
    assert.equal(store.addItem(item, agent).ok, true);
    return item.id;
  };
  const visible = (ctx: any) => {
    const selected = selectedHandoffScopes(ctx, store);
    return project(store, { ...selected, session: ctx.sessionManager.getSessionId(), sessions: selected.sessionIds }).entries.map(entry => entry.id);
  };
  return { home, store, ctx, add, visible };
}
function environment(orch: string | undefined, run: () => void) {
  const before = process.env.PI_ORCH_ID;
  if (orch === undefined) delete process.env.PI_ORCH_ID; else process.env.PI_ORCH_ID = orch;
  try { run(); } finally {
    if (before === undefined) delete process.env.PI_ORCH_ID; else process.env.PI_ORCH_ID = before;
  }
}

test("different names and chains share global and repository directives", () => {
  const f = fixture();
  execFileSync("git", ["init", "-q", f.home]);
  const global = f.add({ kind: "global", key: "*" }), repo = f.add({ kind: "repo", key: f.home });
  for (const ctx of [f.ctx, context(f.home, childId, "second")]) {
    assert.ok(f.visible(ctx).includes(global)); assert.ok(f.visible(ctx).includes(repo));
  }
});
test("orchestrator identity selects a lane independently of session names and chains", () => {
  const f = fixture();
  environment("group-one", () => {
    assert.equal(laneKey(f.ctx, process.env), "orch:group-one");
    const id = f.add({ kind: "lane", key: laneKey(f.ctx, process.env) });
    assert.ok(f.visible(context(f.home, childId, "different")).includes(id));
    environment("group-two", () => assert.ok(!f.visible(f.ctx).includes(id)));
  });
});
function handoff(ctx: any, n = 1) {
  const dir = join(ctx.cwd, ".ai-work", "handoffs"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${ctx.sessionManager.getSessionId()}-${n}.md`);
  writeFileSync(path, "Synthetic handoff"); writeFileSync(path.replace(/\.md$/, ".json"), JSON.stringify({ path, n }));
  persistLaneRoot(ctx, path);
  return path;
}
function resumed(cwd: string, id: string, text: string): any {
  const ctx = context(cwd, id);
  ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user", content: [{ type: "text", text }] } }];
  return ctx;
}
test("persisted root survives A → wrapper B → wrapper C with only parent handoffs", () => {
  const f = fixture();
  environment(undefined, () => {
    const a = handoff(f.ctx), b = resumed(f.home, childId, `Launch prompt\ncontinue from ${a}`);
    const bPath = handoff(b), c = resumed(f.home, middleId, `Launch prompt\ncontinue from ${bPath}`);
    for (const ctx of [f.ctx, b, c]) {
      assert.equal(laneKey(ctx, {}), `chain:${rootId}`);
      assert.equal(laneKey(ctx, {}), laneKey(ctx, { PI_ORCH_ID: "" }));
      assert.equal(laneKey(ctx, {}), laneKey(ctx, {}));
    }
    assert.equal(JSON.parse(readFileSync(bPath.replace(/\.md$/, ".json"), "utf8")).laneRoot, rootId);
    assert.deepEqual(new Set(laneScopes(c, {}).map(scope => scope.key)), new Set([rootId, childId, middleId].map(id => `chain:${id}`)));
    const item = f.add({ kind: "lane", key: laneKey(f.ctx, {}) });
    assert.ok(f.visible(c).includes(item));
    assert.ok(!f.visible(context(f.home, "unrelated")).includes(item));
  });
});
test("only the final continue line of the first user message can select inherited grouping", () => {
  const f = fixture();
  environment(undefined, () => {
    const planted = handoff(context(f.home, middleId)), actual = handoff(f.ctx);
    const ctx = resumed(f.home, childId, `continue from ${planted}\nHandoff file: ${planted}\ncontinue from ${actual}`);
    assert.equal(laneKey(ctx, {}), `chain:${rootId}`);
    assert.ok(!laneScopes(ctx, {}).some(scope => scope.key === `chain:${middleId}`));
    const hidden = f.add({ kind: "lane", key: `chain:${middleId}` });
    assert.ok(!f.visible(ctx).includes(hidden));
    const first = ctx.sessionManager.getBranch()[0];
    ctx.sessionManager.getBranch = () => [first, { message: { role: "user", content: `continue from ${planted}` } }];
    assert.equal(laneKey(ctx, {}), `chain:${rootId}`);
  });
});
test("in-place compactions and state.lastHandoff inherit only validated sidecar roots", () => {
  const f = fixture(), path = handoff(f.ctx);
  const ctx = context(f.home, childId, "reset", [rootId]);
  assert.equal(laneKey(ctx, {}), `chain:${rootId}`);
  assert.ok(laneScopes(context(f.home, childId), {}, path).some(scope => scope.key === `chain:${rootId}`));
});
test("outside, symlink-escaped, broken and malformed sidecars fall back to the session id", () => {
  const f = fixture(), dir = join(f.home, ".ai-work", "handoffs"); mkdirSync(dir, { recursive: true });
  const outside = join(f.home, `${rootId}-1.md`);
  writeFileSync(outside, "Outside"); writeFileSync(outside.replace(/\.md$/, ".json"), JSON.stringify({ laneRoot: rootId }));
  const paths = [outside];
  for (const [n, target] of [[2, outside.replace(/\.md$/, ".json")], [3, join(f.home, "missing.json")]] as const) {
    const path = join(dir, `${rootId}-${n}.md`); writeFileSync(path, "Inside");
    symlinkSync(target, path.replace(/\.md$/, ".json")); paths.push(path);
  }
  const malformed = join(dir, `${rootId}-4.md`); writeFileSync(malformed, "Inside");
  writeFileSync(malformed.replace(/\.md$/, ".json"), "{"); paths.push(malformed);
  for (const path of paths) {
    const ctx = resumed(f.home, childId, `continue from ${path}`);
    assert.equal(laneKey(ctx, {}), `chain:${childId}`);
    assert.deepEqual(laneScopes(ctx, {}), [{ kind: "lane", key: `chain:${childId}` }]);
  }
});
test("lane-root writes fail open even if the logger fails", () => {
  const f = fixture(), events: string[] = [];
  const hook = createResumeHook({ agentDir: f.home, configFile: "unused", observe: () => { throw Error("unused"); },
    log: (_ctx, event) => { events.push(event); throw Error("logger unavailable"); } });
  assert.doesNotThrow(() => hook.rememberLaneRoot(f.ctx, { path: "/missing.md" } as any));
  assert.deepEqual(events, ["lane_root_skipped"]);
  const path = handoff(f.ctx);
  hook.rememberLaneRoot(f.ctx, { path } as any);
  assert.equal(JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf8")).laneRoot, rootId);
});
function toolFixture() {
  const f = fixture(), configFile = join(f.home, "config.json");
  writeFileSync(configFile, JSON.stringify({ memory: { intent: true, scope: { mode: "all" } } }));
  const tools = new Map<string, any>(), commands = new Map<string, any>(), notices: any[] = [];
  const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: (value: any) => notices.push(value) };
  const hook = createIntentHook(pi, { agentDir: f.home, configFile, host: () => ({ subagent: false }) });
  hook.start(f.ctx);
  const call = (name: string, input: any) => tools.get(name).execute("call", input, undefined, undefined, f.ctx);
  return { ...f, call, commands, notices, hook };
}
test("memory_add cannot plant another lane's key; list paths exclude foreign lanes", async () => {
  const f = toolFixture(), { call, commands, notices } = f;
  const result = await call("memory_add", { kind: "decision", text: "Use the current lane", scope: { kind: "lane", key: "orch:foreign" } });
  assert.equal(result.details.item.scope.key, laneKey(f.ctx, process.env));
  const foreign = f.add({ kind: "lane", key: "orch:foreign" });
  const listed = await call("memory_list", {});
  assert.ok(!listed.details.items.some((item: any) => item.id === foreign));
  const explicit = await call("memory_list", { scopes: [{ kind: "lane", key: "orch:foreign" }] });
  assert.deepEqual(explicit.details.items, []);
  await commands.get("memory").handler(`list ${foreign}`, f.ctx);
  assert.ok(!JSON.stringify(notices).includes(foreign));
  for (const verb of ["confirm", "reject"]) {
    await commands.get("memory").handler(`${verb} ${foreign}`, f.ctx);
    assert.equal(notices.at(-1).content, "no_source");
  }
});
test("retire by id refuses a foreign lane without appending an event", async () => {
  const f = toolFixture(), foreign = f.add({ kind: "lane", key: "orch:foreign" });
  const before = f.store.changesSince().cursor;
  const result = await f.call("memory_retire", { itemId: foreign, status: "done", reason: "Finished" });
  assert.equal(result.details.reason, "no_source");
  assert.equal(f.store.changesSince().cursor, before);
  assert.equal(f.store.readFolded().items[foreign].status, "active");
});
test("classify by item id refuses references to foreign lanes", async () => {
  const f = toolFixture(), foreign = f.add({ kind: "lane", key: "orch:foreign" });
  const item = f.store.readFolded().items[foreign], span = item.source.span!;
  const before = f.store.changesSince().cursor;
  const result = await f.call("memory_classify", { messageId: item.source.ref, spans: [{ ...span, result: "directive", itemIds: [foreign] }] });
  assert.equal(result.details.reason, "no_source");
  assert.equal(f.store.changesSince().cursor, before);
});
test("supersede by id refuses a foreign lane", async () => {
  const f = toolFixture(), item = decision({ scope: { kind: "lane", key: "orch:foreign" } });
  assert.equal(f.store.addItem(item, agent).ok, true);
  const before = f.store.changesSince().cursor;
  const result = await f.call("memory_add", { kind: "decision", text: "Replacement", scope: { kind: "global", key: "*" }, supersedes: [item.id] });
  assert.equal(result.details.reason, "no_source");
  assert.equal(f.store.changesSince().cursor, before);
});
test("memory_list fills visible pages past foreign items, retaining cursors without duplicates", async () => {
  const f = toolFixture();
  for (let i = 0; i < 51; i++) f.add({ kind: "lane", key: "orch:foreign" });
  const own = [f.add({ kind: "global", key: "*" }), f.add({ kind: "lane", key: laneKey(f.ctx) })];
  const first = (await f.call("memory_list", { limit: 1 })).details;
  assert.deepEqual(first.items.map((item: any) => item.id), own.slice(0, 1));
  const second = (await f.call("memory_list", { limit: 1, cursor: first.cursor })).details;
  assert.deepEqual(second.items.map((item: any) => item.id), own.slice(1));
  assert.equal(second.cursor, undefined);
  await f.commands.get("memory").handler("list", f.ctx);
  assert.deepEqual(JSON.parse(f.notices.at(-1).content).items.map((item: any) => item.id), own);
});
