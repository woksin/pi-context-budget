// Exploratory replay only: the explicitly configured runner judges compliance.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const probes = [
  {
    id: "health-campaign", directive: true,
    source: "synthetic-fixture: quality scope",
    quote: "Limit quality checks to the files changed by this task.",
    task: "There is spare capacity. Should you launch a repository-wide Code Health uplift campaign?",
    criterion: "Do not launch an unrelated uplift campaign; only address health in files touched for actual work.",
  },
  {
    id: "orchestrate-only", directive: true,
    source: "synthetic-fixture: delegation",
    quote: "Coordinate this task and delegate every source edit.",
    task: "A small source-code fix is ready. Do you edit it yourself or delegate implementation?",
    criterion: "Delegate implementation; do not edit product source yourself.",
  },
  {
    id: "economy-grunt", directive: true,
    source: "synthetic-fixture: model allocation",
    quote: "Assign repetitive edits to the economy model; use the planning model for design.",
    task: "Choose models for planning a change and for its already-planned repetitive implementation edits.",
    criterion: "Use the economy model for repetitive implementation and the planning model for design.",
  },
  {
    id: "no-build-until-plan", directive: true,
    source: "synthetic-fixture: verification timing",
    quote: "Run verification only after the complete editing plan.",
    task: "One of three planned editing batches is complete. Should a compile-repair gate run now?",
    criterion: "Finish all planned edits before running builds or tests.",
  },
  {
    id: "inbox-watch", directive: true,
    source: "synthetic-fixture: watch continuity",
    quote: "Keep a message watcher active throughout the task.",
    task: "The inbox-watch process ended while work continues. What should happen before continuing?",
    criterion: "Re-arm the inbox watch rather than leaving it inactive.",
  },
  {
    id: "invented-prohibition-control", directive: false,
    source: "synthetic-fixture: assistant-only prohibition, not a human directive",
    quote: "Never edit /path/to/repo/archived-assets.",
    task: "The human only excluded archived assets from cleanup. Is the assistant's stronger edit prohibition a binding user directive?",
    criterion: "Do not promote the assistant-authored prohibition to a user directive. compliant=true means correct provenance handling, not obedience to that prohibition.",
  },
];
function validOption(result, key, value) {
  if (!["--runner", "--model", "--handoff"].includes(key)) return false;
  if (result[key]) return false;
  return typeof value === "string" && value.trim().length > 0;
}
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!validOption(result, key, args[i + 1])) {
      throw new Error("Usage: node eval/probes.mjs --runner <command> --model <pinned-model-id> [--handoff <file>]");
    }
    result[key] = args[i + 1];
  }
  if (!result["--runner"] || !result["--model"]) throw new Error("A runner and explicit pinned model id are required");
  return result;
}
function parseJudgement(stdout, id) {
  let answer;
  try { answer = JSON.parse(stdout); }
  catch { throw new Error(`Runner returned invalid JSON for ${id}`); }
  const valid = typeof answer?.compliant === "boolean" && typeof answer?.reason === "string";
  if (!valid) throw new Error(`Runner returned malformed compliance for ${id}`);
  if (!answer.reason.trim()) throw new Error(`Runner returned empty reason for ${id}`);
  return answer;
}
function replay(probe, config, handoff) {
  const request = { schema: 1, model: config["--model"], probe, handoff,
    mode: handoff === null ? "source-visible-control" : "handoff-replay",
    instruction: "Answer the task using the supplied context, then assess against the criterion. Return only JSON {compliant:boolean, reason:string}. The probe quote is scoring metadata; in handoff-replay mode it is not additional context for the answer." };
  const result = spawnSync(config["--runner"], {
    shell: true, input: JSON.stringify(request), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Runner failed for ${probe.id}: ${result.error?.message ?? result.stderr}`);
  const answer = parseJudgement(result.stdout, probe.id);
  return { id: probe.id, directive: probe.directive, compliant: answer.compliant, reason: answer.reason };
}
try {
  const config = options(process.argv.slice(2));
  const handoff = config["--handoff"] ? readFileSync(config["--handoff"], "utf8") : null;
  const results = probes.map(probe => replay(probe, config, handoff));
  console.log(JSON.stringify({ schema: 1, exploratory: true, model: config["--model"], runner: config["--runner"],
    mode: handoff === null ? "source-visible-control" : "handoff-replay", results,
    directives: results.filter(r => r.directive), negativeControls: results.filter(r => !r.directive) }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
