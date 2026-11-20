import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anyToolFlag, flagOn, inScope, memoryOff, parseMemoryConfig, readMemoryConfig, registerMemoryTool, MEMORY_DISABLED } from "../src/memory/config.ts";

const ALL = { journal: true, requests: true, answers: "final", answerPolicy: "carry", intent: true, resume: true, recall: true,
  scope: { mode: "all" }, coordinators: ["L0"], trustRpc: true };

test("missing block, non-object roots and non-object blocks are all off", () => {
  for (const root of [{}, undefined, null, [], "memory", 7, { memory: null }, { memory: [] }, { memory: "on" }, { memory: true }]) {
    assert.deepEqual(parseMemoryConfig(root).config, memoryOff(), JSON.stringify(root));
  }
  assert.deepEqual(parseMemoryConfig({}).reasons, []);
  assert.equal(parseMemoryConfig({ memory: true }).reasons.length, 1);
});

test("a missing flag is false; an invalid value is false with a reason", () => {
  const { config, reasons } = parseMemoryConfig({ memory: { journal: true, recall: "yes", intent: 1, resume: null, answers: "bogus", answerPolicy: 1, trustRpc: "true",
    coordinators: "L0", scope: { mode: "everyone" } } });
  assert.deepEqual(config, memoryOff()); // one bad value turns everything off, including the valid journal flag
  assert.deepEqual([config.recall, config.intent, config.resume, config.answers, config.answerPolicy, config.trustRpc], [false, false, false, false, false, false]);
  assert.deepEqual(config.coordinators, []);
  assert.deepEqual(config.scope, { mode: "only", names: [] });
  for (const key of ["recall", "intent", "resume", "answers", "answerPolicy", "trustRpc", "coordinators", "scope"]) {
    assert.ok(reasons.some(reason => reason.includes(key)), key);
  }
});

test("a complete block parses as written", () => {
  assert.deepEqual(parseMemoryConfig({ memory: ALL }), { config: { ...ALL, scope: { mode: "all", names: [] } }, reasons: [] });
});

test("requests requires journal", () => {
  const { config, reasons } = parseMemoryConfig({ memory: { requests: true } });
  assert.equal(config.requests, false);
  assert.match(reasons.join(), /requires memory.journal/);
});

test("scope: names [] enables nobody, an explicit name only that session, mode all everyone", () => {
  const only = (names: unknown) => parseMemoryConfig({ memory: { journal: true, scope: { mode: "only", names } } }).config;
  assert.equal(flagOn(only([]), "L0", "journal"), false);
  assert.equal(flagOn(only([]), undefined, "journal"), false);
  assert.equal(flagOn(only(["L0"]), "L0", "journal"), true);
  assert.equal(flagOn(only(["L0"]), "L1", "journal"), false);
  assert.equal(flagOn(only(["L0"]), undefined, "journal"), false);
  for (const bad of [undefined, "L0", [""], [1], null]) assert.equal(inScope(only(bad), "L0"), false, JSON.stringify(bad));
  const all = parseMemoryConfig({ memory: { journal: true, scope: { mode: "all" } } }).config;
  assert.equal(flagOn(all, "L0", "journal"), true);
  assert.equal(flagOn(all, undefined, "journal"), true);
  // Omitted scope never means everyone, even with flags on.
  assert.equal(flagOn(parseMemoryConfig({ memory: { journal: true } }).config, "L0", "journal"), false);
  assert.equal(flagOn(all, "L0", "recall"), false);
});

test("prototype pollution cannot switch anything on", () => {
  const root = JSON.parse('{"memory":{"__proto__":{"journal":true},"scope":{"__proto__":{"mode":"all"}}}}');
  const { config } = parseMemoryConfig(root);
  assert.equal(config.journal, false);
  assert.deepEqual(config.scope, { mode: "only", names: [] });
});

test("unreadable or invalid JSON files are off with a logged reason; absent file is silently off", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-config-"));
  try {
    assert.deepEqual(readMemoryConfig(join(dir, "absent.json")), { config: memoryOff(), reasons: [] });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const parsed = readMemoryConfig(bad);
    assert.deepEqual(parsed.config, memoryOff());
    assert.match(parsed.reasons[0], /unreadable/);
    assert.deepEqual(readMemoryConfig(dir).config, memoryOff()); // a directory is not a config
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ memory: { journal: true, scope: { mode: "all" } } }));
    assert.equal(readMemoryConfig(good).config.journal, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function toolHost() {
  const registered: any[] = [];
  return { registered, pi: { registerTool: (tool: any) => registered.push(tool) } };
}
const recall = { name: "recall", execute: async () => ({ content: [{ type: "text", text: "found" }] }) };

test("tools are absent at load when every tool-bearing flag is false, even with journal on", () => {
  const host = toolHost();
  const config = parseMemoryConfig({ memory: { journal: true, requests: true, resume: true, scope: { mode: "all" } } }).config;
  assert.equal(anyToolFlag(config), false);
  assert.equal(registerMemoryTool(host.pi, recall, "recall", () => config, () => "L0"), false);
  assert.equal(host.registered.length, 0);
});

test("a registered tool refuses once its flag or scope is turned off mid-session", async () => {
  const host = toolHost();
  let config = parseMemoryConfig({ memory: { recall: true, scope: { mode: "all" } } }).config;
  assert.equal(registerMemoryTool(host.pi, recall, "recall", () => config, () => "L0"), true);
  const [tool] = host.registered;
  assert.deepEqual((await tool.execute()).content[0].text, "found");
  config = parseMemoryConfig({ memory: { recall: false, scope: { mode: "all" } } }).config;
  assert.deepEqual((await tool.execute()).content[0].text, MEMORY_DISABLED);
  config = parseMemoryConfig({ memory: { recall: true, scope: { mode: "only", names: [] } } }).config;
  assert.deepEqual((await tool.execute()).content[0].text, MEMORY_DISABLED);
  config = memoryOff();
  assert.deepEqual((await tool.execute()).content[0].text, MEMORY_DISABLED);
});

test("enabling a flag after load does not add the tool (restart required); a throwing config source refuses", async () => {
  const host = toolHost();
  let config = memoryOff();
  assert.equal(registerMemoryTool(host.pi, recall, "recall", () => config, () => "L0"), false);
  config = parseMemoryConfig({ memory: { recall: true, scope: { mode: "all" } } }).config;
  assert.equal(host.registered.length, 0);
  const active = toolHost();
  registerMemoryTool(active.pi, recall, "recall", () => config, () => "L0");
  config = null as never; // hostile state: current() returns something unusable
  assert.equal((await active.registered[0].execute()).content[0].text, MEMORY_DISABLED);
});

test("one invalid value anywhere turns the whole block off, even with journal on and scope all", () => {
  for (const bad of [{ recall: "bad" }, { intent: 1 }, { answers: "bogus" }, { coordinators: [""] }, { scope: { mode: "x" } }, { requests: true, journal: false }]) {
    const { config, reasons } = parseMemoryConfig({ memory: { journal: true, scope: { mode: "all" }, ...bad } });
    assert.deepEqual(config, memoryOff(), JSON.stringify(bad));
    assert.ok(reasons.length > 0);
  }
});

test("reasons are fixed codes: file contents and exception text never appear", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-config-"));
  try {
    const file = join(dir, "c.json");
    const secret = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0"].join("");
    writeFileSync(file, `{ "memory": { "journal": true, "x": "${secret}" `);
    assert.ok(!JSON.stringify(readMemoryConfig(file)).includes(secret));
    const odd = parseMemoryConfig({ memory: { recall: secret, scope: { mode: secret }, coordinators: [secret, 1] } });
    assert.ok(!JSON.stringify(odd.reasons).includes(secret));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("memory.answers accepts final and all only", () => {
  assert.equal(parseMemoryConfig({ memory: { answers: "all" } }).config.answers, "all");
  assert.equal(parseMemoryConfig({ memory: { answers: "final" } }).config.answers, "final");
  assert.ok(parseMemoryConfig({ memory: { answers: "none" } }).reasons.some(reason => reason.includes("answers")));
});
