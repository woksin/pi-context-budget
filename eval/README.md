# Intent-memory measurement (S0, dev-only)

Nothing here is imported by the extension. No memory feature or flag is enabled.
The package's existing `files` allowlist excludes `eval/` and `test/`. There are
no new dependencies. Flags-off behavior tests belong to the individual memory
slices; this harness does not pin runtime source or package hashes.

## Availability

```sh
node eval/availability.mjs eval/fixtures/chain.json
cat manifest.json | node eval/availability.mjs -
```

A manifest contains `chains`, each with a unique `id`, `directives` and
`handoffs`. Each directive needs a unique `id`, a nonempty human `quote`, and
ISO `sourceTs`. Optional `paraphrase` is a human-annotated, case-insensitive
JavaScript regex. Optional `retiredAt` requires a later timestamp and a nonempty
`retirementReason` citing the user correction/supersession. Do not use absence
as retirement. Handoffs need a unique `id`, ISO `ts`, and `text` or `file` (UTF-8,
relative to the manifest; stdin manifests resolve from the current directory).
Only evaluate handoffs strictly after the directive's source time. At or after
retirement, report a retired opportunity, not an active denominator entry.

Per handoff/directive, output is `verbatim` (full quote, whitespace normalized),
`paraphrase` (annotated regex), or `absent`. This is mechanical availability,
not semantic equivalence or proof of compliance. Without a paraphrase annotation,
only the literal quote can match. Regex annotations are trusted local input;
review broad patterns and avoid pathological regexes. Invalid annotations exit
nonzero. Missing/empty directive annotations produce `no annotations, skipped`.

`inConstraints` looks in level-two **User constraints…** or **User directives…**
sections, ending at the next level-two heading. Reports include per-handoff,
per-chain and pooled counts/rates; empty denominators have `null` rates.
`retirements` lists reasons separately, and `retired` counts retired opportunities.
The wholly synthetic fixture demonstrates a retained, paraphrased, lost and
explicitly retired directive across three successive handoffs.

For future S4b comparisons, handoffs may carry manually annotated
`tiers: { "pointer": ["id"], "indexOnly": ["id"] }`. Reported locations are
`inline`, `pointer`, `index-only`, or `absent`; inline takes precedence. Tier ids
must be distinct, known directive ids. `reachabilityPct` includes declared tiers;
it does **not** resolve/verify pointers or read a durable store. Tier annotations
are not yet inferred from S4b rendering. `availabilityPct` remains inline-only,
so a durable pointer cannot inflate historical retention comparisons.

### Local study adapter

```sh
node eval/availability.mjs --reverify "$STUDY/local-study.json" > "$STUDY/baseline/availability.json"
```

Keep the study manifest, raw inputs and outputs outside the repository. No
study filenames, session identifiers, exclusion policies or conversation excerpts
are built into the adapter. Supply them explicitly in a local JSON manifest:

```json
{
  "scanFile": "snapshots/scan.jsonl",
  "chains": [{ "id": "chain-A", "config": "annotations/chain-A.json" }],
  "exclusions": [{ "chain": "chain-A", "id": "rule-B", "reason": "Reviewed annotation is too broad." }],
  "unannotated": [{ "id": "chain-B", "file": "snapshots/chain-B.json" }]
}
```

`scanFile`, chain `config` filenames and unannotated snapshot `file` paths are
relative to the local manifest. Chain ids are caller-chosen report labels.
`exclusions` and `unannotated` default to empty arrays. Exclusions must name an
annotated chain/directive and give a nonempty reason; they are copied to output.
Unannotated snapshots must exist and contain JSON; they are reported as skipped.

Each config contains `sid`, `dump`, and `directives`. `dump` is relative to that
config file. Each directive annotation has `id`, zero-based human source index
`src`, optional paraphrase regex `re`, and optional retirement source index `end`.
A dump contains its full `sid` and `human: [{ "t": "Synthetic instruction.",
"ts": "2026-01-01T00:00:00Z" }]`. Its full id must start with the config's `sid`.
The JSONL scan contains records `{ "sid": "session-A-full", "comp": [{ "ts":
"2026-01-02T00:00:00Z", "s": "Synthetic handoff text." }] }`. Full dump ids select
scan records, avoiding short-prefix collisions. Source and retirement text are
read from the selected dump, never compiled into the public harness.

The adapter streams the scan and reads only the explicit local snapshots. It
never follows a dump's session-file path, imports runtime storage code, loads
agent configuration, or writes a session. Only the shell's requested output file
is written. This is a fresh stdlib implementation of snapshot-based retention
measurement; no private study script or conversation is bundled.

## Exploratory replay probes

```sh
# Offline protocol smoke test, NOT evidence of model compliance:
node eval/probes.mjs --runner 'node eval/fixtures/stub-runner.mjs' --model stub@1
# Explicit, user-controlled model adapter (not bundled):
node eval/probes.mjs --runner './my-runner' --model 'provider/model@pinned-revision' --handoff handoff.md
```

All six scenarios and quoted instructions are invented: no unrelated quality
campaigns, orchestrate-only, economy-model grunt implementation rather than
planning, no builds before all planned edits, message-watch rearming, and an
assistant-invented edit prohibition. The last is a **negative control**, not a
human directive. Its result is reported separately; never pool it into directive
compliance. The stub deliberately reports this control as unsuccessful to test
that separation; it does not claim real compliance.

The explicitly supplied trusted local shell command receives one JSON request
on stdin per probe: `{schema, model, mode, probe, handoff, instruction}`. The
probe includes synthetic provenance, an invented quote, task and scoring criterion.
A runner must return only `{ "compliant": boolean, "reason": "nonempty explanation" }`.
Nonzero exit, timeout (30 seconds per probe), malformed JSON or wrong types fail
the run. The harness invokes no network or model by itself. Shell commands can
have side effects: inspect your adapter before opting in. Never point it at a
live agent/session that can execute the proposed actions.

Without `--handoff`, mode is `source-visible-control`, a sanity check with the
source excerpt available. With it, mode is `handoff-replay`: the adapter must
separate answering from judging, show the answering model **only** the task and
handoff, and reserve source quote/criterion for the judge. Otherwise it leaks
the answer and invalidates the experiment. Reported results are adapter-provided
judgements, not independent verification. No numeric aggregate compliance score
is claimed. Pin model and judge versions/settings in the adapter; `--model` is
recorded provenance, not remotely verified enforcement. Preserve those settings
for before/after comparisons and disclose judge limitations.

## Checks

`npm test` discovers `test/eval.test.ts` along with the existing suite. It uses
only synthetic fixtures and temporary snapshots under `os.tmpdir()`, removed
with a test cleanup hook even on failure; never live sessions or a real model.
CI's existing typecheck, tests, shell checks and pack dry-run remain unchanged.
No dedicated formatter/linter is configured; `git diff --check` covers whitespace.
