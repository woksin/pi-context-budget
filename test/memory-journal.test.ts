import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextBudgetExtension } from "../src/extension.ts";
import { SessionHosts } from "../src/storage.ts";
import { FileMemoryStore } from "../src/memory/store.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.PI_MEMORY_HOME; });
const j = (...parts: string[]) => parts.join("");
const canary = j("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type Options = { memory?: unknown; hosts?: SessionHosts; scannerSource?: string; sessionName?: string; hasUI?: boolean; sessionId?: string; dir?: string };
async function harness(options: Options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "memory-journal-"));
  if (!options.dir) dirs.push(dir);
  const agentDir = join(dir, "agent"), configFile = join(dir, "config.json"), stateDir = join(dir, "state");
  mkdirSync(join(agentDir, "lib"), { recursive: true });
  if (options.scannerSource) writeFileSync(join(agentDir, "lib", "secret-mask.ts"), options.scannerSource);
  process.env.PI_CONTEXT_BUDGET_CONFIG = configFile;
  process.env.PI_CONTEXT_BUDGET_STATE_DIR = stateDir;
  delete process.env.PI_MEMORY_HOME;
  const setConfig = (memory?: unknown) => writeFileSync(configFile, JSON.stringify({ mode: "observe", ...(memory === undefined ? {} : { memory }) }));
  const setRaw = (text: string) => writeFileSync(configFile, text);
  setConfig(options.memory);
  const handlers = new Map<string, (e: any, ctx: ExtensionContext) => Promise<any>>();
  const tools: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, handler); }, registerTool: (tool: any) => { tools.push(tool.name); },
    getActiveTools: () => ["read", "context_handoff"], getAllTools: () => [{ name: "read" }, { name: "context_handoff" }] } as unknown as ExtensionAPI;
  const sid = options.sessionId ?? `s-${dir.split("-").at(-1)}`;
  const ctx = { cwd: dir, hasUI: options.hasUI ?? true, model: { provider: "t", id: "t" },
    sessionManager: { getSessionId: () => sid, getSessionFile: () => join(dir, "session.jsonl"), getSessionName: () => options.sessionName, getHeader: () => ({}), getBranch: () => [] },
    getContextUsage: () => ({ tokens: 10 }), shutdown() {}, ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
  await createContextBudgetExtension({ agentDir, hosts: options.hosts ?? new SessionHosts() })(pi);
  await handlers.get("session_start")!({}, ctx);
  const input = (text: string, source: unknown = "interactive") => handlers.get("input")!({ text, source }, ctx);
  const memoryHome = join(agentDir, "memory");
  const entries = () => new FileMemoryStore({ agentDir }).listMessages({ limit: 100 }).items;
  const events = () => existsSync(join(stateDir, "events.jsonl")) ? readFileSync(join(stateDir, "events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const allFiles = (root: string): string[] => !existsSync(root) ? [] : readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? allFiles(join(root, e.name)) : [join(root, e.name)]);
  return { dir, agentDir, ctx, handlers, tools, input, setConfig, setRaw, memoryHome, entries, events, allFiles, sid, configFile };
}
const ON = { journal: true, scope: { mode: "all" } };

test("flags off: no memory directory, no memory events, unchanged tool list, input passes through", async () => {
  for (const memory of [undefined, {}, { journal: false, scope: { mode: "all" } }, { journal: true }, { journal: true, scope: { mode: "only", names: [] } }]) {
    const h = await harness({ memory });
    for (const text of ["one", "two"]) assert.deepEqual(await h.input(text), { action: "continue" });
    assert.equal(existsSync(h.memoryHome), false, JSON.stringify(memory));
    assert.deepEqual(h.tools, ["context_handoff"]);
    assert.ok(!h.events().some(e => /memory|journal/.test(e.event)), JSON.stringify(h.events()));
  }
});

test("journal toggles on and off across two inputs without restart", async () => {
  const h = await harness({ memory: { journal: false, scope: { mode: "all" } } });
  await h.input("first"); // off
  h.setConfig(ON);
  await h.input("second"); // on
  await h.input("third"); // on
  h.setConfig({ journal: false, scope: { mode: "all" } });
  await h.input("fourth"); // off again
  assert.deepEqual(h.entries().map(e => e.text), ["second", "third"]);
});

test("origin comes from the S3a gate: first input is unverified launch, later typed input is human, extension input injected", async () => {
  const h = await harness({ memory: ON });
  await h.input("opening text");
  await h.input("typed later");
  await h.input("[orch from L1] hi", "extension");
  await h.input("rpc text", "rpc");
  const byText = Object.fromEntries(h.entries().map(e => [e.text, e]));
  assert.equal(byText["opening text"].origin, "unattended");
  assert.match(byText["opening text"].originEvidence.join(), /launch-unverified/);
  assert.equal(byText["typed later"].origin, "human");
  assert.equal(byText["[orch from L1] hi"].origin, "injected");
  assert.equal(byText["rpc text"].origin, "unattended");
});

test("injectedFrom metadata is redacted; the body is too", async () => {
  const h = await harness({ memory: ON });
  await h.input("warm");
  await h.input(`[orch message from ${canary}] hello`, "extension");
  const entry = h.entries().at(-1)!;
  assert.equal(entry.origin, "injected");
  assert.ok(!JSON.stringify(entry).includes(canary));
  assert.match(entry.injectedFrom ?? "", /REDACTED/);
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
});

test("injectedFrom is omitted when the scanner fails", async () => {
  const h = await harness({ memory: ON, scannerSource: "export const scan = () => { throw new Error('x'); };" });
  await h.input("warm");
  await h.input(`[orch message from ${canary}] hello`, "extension");
  const entry = h.entries().at(-1)!;
  assert.equal(entry.injectedFrom, undefined);
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
});

test("journal stays off when any memory value is invalid; the log holds no config text", async () => {
  const h = await harness({ memory: { journal: true, recall: canary, scope: { mode: "all" } } });
  await h.input("a"); await h.input("b");
  assert.equal(existsSync(h.memoryHome), false);
  assert.ok(!JSON.stringify(h.events()).includes(canary));
  h.setRaw(`{ "memory": "${canary}`);
  await h.input("c");
  assert.ok(!JSON.stringify(h.events()).includes(canary));
  const excerpt = j("zq", "9xk"); // short enough for the runtime to quote it whole in the parse error
  h.setRaw(`K=${excerpt}`);
  await h.input("d");
  assert.ok(h.events().some(e => e.event === "config_error"));
  assert.ok(!JSON.stringify(h.events()).includes(excerpt));
});

test("no-UI sessions are journaled as unattended, never human", async () => {
  const h = await harness({ memory: ON, hasUI: false });
  await h.input("first"); await h.input("second");
  assert.deepEqual(h.entries().map(e => e.origin), ["unattended", "unattended"]);
});

test("child sessions are never journaled", async () => {
  const hosts = new SessionHosts();
  const main = await harness({ memory: ON, hosts, sessionId: "main-1" });
  const childHarness = await harness({ memory: ON, hosts, sessionId: "child-2" });
  await main.input("m1"); await main.input("m2");
  await childHarness.input("secret child prompt"); await childHarness.input("again");
  const store = new FileMemoryStore({ agentDir: main.agentDir });
  assert.deepEqual(store.listMessages({ limit: 100 }).items.map(e => e.text), ["m1", "m2"]);
  assert.equal(childHarness.entries().length, 0);
});

test("scope: names [] enables nobody, a matching session name enables, mode all enables everyone", async () => {
  const nobody = await harness({ memory: { journal: true, scope: { mode: "only", names: [] } }, sessionName: "L0" });
  await nobody.input("a"); await nobody.input("b");
  assert.equal(existsSync(nobody.memoryHome), false);
  const named = await harness({ memory: { journal: true, scope: { mode: "only", names: ["L0"] } }, sessionName: "L0" });
  await named.input("a"); assert.equal(named.entries().length, 1);
  assert.equal(named.entries()[0].lane, "L0");
  const other = await harness({ memory: { journal: true, scope: { mode: "only", names: ["L0"] } }, sessionName: "L1" });
  await other.input("a"); assert.equal(existsSync(other.memoryHome), false);
  const everyone = await harness({ memory: ON });
  await everyone.input("a"); assert.equal(everyone.entries().length, 1);
});

test("invalid config: all off and one logged reason (not one per input)", async () => {
  const h = await harness({ memory: { journal: "yes", scope: { mode: "all" } } });
  await h.input("a"); await h.input("b");
  assert.equal(existsSync(h.memoryHome), false);
  const logged = h.events().filter(e => e.event === "memory_config_invalid");
  assert.equal(logged.length, 1);
  assert.match(JSON.stringify(logged[0].reasons), /memory\.journal must be a boolean/);
  h.setRaw("{ broken json");
  await h.input("c");
  assert.equal(existsSync(h.memoryHome), false);
  assert.match(JSON.stringify(h.events().filter(e => e.event === "memory_config_invalid").at(-1)), /unreadable/);
  h.setConfig(ON);
  await h.input("d");
  assert.deepEqual(h.entries().map(e => e.text), ["d"]);
});

test("canary secrets never reach disk (scanner absent)", async () => {
  const h = await harness({ memory: ON });
  await h.input("warm"); await h.input(`please use ${canary} and Bearer ${j("abcDEF123", "456ghiJKL")} now`);
  const entry = h.entries().find(e => e.text?.includes("please use"))!;
  assert.match(entry.text!, /\[REDACTED:github-token\]/);
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
});

test("scanner present: its masking is kept and the built-in pass still runs", async () => {
  const source = `export const scan = (t: string) => ({ text: t.replace("MASKME", "[REDACTED:custom]"), kinds: ["custom"], count: 1, skipped: false });`;
  const h = await harness({ memory: ON, scannerSource: source });
  await h.input("warm"); await h.input(`MASKME ${canary}`);
  assert.equal(h.entries().at(-1)!.text, "[REDACTED:custom] [REDACTED:github-token]");
});

test("scanner throwing: entry withheld, hash is of the empty body, no raw text on disk", async () => {
  const h = await harness({ memory: ON, scannerSource: "export const scan = () => { throw new Error('boom'); };" });
  await h.input("warm"); await h.input(`secret ${canary}`);
  const entry = h.entries().at(-1)!;
  assert.deepEqual([entry.text, entry.withheld, entry.sha256, entry.textBytes], [null, "redactor_failed", digest(""), 0]);
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
  assert.equal(h.events().filter(e => e.event === "journal_error").length, 0, "withholding is a normal outcome, not an error");
});

test("oversize body (> 2 MiB) is withheld as too_large with no blob", async () => {
  const h = await harness({ memory: ON });
  await h.input("warm"); await h.input(`${canary} ${"x".repeat(2 * 1024 * 1024)}`);
  const entry = h.entries().at(-1)!;
  assert.deepEqual([entry.text, entry.withheld, entry.sha256], [null, "too_large", digest("")]);
  assert.equal(entry.blob, undefined);
  assert.deepEqual(readdirSync(join(h.memoryHome, "blobs")), []);
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
});

test("bodies over 64 KiB keep head and tail inline and the redacted whole in a blob", async () => {
  const h = await harness({ memory: ON });
  const big = `${canary} ${"word ".repeat(20_000)}end`;
  await h.input("warm"); await h.input(big);
  const entry = h.entries().at(-1)!;
  const redacted = big.replace(canary, "[REDACTED:github-token]");
  assert.equal(entry.blob?.sha256, digest(redacted));
  assert.equal(entry.text, redacted); // hydrated from the blob on read
  const raw = readFileSync(join(h.memoryHome, "journal", `${h.sid}.jsonl`), "utf8");
  assert.ok(Buffer.byteLength(raw) < 8 * 1024, "journal line carries only head + tail");
  for (const file of h.allFiles(h.memoryHome)) assert.ok(!readFileSync(file, "utf8").includes(canary), file);
});

test("files are 0600 and directories 0700", async () => {
  const h = await harness({ memory: ON });
  await h.input("warm"); await h.input(`x ${"y".repeat(70_000)}`);
  const mode = (path: string) => statSync(path).mode & 0o777;
  assert.equal(mode(h.memoryHome), 0o700);
  for (const sub of ["journal", "answers", "blobs"]) assert.equal(mode(join(h.memoryHome, sub)), 0o700, sub);
  const files = h.allFiles(h.memoryHome);
  assert.ok(files.length >= 2);
  for (const file of files) assert.equal(mode(file), 0o600, file);
});

test("hook errors are swallowed and logged without raw text; pi still gets continue", async () => {
  const h = await harness({ memory: ON });
  await h.input("warm");
  const file = join(h.memoryHome, "journal", `${h.sid}.jsonl`);
  chmodSync(file, 0o400); // appends now fail
  try {
    assert.deepEqual(await h.input(`typed ${canary}`), { action: "continue" });
  } finally { chmodSync(file, 0o600); }
  const errors = h.events().filter(e => e.event === "journal_error");
  assert.equal(errors.length, 1);
  assert.ok(!JSON.stringify(errors).includes(canary));
  await h.input("after"); // recovers
  assert.ok(h.entries().some(e => e.text === "after"));
});

test("hook errors: unusable memory home (a file) is also swallowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-journal-"));
  dirs.push(dir);
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "memory"), "not a directory");
  const h = await harness({ memory: ON, dir });
  assert.deepEqual(await h.input("a"), { action: "continue" });
  assert.deepEqual(await h.input("b"), { action: "continue" });
  assert.ok(h.events().some(e => e.event === "journal_error"));
});

test("PI_MEMORY_HOME override is honoured by the store, not by the hook", async () => {
  const home = mkdtempSync(join(tmpdir(), "memory-home-"));
  dirs.push(home);
  const h = await harness({ memory: ON });
  process.env.PI_MEMORY_HOME = home;
  await h.input("a"); await h.input("b");
  assert.ok(readdirSync(join(home, "journal")).length > 0);
});

test("the extension only reaches the memory store through the flag-gated lazy import", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/memory/journal-hook.ts"), "utf8");
  assert.doesNotMatch(source, /^import (?!type)[^;]*from\s+["']\.\/store\.ts["']/m);
  assert.match(source, /import\("\.\/store\.ts"\)/);
});
