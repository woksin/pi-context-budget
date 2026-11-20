import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(join(root, "eval/fixtures/chain.json"), "utf8"));
function cli(script: string, args: string[] = [], input?: unknown) {
  return spawnSync(process.execPath, [`eval/${script}.mjs`, ...args], {
    cwd: root, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8",
  });
}
function availability(input = fixture) {
  const result = cli("availability", ["-"], input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("availability classifies each active directive and keeps retirement separate", () => {
  const report = availability();
  const chain = report.chains[0];
  assert.deepEqual(chain.handoffs.map((h: any) => h.rows.map((r: any) => r.classification ?? r.status)), [
    ["verbatim", "verbatim", "verbatim", "verbatim"],
    ["paraphrase", "verbatim", "paraphrase", "retired"],
    ["absent", "absent", "absent", "retired"],
  ]);
  assert.equal(chain.stats.applicable, 10);
  assert.equal(chain.stats.inline, 7);
  assert.equal(chain.stats.inConstraints, 6);
  assert.equal(chain.stats.retired, 2);
  assert.equal(chain.retirements[0].reason, "The synthetic user completed the editing plan.");
  assert.equal(report.stats.availabilityPct, 70);
  assert.equal(report.stats.constraintsPct, 60);
});

test("availability accepts handoff files and reports per chain and unannotated skips", () => {
  const result = cli("availability", ["eval/fixtures/chain.json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = availability({ chains: [...fixture.chains, { id: "unannotated", handoffs: [] }] });
  assert.equal(report.chains[1].status, "no annotations, skipped");
  assert.deepEqual(report.stats, report.chains[0].stats);
});

test("explicit future tiers distinguish inline availability from declared reachability", () => {
  const input = structuredClone(fixture);
  input.chains[0].handoffs[2].tiers = { pointer: ["health"], indexOnly: ["orchestrate"] };
  const report = availability(input);
  assert.equal(report.stats.inline, 7);
  assert.equal(report.stats.pointer, 1);
  assert.equal(report.stats.indexOnly, 1);
  assert.equal(report.stats.reachabilityPct, 90);
});

test("source and retirement boundaries use instants, not timestamp spelling", () => {
  const input = structuredClone(fixture);
  input.chains[0].handoffs[0].ts = "2026-01-01T01:00:00+01:00";
  const report = availability(input);
  assert.equal(report.chains[0].handoffs[0].rows.length, 0);
  assert.equal(report.stats.applicable, 6);
});

test("malformed annotations exit nonzero, including bad regexes and retirement metadata", () => {
  const mutations = [
    (d: any) => { delete d.quote; },
    (d: any) => { d.sourceTs = "yesterday"; },
    (d: any) => { d.paraphrase = "["; },
    (d: any) => { d.retiredAt = "2026-01-03T00:00:00Z"; },
    (d: any) => { d.id = ""; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(fixture);
    mutate(input.chains[0].directives[0]);
    const result = cli("availability", ["-"], input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /annotation/i);
  }
  const duplicate = structuredClone(fixture);
  duplicate.chains[0].directives.push(duplicate.chains[0].directives[0]);
  assert.notEqual(cli("availability", ["-"], duplicate).status, 0);
});

test("six replay probes use a stub runner and keep negative control out of directive compliance", () => {
  const result = cli("probes", ["--runner", `${process.execPath} eval/fixtures/stub-runner.mjs`, "--model", "stub@1"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.model, "stub@1");
  assert.equal(report.results.length, 6);
  assert.equal(report.directives.length, 5);
  assert.ok(report.directives.every((d: any) => d.compliant));
  assert.equal(report.negativeControls[0].id, "invented-prohibition-control");
  assert.equal(report.negativeControls[0].directive, false);
  assert.equal(report.negativeControls[0].compliant, false);
});

test("replay probes reject an unpinned or failing runner", () => {
  assert.notEqual(cli("probes", ["--runner", "false"]).status, 0);
  const result = cli("probes", ["--runner", "false", "--model", "stub@1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runner/i);
});

test("replay supports handoff input and rejects malformed runner judgements", () => {
  const replay = cli("probes", ["--runner", `${process.execPath} eval/fixtures/stub-runner.mjs`, "--model", "stub@1", "--handoff", "eval/fixtures/chain.json"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).mode, "handoff-replay");
  for (const runner of ["printf 'not-json'", "printf '{\"compliant\":\"yes\"}'"]) {
    assert.notEqual(cli("probes", ["--runner", runner, "--model", "stub@1"]).status, 0);
  }
});

test("study adapter uses a local manifest for chains, exclusions and unannotated snapshots", t => {
  const dir = mkdtempSync(join(tmpdir(), "eval-study-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = fixture.chains[0].directives[0];
  const human = [{ t: source.quote, ts: source.sourceTs }];
  const directives = [
    { id: "keep", src: 0, re: source.paraphrase },
    { id: "omit", src: 0, re: "invented broad pattern" },
  ];
  writeFileSync(join(dir, "annotations.json"), JSON.stringify({ sid: "session-A", dump: "snapshot.json", directives }));
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ sid: "session-A-full", human, f: "/path/to/repo/never-read" }));
  writeFileSync(join(dir, "unannotated.json"), "{}");
  const records = [
    { sid: "session-A-other", comp: [] },
    { sid: "session-A-full", comp: [{ ts: "2026-01-02T00:00:00Z", s: `## User constraints\n${source.quote}` }] },
  ];
  writeFileSync(join(dir, "scan.jsonl"), records.map(record => JSON.stringify(record)).join("\n"));
  const exclusions = [{ chain: "chain-A", id: "omit", reason: "Synthetic broad annotation excluded." }];
  const manifest = {
    scanFile: "scan.jsonl", chains: [{ id: "chain-A", config: "annotations.json" }], exclusions,
    unannotated: [{ id: "chain-B", file: "unannotated.json" }],
  };
  const manifestFile = join(dir, "local-study.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const result = cli("availability", ["--reverify", manifestFile]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.exclusions, exclusions);
  assert.equal(report.chains[0].id, "chain-A");
  assert.equal(report.stats.applicable, 1);
  assert.equal(report.stats.availabilityPct, 100);
  assert.equal(report.chains.at(-1).id, "chain-B");
  assert.equal(report.chains.at(-1).status, "no annotations, skipped");
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, exclusions: [] }));
  const withoutExclusion = cli("availability", ["--reverify", manifestFile]);
  assert.equal(withoutExclusion.status, 0, withoutExclusion.stderr);
  assert.equal(JSON.parse(withoutExclusion.stdout).stats.applicable, 2);
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, exclusions: [{ ...exclusions[0], reason: "" }] }));
  assert.notEqual(cli("availability", ["--reverify", manifestFile]).status, 0);
});

test("eval remains dev-only in npm pack", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  const files = Object.values(packed)[0] as { files: { path: string }[] };
  const paths = files.files.map(f => f.path);
  assert.ok(paths.includes("src/extension.ts"));
  assert.ok(!paths.some((f: string) => /^(eval|test)\//.test(f)));
});
