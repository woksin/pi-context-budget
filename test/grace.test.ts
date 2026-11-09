import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { graceEligible } from "../src/grace.ts";

const cwd = "/workspace/repo";
for (const tool of ["edit", "write"]) {
  for (const path of [".ai-work/t/STATE.md", ".ai-work/t/notes.md", "/other/worktree/.ai-work/t/STATE.md"]) {
    test(`${tool} allows state markdown: ${path}`, () => assert.equal(graceEligible(tool, { path }, cwd), true));
  }
  for (const path of ["src/a.ts", "src/STATE.md", ".ai-work/t/run.sh", ".ai-work/../src/STATE.md", "foo.ai-work/STATE.md"]) {
    test(`${tool} rejects non-state paths: ${path}`, () => assert.equal(graceEligible(tool, { path }, cwd), false));
  }
}
test("read allows only ai-work paths and accepts file_path", () => {
  assert.equal(graceEligible("read", { file_path: ".ai-work/t" }, cwd), true);
  assert.equal(graceEligible("read", { path: ".ai-work/t/data.json" }, cwd), true);
  assert.equal(graceEligible("edit", { file_path: ".ai-work/t/STATE.md" }, cwd), true);
  assert.equal(graceEligible("read", { path: "src/a.ts" }, cwd), false);
});
test("canonical paths reject symlink escapes, including missing targets and symlink/..", () => {
  const base = resolve(import.meta.dirname, "../.ai-work/grace");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "case-"));
  mkdirSync(join(dir, ".ai-work/t"), { recursive: true });
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  writeFileSync(join(dir, "src/STATE.md"), "source");
  symlinkSync(join(dir, "src"), join(dir, ".ai-work/t/escape"));
  symlinkSync(join(dir, "src/STATE.md"), join(dir, ".ai-work/t/linked.md"));
  symlinkSync(join(dir, "src/deep"), join(dir, ".ai-work/t/deep"));
  symlinkSync(join(dir, ".ai-work/t"), join(dir, "notes"));
  for (const tool of ["edit", "write", "read"]) {
    for (const path of [".ai-work/t/escape/STATE.md", ".ai-work/t/escape/new.md", ".ai-work/t/linked.md", ".ai-work/t/deep/../STATE.md"]) {
      assert.equal(graceEligible(tool, { path }, dir), false, `${tool}: ${path}`);
    }
    assert.equal(graceEligible(tool, { path: "notes/STATE.md" }, dir), true);
    assert.equal(graceEligible(tool, { path: ".ai-work/t/new/sub/STATE.md" }, dir), true);
  }
  symlinkSync(join(dir, "src"), join(dir, "fake"));
  assert.equal(graceEligible("write", { path: "fake/.ai-work/../STATE.md" }, dir), false);
});
for (const command of ["git status", "git status --short", "git diff", "git diff --stat HEAD", "git diff --name-only -- src/a.ts", "git log -5 --oneline", "git rev-parse HEAD", "git branch --show-current"]) {
  test(`read-only git: ${command}`, () => assert.equal(graceEligible("bash", { command }, cwd), true));
}
for (const command of ["git status; rm x", "git status && rm x", "git status | cat", "git status &", "git status > x", "git status < x", "git status `id`", "git status $(id)", "git status (id)", "git status\ngit status", "git status\rgit status", "git -c core.pager=evil log", "git --config-env=core.pager=EVIL log", "git diff --output=x", "git diff --ext-diff", "git diff --textconv", "git log --output=x", "git log --exec=evil", "git log --upload-pack=evil", "git rev-parse --output=x", "git branch foo", "git push", "git commit", "git checkout main", "git reset", "git stash", "git alias", "git status # hi", "git status \\; rm x", "git status\u0000", "rm x", "cat .ai-work/t/STATE.md"]) {
  test(`reject hostile command: ${JSON.stringify(command)}`, () => assert.equal(graceEligible("bash", { command }, cwd), false));
}
test("unknown tools, malformed inputs and classification errors fail closed", () => {
  for (const input of [undefined, null, [], "path", {}, { path: 2 }, { command: 2 }]) {
    for (const tool of ["edit", "write", "read", "bash", "Agent", "grep", "context_handoff"]) assert.equal(graceEligible(tool, input, cwd), false);
  }
  assert.equal(graceEligible("edit", { get path() { throw new Error("bad input"); } }, cwd), false);
  assert.equal(graceEligible("edit", { path: ".ai-work/t/STATE.md\u0000" }, cwd), false);
});
