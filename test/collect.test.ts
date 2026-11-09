import test from "node:test";
import assert from "node:assert/strict";
import { touchedPaths, repoRoots, repoState, claimRepos, collectRepositories, userMessagesSince, chainIdentity, parseHandoffSections, previousHandoff, emergencyHandoff, emergencySummary, finishedState, scheduledState, primaryHead, collectHead, porcelainDirty } from "../src/collect.ts";
import { boundedAutoState, renderHandoff, MAX_HANDOFF_BYTES, handoffBackoff } from "../src/core.ts";

const message = (role: string, content: unknown, timestamp?: string) => ({ type: "message", timestamp, message: { role, content } });
const call = (name: string, args: object) => message("assistant", [{ type: "toolCall", name, arguments: args }]);
const pathDeps = { home: "/home/me", exists: (p: string) => !p.includes("missing"), isDirectory: (p: string) => !p.endsWith(".ts") };
const status = "# branch.oid abcdef1234567890\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +2 -3\n1 M. file\n? new";
const input = { goal: "finish", next_step: "continue", facts: "verified" };
const auto = { cwd: "/parent", root: "/parent", branch: "unknown", head: "unknown", jobs: [], subagents: [], claims: [], unavailable: [] };

test("touched paths inspect persisted tool calls newest first, resolve shell and generic paths", () => {
  const branch = [call("read", { path: "src/a.ts" }), call("edit", { file_path: "src/a.ts" }),
    call("bash", { command: 'cd "space repo"; git -C ../other status; git --work-tree=/work status; git worktree add /claim feature; git worktree add -b branch /new-claim; cd ~/home; cd missing', cwd: "/explicit", workdir: "/workdir" }),
    call("custom", { path: "/latest" })];
  const paths = touchedPaths(branch, "/parent", pathDeps);
  assert.equal(paths[0], "/parent");
  assert.equal(paths[1], "/latest");
  for (const path of ["/parent/space repo", "/other", "/work", "/claim", "/home/me/home", "/explicit", "/workdir", "/parent/src/a.ts", "/new-claim"]) assert.ok(paths.includes(path), path);
  assert.equal(paths.filter(p => p === "/parent/src/a.ts").length, 1);
  assert.ok(!paths.some(p => p.includes("missing")));
  assert.equal(touchedPaths(Array.from({ length: 100 }, (_, i) => call("read", { path: `/repo${i}` })), "/parent", pathDeps).length, 64);
});

test("roots dedupe worktrees, prefer cwd, inspect file parent and cap at eight", () => {
  const calls: string[] = [];
  const git = (cwd: string) => { calls.push(cwd); return cwd === "/fail" ? undefined : cwd.replace(/\/src$/, ""); };
  assert.deepEqual(repoRoots(["/repo", "/repo/src/a.ts", "/worktree", "/fail"], git, 8, pathDeps), ["/repo", "/worktree"]);
  assert.ok(calls.includes("/repo/src"));
  assert.equal(repoRoots(Array.from({ length: 20 }, (_, i) => `/r${i}`), git).length, 8);
  assert.deepEqual(repoRoots(["/fail"], () => { throw Error("git"); }), []);
});

test("one porcelain-v2 call captures repo state; failure is unknown", () => {
  let calls = 0;
  const repo = repoState("/worktree", (_cwd, ...args) => { calls++; assert.deepEqual(args, ["status", "--porcelain=v2", "--branch"]); return status; });
  assert.deepEqual(repo, { root: "/worktree", branch: "feature", head: "abcdef1234567890", dirty: 2, sync: "ahead 2, behind 3 (upstream)" });
  assert.equal(calls, 1);
  assert.equal(repoState("/x", () => { throw Error("failed"); }).head, "unknown");
  assert.equal(repoState("/x", () => undefined).sync, "unknown");
  assert.equal(repoState("/x", () => "# branch.oid (initial)\n# branch.head main").head, "unknown");
});

test("claims resolve branch worktrees and explicitly mark missing branches", () => {
  const result = claimRepos([{ branch: "feature", issue: 8 }, { branch: "missing" }], ["/repo"], () => "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /claim\nHEAD bbb\nbranch refs/heads/feature\n");
  assert.deepEqual(result.roots, ["/repo", "/claim"]);
  assert.equal((result.claims[0] as any).worktree, "/claim");
  assert.match((result.claims[1] as any).worktree, /branch missing \(no local worktree found\)/);
});

test("non-repo parent still collects touched and claimed worktrees and resolves backoff HEAD", () => {
  const result = collectRepositories("/parent", [call("bash", { command: "cd /worktree; git status" })], [], {
    ...pathDeps, now: () => 0, git: (cwd, args) => args[0] === "rev-parse" ? (cwd === "/parent" ? undefined : cwd) : args[0] === "status" ? status : "",
  });
  assert.equal(result.repos[0].root, "/worktree");
  const head = primaryHead(result.repos);
  const handoff = renderHandoff(input, { ...auto, head, repos: result.repos }, "s", 1, "/h", new Date().toISOString());
  assert.match(handoff.text, /Repositories touched:\n\/worktree \| feature \| abcdef123456/);
  assert.ok(handoffBackoff(input, handoff, head, false));
});

test("cheap HEAD lookup shares touched-repo priority and tolerates git failure", () => {
  const calls: string[][] = [];
  const deps = { ...pathDeps, now: () => 0, git: (cwd: string, args: string[]) => { calls.push(args); return cwd === "/parent" ? undefined : args[1] === "HEAD" ? "abc" : cwd; } };
  assert.equal(collectHead("/parent", [call("read", { path: "/repo/a.ts" })], deps), "abc");
  assert.ok(!calls.some(args => args[0] === "status"));
  assert.equal(collectHead("/parent", [], { ...deps, git: () => { throw Error("failed"); } }), "unknown");
  assert.deepEqual(porcelainDirty(undefined), ["unknown"]);
  assert.deepEqual(porcelainDirty("# branch.head main\n1 .M N... 100644 100644 100644 a b file.ts\n? new.ts"), [" M file.ts", "?? new.ts"]);
});

test("overall deadline limits failing/slow git and marks discovered repos uninspected", () => {
  let now = 0, calls = 0;
  const result = collectRepositories("/repo", [call("read", { path: "/other" })], [], {
    ...pathDeps, now: () => now, git: (cwd, args, timeout) => {
      calls++; assert.ok(timeout <= 800 && timeout <= 1000 - now);
      now += timeout;
      if (args[0] === "rev-parse") return cwd;
      throw Error("slow failed git");
    },
  }, 1000);
  assert.equal(calls, 2);
  assert.equal(now, 1000);
  assert.ok(result.repos.every(r => r.sync === "not inspected (time budget)"));
});

test("chain identity includes current id and handoff paths from compactions, last handoff and relaunch text", () => {
  const ids = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003"];
  const branch = [{ type: "compaction", details: { path: `/h/${ids[0]}-2.md` } }, message("user", `Resume\nHandoff file: /h/${ids[1]}-3.md\nContinue`)];
  const match = chainIdentity(branch, "current", `/h/${ids[2]}-4.md`);
  assert.deepEqual(new Set(match.sessionIds), new Set(["current", ...ids]));
  assert.deepEqual(chainIdentity([], "s"), { sessionIds: ["s"] });
});

test("verbatim user messages exclude old boundary and timestamped requests without JSON quoting", () => {
  const branch = [message("user", "old"), { type: "compaction" }, message("user", [{ type: "text", text: 'Keep "quotes"\nnext' }, { type: "image", data: "omit" }]), message("assistant", "ignore"), message("user", "new")];
  assert.equal(userMessagesSince(branch), 'Keep "quotes"\nnext\n\nnew');
  assert.equal(userMessagesSince([message("user", "old", "2026-01-01"), message("user", "new", "2026-01-03")], "2026-01-02"), "new");
  assert.equal(userMessagesSince([message("user", "old"), call("context_handoff", {}), message("user", "new")]), "new");
});

test("verbatim messages are byte bounded, newest kept, unicode safe, oversize message cut in the middle", () => {
  const output = userMessagesSince([message("user", "old".repeat(2000)), message("user", "newest")]);
  assert.ok(Buffer.byteLength(output) <= 4096);
  assert.match(output, /newest/);
  assert.match(output, /omitted: 1 older messages/);
  const single = userMessagesSince([message("user", "START" + "字😀".repeat(2000) + "END")]);
  assert.ok(Buffer.byteLength(single) <= 4096);
  assert.match(single, /^START/); assert.match(single, /END$/); assert.match(single, /…\(cut \d+ chars\)/);
  assert.ok(!single.includes("\ufffd"));
});

test("previous handoff parser and sidecar carry goal, verbatim constraints, files and path into emergency", () => {
  const markdown = "# Handoff\n\n## Goal\nShip this\n\n## User constraints (verbatim)\nDo not push.\nKeep spacing.\n\n## Read first\n/a.ts\n/b.ts\n\n## Next step\nContinue\n";
  assert.deepEqual(parseHandoffSections(markdown), { goal: "Ship this", constraints: "Do not push.\nKeep spacing.", filesToRead: ["/a.ts", "/b.ts"] });
  const path = "/handoffs/old-1.md";
  const prev = previousHandoff([message("user", `Handoff file: ${path}`)], undefined, p => { if (p.endsWith(".json")) throw Error("absent"); return markdown; });
  assert.equal(prev?.path, path);
  const emergency = emergencyHandoff([], "/session.jsonl", prev);
  assert.match(emergency.goal, /Emergency handoff; previous goal:.*Ship this/s);
  assert.equal(emergency.user_constraints, "Do not push.\nKeep spacing.");
  const constraints = "Verbatim 字\n".repeat(500);
  assert.equal(emergencyHandoff([], undefined, { ...prev!, constraints }).user_constraints, constraints);
  assert.deepEqual(emergency.files_to_read, ["/a.ts", "/b.ts"]);
  assert.match(emergency.facts, /Previous handoff: \/handoffs\/old-1.md/);
  assert.match(emergency.facts, /\/session.jsonl/);
  const summary = emergencySummary(emergency);
  assert.match(summary, /## User constraints \(verbatim\)\nDo not push\.\nKeep spacing\./);
  assert.match(summary, /## Read first\n\/a.ts\n\/b.ts/);
  assert.equal(emergencySummary(input), "# Emergency handoff\nfinish\nverified\ncontinue");
  const text = renderHandoff({ ...input, user_constraints: "verbatim\n\n", files_to_read: ["/a"] }, auto, "s", 1, path, "2026-01-01").text;
  assert.equal(previousHandoff([], { path }, () => JSON.stringify({ text }))?.constraints, "verbatim\n\n");
  assert.match(emergencyHandoff([message("user", "request\nverbatim")]).goal, /request\nverbatim/);
});

test("finished inventory uses real terminal statuses, time window, newest first, bounded cap and missing timestamps note", () => {
  const now = 10_000_000;
  const records = Array.from({ length: 14 }, (_, i) => ({ id: `job${i}`, label: "build", status: "succeeded", endedAt: now - i, exitCode: 0, logPath: "/log" }));
  const result = finishedState([{ list: () => [...records, { id: "old", status: "failed", endedAt: 1 }, { id: "running", status: "running" }] }], undefined, now);
  assert.equal(result.finishedJobs.length, 10); assert.match(result.finishedJobs[0], /job0 \| build \| succeeded \| 0 \| \/log/);
  assert.ok(!result.finishedJobs.some(s => s.includes("old")));
  assert.equal(finishedState([{ list: () => records }], now - 1, now).finishedJobs.length, 2);
  assert.match(finishedState([{ list: () => [{ id: "no-time", status: "completed" }] }], undefined, now).unavailable.join(), /timestamps/);
  assert.match(finishedState(undefined, undefined, now).unavailable.join(), /absent/);
  assert.match(finishedState([{ list: () => { throw Error("failed"); } }], undefined, now).unavailable.join(), /unreadable/);
  assert.ok(result.finishedJobs.every(s => Array.from(s).length <= 200));
});

test("scheduled inventory only uses exposed records; absent status is explicitly unavailable", () => {
  assert.deepEqual(scheduledState([{ id: "a", status: "scheduled", description: "later" }]).scheduled, ["a | scheduled | later"]);
  assert.match(scheduledState([{ id: "a", status: "queued" }]).unavailable.join(), /scheduled agents: not exposed by registry/);
});

test("all maximum automatic sections fit alongside 12 KiB narrative and preserve bounded sidecar", () => {
  const large = { ...auto, cwd: "字".repeat(1000), root: "/" + "字".repeat(1000), branch: "字".repeat(1000), head: "字".repeat(1000), unavailable: Array(8).fill("字".repeat(1000)), jobs: Array(1000).fill("j".repeat(600)), subagents: Array(1000).fill("a".repeat(400)),
    dirty: Array(31).fill("d".repeat(200)), sync: "s".repeat(256), claims: Array(100).fill({ worktree: "w".repeat(300) }),
    questions: Array(20).fill("q".repeat(200)), resumeCheck: "r".repeat(4096), scheduled: Array(100).fill("s".repeat(400)),
    finishedJobs: Array(100).fill("字".repeat(200)), userMessages: "u".repeat(4096), repos: Array(8).fill({ root: "/" + "r".repeat(300), branch: "b".repeat(300), head: "f".repeat(40), dirty: 123, sync: "s".repeat(300) }) };
  const handoff = renderHandoff({ ...input, facts: "f".repeat(12 * 1024) }, large, "s", 1, "/h", "2026-01-01");
  assert.ok(Buffer.byteLength(handoff.text) <= MAX_HANDOFF_BYTES);
  assert.match(handoff.text, /User messages since previous handoff \(verbatim\)/);
  assert.match(handoff.text, /Scheduled agents/);
  assert.match(handoff.text, /Finished since last handoff \(results not yet acted on\)/);
  const bounded = boundedAutoState(large);
  assert.equal(bounded.repos?.length, 8);
  assert.ok(bounded.repos!.every(r => Buffer.byteLength(`${r.root} | ${r.branch} | ${r.head.slice(0, 12)} | dirty ${r.dirty} | ${r.sync}`) <= 300));
  assert.ok(Buffer.byteLength(bounded.userMessages!) <= 4096);
});
