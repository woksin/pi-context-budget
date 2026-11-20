import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { laneKey, laneScopes } from "../src/memory/scope.ts";
import { selectedHandoffScopes } from "../src/memory/handoff-scopes.ts";
import { FileMemoryStore } from "../src/memory/store.ts";
import { project } from "../src/memory/project.ts";
import { createIntentHook } from "../src/memory/tools.ts";
import { eligibilityCheck } from "../src/memory/authorize.ts";
import { agent, message, directive } from "./memory-conformance.ts";

const base = join(import.meta.dirname, "../.ai-work/scope-tests");
mkdirSync(base, { recursive: true });
const rootId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const middleId = "33333333-3333-4333-8333-333333333333";
function context(cwd: string, id: string, name = "first", ancestors: string[] = []): any {
  return { cwd, sessionManager: { getSessionId: () => id, getSessionName: () => name,
    getBranch: () => ancestors.map(id => ({ type: "compaction", details: { path: `/handoffs/${id}-1.md` } })) } };
}
function fixture() {
  const home = mkdtempSync(join(base, "case-"));
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
test("chain adds use the oldest ancestor; visibility includes every member, never another chain", () => {
  const f = fixture();
  environment(undefined, () => {
    const child = context(f.home, childId, "renamed", [rootId, middleId]);
    assert.equal(laneKey(child, {}), `chain:${rootId}`);
    assert.equal(laneKey(child, {}), laneKey(child, {}));
    assert.deepEqual(laneScopes(child, {}).map(scope => scope.key), [childId, rootId, middleId].map(id => `chain:${id}`));
    const id = f.add({ kind: "lane", key: laneKey(f.ctx, {}) });
    assert.ok(f.visible(child).includes(id));
    assert.ok(!f.visible(context(f.home, middleId, "first")).includes(id));
    const member = f.add({ kind: "lane", key: `chain:${middleId}` });
    assert.ok(f.visible(child).includes(member));
  });
});
test("memory_add cannot plant another lane's key; list paths exclude foreign lanes", async () => {
  const f = fixture(), configFile = join(f.home, "config.json");
  writeFileSync(configFile, JSON.stringify({ memory: { intent: true, scope: { mode: "all" } } }));
  const tools = new Map<string, any>(), commands = new Map<string, any>(), notices: any[] = [];
  const pi: any = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: (value: any) => notices.push(value) };
  const hook = createIntentHook(pi, { agentDir: f.home, configFile, host: () => ({ subagent: false }) });
  hook.start(f.ctx);
  const call = (name: string, input: any) => tools.get(name).execute("call", input, undefined, undefined, f.ctx);
  const result = await call("memory_add", { kind: "decision", text: "Use the current lane", scope: { kind: "lane", key: "orch:foreign" } });
  assert.equal(result.details.item.scope.key, laneKey(f.ctx, process.env));
  const foreign = f.add({ kind: "lane", key: "orch:foreign" });
  const listed = await call("memory_list", {});
  assert.ok(!listed.details.items.some((item: any) => item.id === foreign));
  const explicit = await call("memory_list", { scopes: [{ kind: "lane", key: "orch:foreign" }] });
  assert.deepEqual(explicit.details.items, []);
  await commands.get("memory").handler(`list ${foreign}`, f.ctx);
  assert.ok(!JSON.stringify(notices).includes(foreign));
});
