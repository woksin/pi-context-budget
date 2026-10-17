import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../.ai-work/wrapper");
mkdirSync(root, { recursive: true });
function run(kind = "once", extra: string[] = []) {
  const dir = mkdtempSync(join(root, "case-"));
  const cwd = join(dir, "cwd with spaces"); mkdirSync(cwd);
  const handoff = join(cwd, "hand off.md"), launch = join(cwd, "launch prompt.md");
  writeFileSync(handoff, "handoff"); writeFileSync(launch, "launch");
  const fake = join(dir, "pi");
  writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const log = process.env.FAKE_LOG, args = process.argv.slice(2);
let calls = []; try { calls = JSON.parse(fs.readFileSync(log, 'utf8')); } catch {}
calls.push({args, cwd: process.cwd(), marker: process.env.PI_RELAUNCH_MARKER, wrapped: process.env.PI_SESSION_WRAPPER, ownerPid: process.env.PI_SESSION_WRAPPER_PID, nonce: process.env.PI_SESSION_LAUNCH_ID, pid: process.pid});
fs.writeFileSync(log, JSON.stringify(calls));
const kind = process.env.FAKE_KIND;
if (kind === 'stale') {
  fs.writeFileSync(process.env.PI_RELAUNCH_MARKER.replace(process.env.PI_SESSION_LAUNCH_ID, 'f'.repeat(32)), '{}');
}
if ((calls.length === 1 || kind === 'loop') && !['none', 'stale'].includes(kind)) {
  fs.writeFileSync(process.env.PI_RELAUNCH_MARKER, kind === 'bad' ? '{}' : JSON.stringify({cwd: process.env.FAKE_CWD, handoff: process.env.FAKE_HANDOFF, launchPrompt: process.env.FAKE_LAUNCH, sessionFile: null}));
}
process.exit(kind === 'error' ? 7 : 0);
`, { mode: 0o700 });
  const env = { ...process.env, PI_SESSION_PI: fake, PI_SESSION_MARKER_DIR: join(dir, "markers"), PI_SESSION_MAX_RELAUNCHES_PER_HOUR: "1",
    FAKE_LOG: join(dir, "calls.json"), FAKE_KIND: kind, FAKE_CWD: cwd, FAKE_HANDOFF: handoff, FAKE_LAUNCH: launch };
  const result = spawnSync("bash", [resolve(import.meta.dirname, "../bin/pi-session"), "--model", "test/model", ...extra, "--", "@initial.md", "initial request"], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.ok(result.status !== 126 && result.status !== 127 && result.status !== 1, result.stderr);
  return { ...result, dir, cwd, handoff, launch, calls: JSON.parse(readFileSync(env.FAKE_LOG, "utf8")), markers: readdirSync(env.PI_SESSION_MARKER_DIR) };
}
test("wrapper relaunch once in same cwd with original options, PID/nonce-owned marker, no old prompt", () => {
  const r = run("once", ["--session", "/old.jsonl"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[0].args, ["--model", "test/model", "--session", "/old.jsonl", "@initial.md", "initial request"]);
  assert.deepEqual(r.calls[1].args, ["--model", "test/model", `@${r.launch}`, `continue from ${r.handoff}`]);
  assert.equal(r.calls[1].cwd, r.cwd);
  assert.equal(r.calls[0].wrapped, "1");
  assert.match(r.calls[0].nonce, /^[a-f0-9]{32}$/);
  assert.equal(r.calls[0].ownerPid, String(r.calls[0].pid));
  assert.match(r.calls[0].marker, new RegExp(`/${r.calls[0].pid}-${r.calls[0].nonce}\\.json$`));
  assert.notEqual(r.calls[0].nonce, r.calls[1].nonce);
  assert.equal(r.markers.length, 0);
});
test("built-in short value flags and tui mode survive relaunch intact", () => {
  const extra = ["-n", "name with spaces", "-t", "read,write,context_handoff", "-xt", "bash", "--tui-mode", "regular"];
  const r = run("once", extra);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls[1].args, ["--model", "test/model", ...extra, `@${r.launch}`, `continue from ${r.handoff}`]);
});
test("no marker preserves pi exit code; provider error never relaunches and retains marker", () => {
  assert.equal(run("none").calls.length, 1);
  const r = run("error");
  assert.equal(r.status, 7); assert.equal(r.calls.length, 1); assert.equal(r.markers.length, 1);
});
test("a retained marker for the same PID but another launch nonce is never consumed", () => {
  const stale = run("stale");
  assert.equal(stale.status, 0); assert.equal(stale.calls.length, 1);
  assert.equal(stale.markers.length, 1);
  assert.match(stale.markers[0], /-f{32}\.json$/);
});
test("hourly cap and invalid marker stop safely without consuming recovery evidence", () => {
  const loop = run("loop");
  assert.equal(loop.status, 3); assert.equal(loop.calls.length, 2); assert.equal(loop.markers.length, 1);
  const bad = run("bad"); assert.equal(bad.status, 4); assert.equal(bad.calls.length, 1);
  assert.ok(bad.markers.some((p: string) => p.endsWith(".json")));
});
