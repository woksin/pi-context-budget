#!/usr/bin/env node
/** Offline installed-binary probes plus SDK routing matrix. No credentials or paid calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = resolve(process.argv[2] ?? join(homedir(), ".local/share/pi-runtime/lib/node_modules/@earendil-works/pi-coding-agent"));
const cli = join(runtime, "dist/cli.js");
const work = join(root, ".ai-work/origin-matrix");
mkdirSync(work, { recursive: true });
const dir = mkdtempSync(join(work, "run-"));
const probe = join(dir, "probe.ts");
// The real CLI creates/binds the context. Do not supply source or UI facts ourselves.
writeFileSync(probe, `import { classifyOrigin } from ${JSON.stringify(join(root, "src/memory/origin.ts"))};
export default function(pi) {
  pi.on("input", (event, ctx) => {
    const result = classifyOrigin(event, { hasUI: ctx.hasUI, hostSubagent: false,
      identity: { sessionId: ctx.sessionManager.getSessionId(), primarySessionId: ctx.sessionManager.getSessionId() }, firstInput: true });
    console.log("ORIGIN_PROBE=" + JSON.stringify(result));
    return { action: "handled" };
  });
}`);
// Do not inherit provider keys, user auth files or the developer's installed extensions.
const env = { HOME: dir, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
  PI_CODING_AGENT_DIR: dir, PI_RUNTIME_DIR: runtime };
function run(args, input) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, input, encoding: "utf8", timeout: 90000 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Failed: node ${args.join(" ")}`);
  return result.stdout + result.stderr;
}
run([cli, "--version"]);
const flags = [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session", "-e", probe];
function unattended(output) {
  const line = output.split("\n").find(line => line.startsWith("ORIGIN_PROBE="));
  assert.ok(line, "real CLI must execute input hook");
  assert.equal(JSON.parse(line.slice("ORIGIN_PROBE=".length)).origin, "unattended");
}
unattended(run([...flags, "-p", "print mode request"]));
const launch = join(dir, "launch.md");
writeFileSync(launch, "wrapper launch prompt");
unattended(run([...flags, "-p", `@${launch}`, `continue from ${join(dir, "handoff.md")}`]));
// RPC normally remains open; EOF closes its input loop after the handled prompt.
const rpc = run([...flags, "--mode", "rpc"], JSON.stringify({ id: "origin", type: "prompt", message: "RPC request" }) + "\n");
assert.match(rpc, /unattended/);
run(["--test", "--test-timeout=30000", "test/memory-origin.test.ts", "test/memory-origin-paths.test.ts"]);
console.log("Installed-runtime origin matrix passed (UI stubbed in SDK tests; no provider calls).");
