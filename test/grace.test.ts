import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { graceEligible, resolveToolPath } from "../src/grace.ts";
import { findRuntime } from "./runtime.ts";

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pcb9-grace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
test("canonical paths reject symlink escapes after lexical normalization", t => {
  const dir = fixture(t);
  mkdirSync(join(dir, ".ai-work/t"), { recursive: true });
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  writeFileSync(join(dir, "src/STATE.md"), "source");
  symlinkSync(join(dir, "src"), join(dir, ".ai-work/t/escape"));
  symlinkSync(join(dir, "src/STATE.md"), join(dir, ".ai-work/t/linked.md"));
  symlinkSync(join(dir, "src/deep"), join(dir, ".ai-work/t/deep"));
  symlinkSync(join(dir, ".ai-work/t"), join(dir, "notes"));
  for (const tool of ["edit", "write", "read"]) {
    for (const path of [".ai-work/t/escape/STATE.md", ".ai-work/t/escape/new.md", ".ai-work/t/linked.md", "notes/../STATE.md", "notes/../src/STATE.md", "@notes/../STATE.md"]) {
      assert.equal(graceEligible(tool, { path }, dir), false, `${tool}: ${path}`);
    }
    assert.equal(graceEligible(tool, { path: "notes/STATE.md" }, dir), true);
    assert.equal(graceEligible(tool, { path: "@notes/STATE.md" }, dir), true);
    assert.equal(graceEligible(tool, { path: ".ai-work/t/deep/../STATE.md" }, dir), true);
    assert.equal(graceEligible(tool, { path: ".ai-work/t/new/sub/STATE.md" }, dir), true);
  }
  symlinkSync(join(dir, "src"), join(dir, "fake"));
  assert.equal(graceEligible("write", { path: "fake/.ai-work/../STATE.md" }, dir), false);
});
for (const command of ["git status", "git status --short", "git diff --no-ext-diff --no-textconv", "git diff --no-ext-diff --no-textconv --stat HEAD", "git diff --no-ext-diff --no-textconv --name-only -- src/a.ts", "git log --no-show-signature -5 --oneline", "git rev-parse HEAD", "git branch --show-current", "git worktree list --porcelain"]) {
  test(`read-only git: ${command}`, () => assert.equal(graceEligible("bash", { command }, cwd), true));
}
for (const command of ["git diff", "git diff --stat HEAD", "git diff --no-ext-diff", "git diff --no-textconv", "git diff -- --no-ext-diff --no-textconv", "git -p status", "git --paginate log", "git log", "git log --oneline", "git log --no-show-signature --oneline --stat", "git log --no-show-signature --oneline --numstat", "git log --no-show-signature --oneline -p", "git log --no-show-signature --oneline --patch", "git log --no-show-signature --oneline -u", "git log --no-show-signature --oneline --word-diff", "git log --no-show-signature --oneline -L1,2:src/a.ts", "git log --no-show-signature --oneline --format=%GS", "git worktree add x", "git status; rm x", "git status && rm x", "git status | cat", "git status &", "git status > x", "git status < x", "git status `id`", "git status $(id)", "git status (id)", "git status\ngit status", "git status\rgit status", "git -c core.pager=evil log", "git --config-env=core.pager=EVIL log", "git diff --output=x", "git diff --ext-diff", "git diff --textconv", "git log --output=x", "git log --exec=evil", "git log --upload-pack=evil", "git rev-parse --output=x", "git branch foo", "git push", "git commit", "git checkout main", "git reset", "git stash", "git alias", "git status # hi", "git status \\; rm x", "git status\u0000", "rm x", "cat .ai-work/t/STATE.md"]) {
  test(`reject hostile command: ${JSON.stringify(command)}`, () => assert.equal(graceEligible("bash", { command }, cwd), false));
}
test("tool normalization agrees with pi's unexported resolver", { skip: !findRuntime() }, async t => {
  const dir = fixture(t);
  const pi = await import(pathToFileURL(join(findRuntime()!, "dist/core/tools/path-utils.js")).href);
  for (const path of [".ai-work/t/STATE.md", "@.ai-work/t/STATE.md", "notes/../STATE.md", "@~/notes/../.ai-work/t/STATE.md", "~", "~/", "~other/.ai-work/x.md", ".ai-work/a\u00a0b/STATE.md", pathToFileURL(join(dir, ".ai-work/t/STATE.md")).href]) {
    assert.equal(resolveToolPath(path, dir), pi.resolveToCwd(path, dir), path);
    for (const tool of ["read", "edit", "write"]) {
      assert.equal(graceEligible(tool, { path }, dir), graceEligible(tool, { path: pi.resolveToCwd(path, dir) }, dir), `${tool}: ${path}`);
    }
  }
});
test("read's Unicode fallback follows pi before checking symlink eligibility", { skip: !findRuntime() }, async t => {
  const dir = fixture(t);
  const pi = await import(pathToFileURL(join(findRuntime()!, "dist/core/tools/path-utils.js")).href);
  mkdirSync(join(dir, ".ai-work/t"), { recursive: true });
  writeFileSync(join(dir, "STATE.md"), "not state");
  for (const name of ["a\u2019b.md", "Screenshot 1\u202FAM.md", "\u00e9.md".normalize("NFD")]) symlinkSync(join(dir, "STATE.md"), join(dir, ".ai-work/t", name));
  for (const path of [".ai-work/t/a'b.md", ".ai-work/t/Screenshot 1 AM.md", ".ai-work/t/\u00e9.md"]) {
    assert.equal(graceEligible("read", { path }, dir), false, path);
    assert.equal(graceEligible("read", { path: pi.resolveReadPath(path, dir) }, dir), false, path);
  }
});
test("home and at-prefixed paths examine the real symlink target", t => {
  const home = fixture(t), previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  assert.equal(homedir(), home);
  mkdirSync(join(home, ".ai-work/t"), { recursive: true });
  mkdirSync(join(home, "repo"));
  symlinkSync(join(home, "repo"), join(home, ".ai-work/escape"));
  symlinkSync(join(home, ".ai-work/t"), join(home, ".ai-work/inside"));
  for (const tool of ["edit", "write", "read"]) {
    for (const path of ["~/.ai-work/escape/x.md", "@~/.ai-work/escape/x.md"]) assert.equal(graceEligible(tool, { path }, join(home, "repo")), false, path);
    for (const path of ["~/.ai-work/t/x.md", "@~/.ai-work/t/x.md", "~/.ai-work/inside/x.md", `@${home}/.ai-work/t/x.md`]) assert.equal(graceEligible(tool, { path }, join(home, "repo")), true, path);
  }
});
test("granted git commands cannot invoke configured diff, textconv or pager helpers", t => {
  const dir = fixture(t), marker = join(dir, "executed"), helper = join(dir, "helper");
  writeFileSync(helper, `#!/bin/sh\nprintf executed >> '${marker}'\n`, { mode: 0o755 });
  const run = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXTERNAL_DIFF: helper, GIT_PAGER: helper, PAGER: helper, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.status, 0, result.stderr);
  };
  run(["init"]);
  writeFileSync(join(dir, ".gitattributes"), "file.md diff=hostile\n");
  writeFileSync(join(dir, "file.md"), "before\n");
  run(["add", "."]); run(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
  for (const key of ["diff.external", "diff.hostile.command", "diff.hostile.textconv", "core.pager", "gpg.program"]) run(["config", key, helper]);
  run(["config", "log.showSignature", "true"]);
  writeFileSync(join(dir, "file.md"), "after\n");
  run(["diff", "HEAD", "--", "file.md"]);
  assert.equal(readFileSync(marker, "utf8"), "executed", "hostile external helper must actually be configured");
  rmSync(marker);
  run(["diff", "--no-ext-diff", "--textconv", "HEAD", "--", "file.md"]);
  assert.equal(existsSync(marker), true, "hostile textconv must actually be configured");
  rmSync(marker);
  for (const command of ["git diff --no-ext-diff --no-textconv HEAD -- file.md", "git diff --no-ext-diff --no-textconv --stat", "git log --no-show-signature --oneline", "git status --short", "git rev-parse HEAD", "git branch --show-current", "git worktree list"]) {
    assert.equal(graceEligible("bash", { command }, dir), true, command);
    run(command.split(" ").slice(1));
    assert.equal(existsSync(marker), false, command);
  }
});
test("unknown tools, malformed inputs and classification errors fail closed", () => {
  for (const input of [undefined, null, [], "path", {}, { path: 2 }, { command: 2 }]) {
    for (const tool of ["edit", "write", "read", "bash", "Agent", "grep", "context_handoff"]) assert.equal(graceEligible(tool, input, cwd), false);
  }
  assert.equal(graceEligible("edit", { get path() { throw new Error("bad input"); } }, cwd), false);
  assert.equal(graceEligible("edit", { path: ".ai-work/t/STATE.md\u0000" }, cwd), false);
});
