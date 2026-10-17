# Verification — 2026-10-17

Staging only; no global installation, repository creation or publication. Runtime files and runner state are isolated under this checkout's `.ai-work/`. No live agent configuration or external source checkout was modified.

## Round-1 structural revision (current)

The lifecycle policy is now the pure immutable state machine in `src/core.ts`; `extension.ts` translates pi events and executes explicit effects. Observe/off/guard-off leave native compaction untouched. A valid hard-limit handoff recovers in-process; cap/loop fallback remains independent. Wrapper ownership is bound to PID, primary hosting identity and a fresh per-launch nonce.

Current local results (Node 26.8.1, pi 1.2.0):
- `npm test`: **exit 0**, 151 tests: 150 passed, one CI-only presence assertion skipped. The real-runtime tests ran, not skipped.
- `npm run typecheck`: **exit 0**.
- `npm run check:shell`: **exit 0**.
- `npm pack --dry-run`: **exit 0**, seven generic files, ~22.9 KB packed / 69.2 KB unpacked.
- No Node 22/24 or independent review pass is claimed; those existing parent-owned gates remain outstanding.

The transition table covers every named state, inactive-mode action barriers, hard handoff recovery with/without a wrapper, continuation bounds, idle-only storage, failure classes, bounded retries, callback correlation, mode/guard disarming and cap/loop protection. Offline real-pi tests verify actual internal `agent_start` continuations, native observe/off summaries, cancellation and Nothing-to-compact routing, plus primary/SDK-child hosting. They inject deterministic token observations to isolate lifecycle ordering from faux-provider bootstrap estimates; the paid tests below use actual provider usage.

### Verified source contracts

- Pi `dist/core/agent-session-runtime.js:205–237` sets ancestry for main forks and tears down the previous runtime before binding its replacement. `parentSession` therefore cannot identify a child.
- Installed pi-subagents `src/agent-runner.ts:1059–1074` permits in-memory children without ancestry; `1106–1123` creates/binds SDK sessions while the parent runtime remains alive. `agent-manager.ts:828–868` attaches the child after binding. The package's process-local hosting registry follows this lifecycle, independently of UI and ancestry. The primary must load the package before its SDK children; child-only installation is unsupported and documented.
- Pi `dist/core/agent-session.js:884–886` forwards internal `agent_start`; the run/prepare boundaries at `1391–1473` distinguish external `before_agent_start` from settle continuation. Only `before_agent_start` resets external-run continuation intent.
- Pi `agent-session.js:2201–2321` emits `session_compact_failed` before rethrowing a manual failure; `2802–2811` routes that through compact's callback. Attempt ids prevent hook plus `onError` from counting one failure twice. Cancelled/no-op failures are benign; transient owned/automatic failures retry at the next eligible input/automatic boundary at most twice; persistent or exhausted failures arm fallback. Success or a mode/guard change disarms it.

### Haiku rerun — exactly once per scenario this round

```sh
python3 -B scripts/phase.py run --kind integration --label 'round-1 Haiku enforce E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py enforce r1
python3 -B scripts/phase.py run --kind integration --label 'round-1 Haiku observe E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py observe r1
python3 -B scripts/phase.py run --kind integration --label 'round-1 Haiku wrapper E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py wrapper r1
```

| Scenario | Exit | Result | USD |
|---|---:|---|---:|
| (a) enforce | 0 | 3 retain-none commits, 4 blocked calls, same session, six correct code words + DONE | 0.01392757 |
| (b) observe | 0 | No blocks, handoffs, compactions or relaunches; would-do events and completed task | 0.00946479 |
| (c) wrapper | 0 | 1 in-process commit then cap fallback; exactly 1 relaunch, 2 sessions, consumed nonce marker + WRAPPER-DONE | 0.00256616 |

**Round spend: $0.02595852**, under $5. The wrapper scenario now deliberately uses a one-handoff cap, not a hard limit: hard plus a valid handoff must recover in-process. Credentials, session/log/status paths and phase state remain isolated as described below; no live agent/source directory was written and nothing was installed or published.

## Initial implementation results (historical)

The sections below record the original build, before this structural revision. Their initial test counts, budgets, costs and limitations are historical; the current behavior and current gates are above.

## Local gate

- `npm test`: exit **0** (portable suite before the last wrapper-alias test: 29 tests, 28 passed; only the CI-only runtime-presence assertion skipped).
- Final suite: **30/30 passed**, no skips, on **Node v26.8.1**, with `CI=true node --test --test-timeout=30000 'test/*.test.ts'` as the effective producer command. It was invoked via the npm-exec matrix attempts described below; the explicit runtime diagnostic establishes the actual version.
- `npm run typecheck`: exit **0**, against installed pi **1.2.0** types. Final equivalent producer `node node_modules/typescript/bin/tsc --noEmit` also exited **0** on Node 26.
- `npm run check:shell`: exit **0** (`bash -n bin/pi-session`).
- `npm pack --dry-run`: exit **0**, **7 files**, ~18.6 KB packed / 53.9 KB unpacked. Only LICENSE, README.md, package.json, bin/pi-session and three src files. Deployment docs, tests, workflows, credentials, `.ai-work/`, the staging bridge and scripts are excluded.

Tests cover thresholds/floors/null measurements, main/child headers, config/model overrides/cwd selection, rendering/validation/byte cap/uniqueness, observe/off no-ops, markers/wrapper recovery, optional registries, shared guard opt-out, idle/error paths, sibling-tool races and telemetry failure. No provider calls/network are used by unit tests.

### Node 22/24 matrix: configured, NOT locally verified

Both CI matrix entries are in `.github/workflows/ci.yml`, with an explicit pi 1.2.0 installation, typecheck, tests, shell syntax and pack dry run. The release workflow reuses this gate.

Local attempts used:

```sh
CI=true npm exec --yes --package=node@22 -- node --test --test-timeout=30000 'test/*.test.ts'
CI=true npm exec --yes --package=node@24 -- node --test --test-timeout=30000 'test/*.test.ts'
```

Both exited 0 but actually selected **Node 26**: npm did not install the requested executable because install scripts were blocked. A version diagnostic caught the mismatch. Two bounded rebuild attempts also reported that the `allowScripts` policy blocked the binary installer; that policy was not bypassed or changed. These commands are **not evidence of Node 22/24 compatibility**. Their passing results apply only to Node 26. No GitHub workflow has run because the parent has not created/pushed the public repository.

CodeScene tools and an independent review workflow are not exposed in this build agent, so neither gate is claimed. There is no separate application solution/build or formatter gate in this package.

## Real-provider scenarios (final package shape)

From the checkout root, each invocation is one separate bounded phase:

```sh
python3 -B scripts/phase.py run --kind integration --label 'packaged Haiku enforce E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py enforce package
python3 -B scripts/phase.py run --kind integration --label 'packaged Haiku observe E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py observe package
python3 -B scripts/phase.py run --kind integration --label 'packaged Haiku wrapper E2E' --timeout 280 --queue-timeout 10 -- python3 -B scripts/e2e.py wrapper package
```

The Python driver additionally bounds each subprocess to 270 seconds. No sleep/poll loops. Reusing a result directory is refused; an optional suffix selects a new isolated directory.

The effective pi arguments are:

```sh
pi -ne -nc --no-mcp --no-skills --no-prompt-templates \
  --session-dir "$WORK/sessions" \
  -e "$AUTH_EXTENSION" -e "$PACKAGE_ROOT/context-budget.ts" \
  --model anthropic/claude-haiku-5-5 -p "@$WORK/prompt.md"
# wrapper case:
bash "$PACKAGE_ROOT/bin/pi-session" <the-same-options> -- "@$WORK/prompt.md"
```

`context-budget.ts` is a staging-only compatibility bridge to `src/extension.ts`; the public manifest loads `src/extension.ts` directly. The paid driver follows the prototype print-mode commands and reuses its usage-analysis approach; `scripts/analyze.py` is the retained prototype analyzer. RPC/PTY drivers were not rerun for this production build.

`PI_CODING_AGENT_DIR`, session/config/state/job/marker locations all point into `$WORK` under `.ai-work/e2e/`. Parent wrapper ownership is explicitly removed from the child environment. Existing Anthropic credentials are read into the child's environment, never copied to disk, printed or refreshed in the live credential store. The installed OAuth transport extension is loaded read-only. Jiti filesystem caching is disabled for these runs.

| Scenario | Exit | Results | API cost (USD) |
|---|---:|---|---:|
| (a) enforce | 0 | 3 handoff commits/retain-none entries, 3 blocked calls, same session, six verified code words and DONE | 0.01553627 |
| (b) observe | 0 | 0 blocks, 0 handoff commits/compactions, 0 relaunches; would-do events; all six code words and DONE | 0.00967033 |
| (c) wrapper | 0 | Exactly 1 relaunch, 2 session/status files, consumed marker, WRAPPER-DONE | 0.00555327 |

Assertions parse actual session JSONL, events, status and result files. All handoff compactions are hook-generated with `details.kind == "handoff"`; pi maps retain-none null to the entry's own id. Status reports correct cwd/model/main role; no hook errors were recorded. Unit tests separately cover idle handling and the unavailable-child-wrapper safety case.

Low test limits: main soft 9k / handoff 12k / hard 100k, progress 1k; wrapper soft 9k / handoff 11k / hard 13k. Real tasks read natural-language sections sequentially and persist progress; no global session rules are loaded.

## Spend and scope

Final package scenarios total **$0.03075987**. Across all nine paid runs in this build session (initial implementation, lifecycle hardening, then the user-requested public-package reshape), total recorded assistant usage is **$0.09516147**. Each earlier state was rerun only after relevant implementation changes. This excludes the earlier prototype's separate $0.80 spend. No model-based summarizer is used.

Not proven here: large-context handoff quality, production-scale pending-work completeness, TUI idle recovery, the production wrapper in a real terminal, Node 22/24, or actual trusted publication. Child sessions cannot independently relaunch through the inherited parent wrapper, and marker+SIGTERM does not imply a zero exit. Those limitations are explicit in README.md and L0-INTEGRATION.md. The package is ready for parent review, **not an assertion that publication gates/rollout trials have passed**.
