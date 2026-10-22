import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
test("public package exposes only the generic runtime, documentation, license and wrapper", () => {
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(p.name, "@woksin/pi-context-budget");
  assert.equal(p.license, "MIT");
  assert.equal(p.private, undefined);
  assert.equal(p.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.deepEqual(p.pi.extensions, ["./src/extension.ts"]);
  assert.deepEqual(p.files, ["src/", "bin/pi-session", "README.md", "LICENSE", "package.json"]);
  for (const entry of [...p.pi.extensions, p.bin["pi-session"]]) assert.ok(existsSync(resolve(root, entry)));
  assert.ok(statSync(resolve(root, p.bin["pi-session"])).mode & 0o111);
  for (const name of ["README.md", "src/extension.ts", "src/core.ts", "src/storage.ts", "src/resume-check.ts", "bin/pi-session"]) {
    const text = readFileSync(join(root, name), "utf8");
    assert.doesNotMatch(text, /\/Users\/|\/Volumes\//, `${name} must be portable`);
    assert.doesNotMatch(text, /\bCratis\b|\bL0\b|\blanes?\b/i, `${name} must be generic`);
  }
});
