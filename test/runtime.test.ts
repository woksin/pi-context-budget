import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findRuntime } from "./runtime.ts";
import extension from "../src/extension.ts";

const runtime = findRuntime();
test("default export is a pi extension factory", t => {
  assert.equal(typeof extension, "function");
  t.diagnostic(`Node ${process.version}`);
});
test("CI supplies the pi runtime", { skip: !process.env.CI }, () => assert.ok(runtime, "Install the pi peer before CI tests"));
test("resolved host supplies the public getAgentDir API", { skip: runtime ? false : "pi unavailable; set PI_RUNTIME_DIR or install the host peer" }, async () => {
  const host = await import(pathToFileURL(join(runtime!, "dist/index.js")).href);
  assert.equal(typeof host.getAgentDir, "function");
  assert.equal(typeof host.createAgentSession, "function");
});
