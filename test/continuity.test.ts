import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { jobLine, subagentLine, renderHandoff, parseConfig, MAX_HANDOFF_BYTES } from "../src/core.ts";
import { runningState, subagentTaskDir } from "../src/storage.ts";
import { resumeCommand, runResumeCheck } from "../src/resume-check.ts";

const root = resolve(import.meta.dirname, "../.ai-work/continuity");
mkdirSync(root, { recursive: true });
const fixture = () => mkdtempSync(join(root, "case-"));
const auto = { cwd: "/repo", root: "/repo", branch: "main", head: "abc", jobs: [], subagents: [], claims: [], unavailable: [] };

test("job lines preserve commands over the old 300-byte bound and use - for absent fields", () => {
  const command = "echo " + "x".repeat(340);
  assert.equal(jobLine({ id: "j1", label: "CI", kind: "watch", until: "success", intervalSeconds: 10, command, cwd: "/repo", logPath: "/logs/j1" }),
    `j1 | CI | watch | success | 10 | ${command} | /repo | /logs/j1`);
  assert.equal(jobLine({ id: "j2", kind: "command", command: "true", cwd: "/repo" }), "j2 | - | command | - | - | true | /repo | -");
  assert.match(jobLine({ command: "echo\nsecond\rline" }), /echo\\nsecond\\rline/);
  assert.equal(jobLine({ command: "x".repeat(550) }).includes("…(cut"), false);
  const long = jobLine({ command: "字".repeat(700) });
  assert.match(long, /…\(cut, 728 chars\)$/);
  assert.ok(Array.from(long).length <= 600);
});

test("twenty normal job lines coexist with the previous narrative budget", () => {
  const jobs = Array.from({ length: 20 }, (_, i) => ({ id: `j${i}`, label: "wait CI", kind: "watch", until: "success", intervalSeconds: 10, command: `echo ${i}; ` + "x".repeat(340), cwd: "/repo", logPath: `/logs/${i}` }));
  const facts = "facts".repeat(2400);
  const h = renderHandoff({ goal: "finish", next_step: "continue", facts }, { ...auto, jobs }, "s", 1, "/handoff", "now");
  for (const job of jobs) assert.ok(h.text.includes(jobLine(job)));
  assert.ok(h.text.includes(facts));
  assert.ok(!h.text.includes('"truncated"'));
  assert.ok(Buffer.byteLength(h.text) <= MAX_HANDOFF_BYTES);
});

test("session task ids enumerate registry-authoritative running/queued agents without known tool ids", () => {
  const dir = fixture(), global = globalThis as Record<symbol, unknown>;
  const sk = Symbol.for("pi-subagents:manager"), jk = Symbol.for("pi-jobs.liveManagers");
  const previous = [global[sk], global[jk]];
  for (const id of ["active", "queued", "done", "stale"]) writeFileSync(join(dir, `${id}.output`), "stale transcript contents are not state");
  const records: Record<string, unknown> = {
    active: { id: "active", status: "running", description: "implement change" },
    queued: { id: "queued", status: "queued", description: "review change" },
    done: { id: "done", status: "completed", description: "old" },
  };
  global[sk] = { getRecord: (id: string) => records[id], hasRunning: () => true };
  global[jk] = new Set([{ list: () => [{ id: "j1", status: "running", label: "CI", kind: "watch", until: "success", intervalSeconds: 5, command: "test", cwd: "/repo", logPath: "/log" }] }]);
  try {
    const r = runningState([], { cwd: "/repo", sessionId: "s1", taskDir: dir });
    assert.deepEqual(r.subagents.map(subagentLine), ["active | running | implement change", "queued | queued | review change"]);
    assert.deepEqual(r.unavailable, []);
    assert.equal(jobLine(r.jobs[0]), "j1 | CI | watch | success | 5 | test | /repo | /log");
    const h = renderHandoff({ goal: "g", facts: "f", next_step: "n" }, { ...auto, ...r }, "s", 1, "/h", "now");
    assert.ok(h.text.includes("active | running | implement change\nqueued | queued | review change"));
    assert.ok(!h.text.includes("captured known ids only"));
    assert.ok(runningState([], { cwd: "/repo", sessionId: "other", taskDir: join(dir, "missing") }).unavailable.some(s => s.includes("enumeration unavailable")));
    assert.match(subagentTaskDir("/repo/deep", "s1"), /pi-subagents-\d+\/repo-deep\/s1\/tasks$/);
  } finally { [global[sk], global[jk]] = previous; }
});

test("resume command selects env, then exact session config, and is off otherwise", () => {
  const c = parseConfig({ resumeChecks: { L0: "echo config" } });
  assert.equal(resumeCommand(c, "L0", { PI_RESUME_CHECK: "echo env" }), "echo env");
  assert.equal(resumeCommand(c, "L0", {}), "echo config");
  assert.equal(resumeCommand(c, "L1", {}), undefined);
  assert.equal(resumeCommand(parseConfig({}), undefined, {}), undefined);
  assert.throws(() => parseConfig({ resumeChecks: { L0: 3 } }), /resumeChecks/);
  assert.throws(() => parseConfig({ resumeChecks: [] }), /resumeChecks/);
});

test("resume command uses session cwd, reports failure and caps combined output", async () => {
  const dir = fixture();
  const failed = await runResumeCheck("pwd; echo error >&2; exit 7", dir);
  assert.match(failed, /exit: 7/);
  assert.ok(failed.includes(dir));
  assert.ok(failed.includes("error"));
  const output = await runResumeCheck("printf '%05000d' 0; printf '%05000d' 0 >&2", dir);
  assert.ok(Buffer.byteLength(output) <= 4096);
  assert.match(output, /output truncated/);
  assert.match(await runResumeCheck("echo bad", join(dir, "missing")), /error:/);
  assert.match(await runResumeCheck("bad\0command", dir), /error:/);
});

test("resume timeout kills the process group and returns a failure instead of throwing", async () => {
  const dir = fixture(), pid = join(dir, "pid"), flag = join(dir, "escaped");
  const result = await runResumeCheck(`(sleep 1; touch '${flag}') & echo $! > '${pid}'; wait`, dir, 250);
  assert.match(result, /exit: SIGKILL \(timed out\)/);
  if (existsSync(pid)) {
    const child = Number(readFileSync(pid, "utf8").trim());
    // Give orphan reaping a bounded interval; no descendant should reach touch.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.throws(() => process.kill(child, 0), /ESRCH/);
  }
  assert.equal(existsSync(flag), false);
});

function escapedDescendant(t: { after(fn: () => void): void }, dir: string, keepParent: boolean): string {
  const pidFile = join(dir, "escaped.pid");
  t.after(() => {
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  });
  const script = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true, stdio: ["ignore", 1, 2]
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
    console.log("escaped descendant ready");
    ${keepParent ? "setInterval(() => {}, 1000);" : ""}
  `;
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `exec ${quote(process.execPath)} -e ${quote(script)}`;
}

test("resume check settles after child exit even when an escaped descendant holds its pipes", { timeout: 6000 }, async t => {
  const dir = fixture(), command = escapedDescendant(t, dir, false);
  const start = Date.now();
  const result = await runResumeCheck(command, dir, 10000);
  assert.ok(Date.now() - start < 4500, "child exit must bound pipe draining");
  assert.match(result, /exit: 0\nescaped descendant ready/);
  assert.ok(!result.includes("(timed out)"));
  assert.doesNotThrow(() => process.kill(Number(readFileSync(join(dir, "escaped.pid"), "utf8")), 0));
});

test("resume timeout settles even when an escaped descendant holds its pipes", { timeout: 6000 }, async t => {
  const dir = fixture(), command = escapedDescendant(t, dir, true);
  const start = Date.now();
  const result = await runResumeCheck(command, dir, 1000);
  assert.ok(Date.now() - start < 4500, "timeout must bound pipe draining");
  assert.match(result, /exit: SIGKILL \(timed out\)\nescaped descendant ready/);
  assert.doesNotThrow(() => process.kill(Number(readFileSync(join(dir, "escaped.pid"), "utf8")), 0));
});
