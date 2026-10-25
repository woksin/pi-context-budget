# pi-context-budget

Structured context handoffs for pi: keep working in the same session and process while a large conversation is replaced by a concise, verified-state handoff.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/@woksin/pi-context-budget.svg)](https://www.npmjs.com/package/@woksin/pi-context-budget) [![CI](https://img.shields.io/github/actions/workflow/status/woksin/pi-context-budget/ci.yml?label=CI)](https://github.com/woksin/pi-context-budget/actions/workflows/ci.yml)

Jobs, subagents and session-scoped integrations stay alive. A `pi-session` wrapper provides a fresh-process fallback when in-process recovery is no longer safe.

**Observe by default.** Installing the package does not block tools, compact history or restart sessions until you explicitly enable enforcement.

## Features

- A `context_handoff` tool that separates verified facts, hypotheses and user constraints, with git HEAD collected independently.
- Observe mode by default, with opt-in enforcement.
- Idle reset and an overflow backstop.
- Optional resume checks.
- A `pi-session` wrapper that relaunches in a fresh process when needed.
- Config in `context-budget.json` (or `PI_CONTEXT_BUDGET_CONFIG`).

## Why

Per-turn input cost grows with accumulated context, including cached reads. After a cache expires, rewriting a large context can be substantially more expensive. Long histories can also bury constraints, stale verification results and the next action.

Small synthetic experiments demonstrated automatic continuation across retain-none handoffs, preservation of the cached system/tool prefix, and completion of a sequential state-recall task. The production checks include enforced handoffs, observe-mode no-ops and wrapper relaunch. These are mechanism checks, **not production-scale quality or savings guarantees**. Handoff quality matters: verified facts, hypotheses and user constraints are deliberately separated, with git HEAD collected independently.

## Install

```sh
pi install npm:@woksin/pi-context-budget
```

Or add the package to your pi settings:

```json
{
  "packages": ["npm:@woksin/pi-context-budget"]
}
```

Git/local sources also work:

```sh
pi install git:github.com/woksin/pi-context-budget
pi install /path/to/pi-context-budget
```

Restart pi or use `/reload` **when safe for your other extensions**. Installing does not inject code into already-running sessions. Do not reload busy sessions just to add this package.

Requires Node.js **22.19+**, Bash and a POSIX system; Windows is not supported. Developed against pi **1.2.0**. The host peer uses `"*"` as recommended for pi packages; this is not a compatibility guarantee for every pi version. Pi supplies its own runtime; the package bundles none of it.

Subagent integrations with explicit extension allowlists must include **`pi-context-budget`** (the package short name), and expose the `context_handoff` tool. A parent-only `-e` option is not necessarily inherited by children. Load this package in the primary session **before** starting SDK children. A process-local hosting marker identifies the primary runtime and its concurrently bound SDK children; it is released at primary shutdown so forked/resumed main sessions remain main. Ancestry (`parentSession`) and UI availability are not child signals. Child-only loading without an instrumented primary is unsupported.

## Configure

The configuration path is **`getAgentDir()/context-budget.json`**, or `PI_CONTEXT_BUDGET_CONFIG`. Pi's `PI_CODING_AGENT_DIR` override is respected. Missing or invalid configuration selects safe observe mode; errors are logged. Configuration reloads at startup and each input.

```json
{
  "mode": "observe",
  "resumeChecks": {},
  "overflowRecovery": true,
  "main": { "soft": 300000, "handoff": 400000, "hard": 600000, "minProgress": 50000 },
  "subagent": { "soft": 150000, "handoff": 200000, "hard": 300000, "minProgress": 25000 },
  "models": {
    "provider/model-id": { "main": { "soft": 80000, "handoff": 100000, "hard": 150000, "minProgress": 15000 } }
  },
  "idleMinutes": 50,
  "idleMinTokens": 300000,
  "keepRecentTokens": 20000,
  "maxHandoffsPerSession": 10,
  "loop": { "maxHandoffsWithoutProgress": 2, "withinTurns": 8 }
}
```

| Field | Meaning |
|---|---|
| `mode` | `off`, `observe` (default), or `enforce` |
| `overflowRecovery` | Recover actual provider context overflow with one compact-and-retry; default `true`. Explicit `mode: "off"` disables it, but observe and shared guard-off still recover. Set `false` to opt out. |
| `resumeChecks` | Optional map of exact session names to trusted shell commands; default `{}` (disabled). `PI_RESUME_CHECK` takes precedence. |
| `enforceCwds` | Optional array of absolute directory prefixes/globs. Outside it, enforce becomes observe. Empty array enforces nowhere. |
| `main`, `subagent` | Soft/handoff/hard thresholds and minimum growth above the measured context floor |
| `models` | Exact `provider/model-id` overrides, merged separately into main/subagent thresholds |
| `idleMinutes`, `idleMinTokens` | Minimum idle duration and settle-time context size for pending-work idle recovery |
| `keepRecentTokens` | Eligibility guard for idle compaction; align with pi's compaction setting |
| `maxHandoffsPerSession` | Allow this many budget/hard commits, excluding idle commits, then fall back before another |
| `loop.maxHandoffsWithoutProgress`, `withinTurns` | Fall back after **more than** this many budget/hard commits in this many turns without a successful non-handoff tool; idle commits are excluded |

All numbers must be positive and finite; count limits must be integers; require soft <= handoff <= hard. Prefixes match directory boundaries, not adjacent names. Globs use Node `path.matchesGlob` (`*`, `**`, `?`, braces/classes); paths must be absolute, without implicit tilde expansion. Use consistent cwd paths rather than symlink aliases.

**Choose thresholds for your actual model window.** The defaults target large-window models; smaller windows need lower per-model overrides. Keep thresholds comfortably above the system/tool bootstrap size, leaving room for output and handoff generation.

### Modes and optional guard integration

- **off:** telemetry only; no enforcement or automatic action.
- **observe:** telemetry and `would_*` threshold events; the handoff tool is a no-op. No threshold-driven blocks, forced continuations, compactions or relaunches. Actual provider overflow recovery is the separate exception described below.
- **enforce:** the policy below, restricted by `enforceCwds` when supplied.

Observe runs the **same enforce transition on a separate copy**, then converts every effect 1:1 to a `would_*` log. Soft notices, action crossings, handoff/settle/block decisions, hard recovery and idle decisions use the same latches as enforcement. Status `phase`/`action` describe that preview (`projected: true`), not actual activity; measured tokens and handoff counts remain actual. Preview-only commits and latches are discarded when enforcement is activated.

The package optionally reads `getAgentDir()/lib/guards.ts` if your setup provides a shared `isGuardOff(name)` API and a `context` guard. In that integration, `/guards off context` disables enforcement for the session. The package does not install or modify another extension's guard library. Without that integration, change the configuration to `off` or `observe` and submit the next input. Only the user/operator should disable enforcement, never a model following a chat instruction.

**Native pi compaction takes precedence**: off/observe and guard-off pass manual, threshold and native overflow compaction through unchanged. With `overflowRecovery: true` (default), an actual provider overflow without native recovery triggers one compact-and-retry in observe, enforce and shared guard-off; explicit `mode: "off"` disables this. A failed native summarizer in observe/guard-off gets at most one bounded mechanical compaction fallback. Repeated overflow after the retry emits `overflow_recovery_exhausted` and asks you to reduce context or switch models. Only external user input or a successful assistant turn re-arms recovery; aborts, new input, session changes and shutdown invalidate stale callbacks.

Shared guard-off also emits log-only `guard_off_threshold` warnings once per handoff/hard crossing, re-armed below each threshold. They never enable the guard or notify the user; explicit off stays silent.

Configured/effective mode differences are shown in the footer, for example
`context-budget: configured enforce, effective off (context guard off)`, and logged once per mismatch transition. Cwd restrictions report `cwd restriction`. Configuration and policy state are local to each runtime binding: starting an SDK child does not change its parent's mode. There is no package-specific per-session mode override; the optional guard integration is consulted live.

## Handoff policy

1. **Soft:** one UI advisory per crossing: finish the current step first, then hand off at a natural boundary. No model steer or extra provider call.
2. **Handoff:** block every tool except `context_handoff` when `tokens >= handoff` **and** `tokens - floor >= minProgress`. The floor is the first assistant usage after bootstrap/compaction; an unknown floor never triggers handoff blocking. Null usage after compaction means fresh context.
3. **Commit:** the handoff tool writes a unique structured summary; the same `turn_end` commits a retain-none compaction and requests automatic continuation. No process/session-id change. A sibling tool that actually finishes after the handoff invalidates it; a blocked sibling does not.
4. **Settle:** one continuation asks for a handoff if the agent tries to stop while handoff is required. Internal `agent_start` events do not reset this bound or an idle handoff request; only a genuinely new `before_agent_start` resets external-run state.
5. **Fallback:** hard limit **without a usable handoff**, cap, loop guard or classified persistent/exhausted compaction failure arms recovery. Non-handoff tools remain blocked, even with a wrapper, with accurate end-turn instructions. A valid handoff at hard commits in-process with or without a wrapper; it cannot bypass the cap/loop guards. With an owned wrapper, write the marker and request shutdown only at `agent_settled`; without one, never shut down.

### `context_handoff`

Only three fields are required:

```json
{
  "goal": "The task and original request, verbatim where it matters",
  "next_step": "The exact next action",
  "facts": "Verified HEAD/review SHAs, CI run ids, issue/PR states and completed work",
  "user_constraints": "User constraints verbatim",
  "hypotheses": "Unverified explanations, explicitly not facts",
  "files_to_read": ["/absolute/path/to/task-notes.md"]
}
```

Optional: `decisions` (and why), `user_constraints`, `open_items`, `hypotheses`, `files_to_read`, `launch_prompt` (absolute prompt-file path for relaunch).

Automatic metadata: timestamp, cwd/repository root, git branch/HEAD, pending jobs/watches/subagents, and this session's issue claims when the corresponding integrations are present. Agent-written facts remain claims until rechecked; automatic git state is recorded separately.

**Sensitive data:** full job commands, including any inline tokens or credentials, appear in the handoff. Avoid putting secrets in commands and treat handoff files as sensitive.

Files: `<repo-root or cwd>/.ai-work/handoffs/<sessionId>-<n>.md` plus JSON sidecar. Markdown is capped at **49,152 UTF-8 bytes (48 KiB)**. The split reserves the previous **12 KiB for narrative**, with **16 KiB for jobs/watches**, **4 KiB for subagents**, **4 KiB for resume-check output**, **768 bytes for claims** (plus an omission marker), and the remaining headroom for bounded metadata, headings and paths. Unbounded job or claim volume cannot consume the narrative allowance; user constraints are never truncated. Jobs render as `id | label | kind | until | intervalSeconds | full command | cwd | logPath`; genuinely absent fields are `-`. Commands stay intact unless their whole line exceeds 600 characters, then that line ends with `…(cut, N chars)` (N is the original line length). The job budget fits about 20 such lines; further records have an explicit omission count. Oversize is a clear tool error, never silent truncation. Each summary has a unique heading; retain-none compaction replaces previous summaries instead of stacking them. Read the handoff, verify HEAD and external state, then continue from Next step without asking the user to restate the task.

### Idle reset

At the last actionable settle boundary, if context is large **and work remains pending** (jobs, watches or subagents), request a warm-cache handoff. Writing it marks it pending: non-handoff tools are blocked until the same `turn_end` commits retain-none compaction and automatically continues in the same session. This uses the existing `handoff_committed` event tagged with `source: "idle"` and does not wait for `idleMinutes`; notifications or new runs after that boundary see the reset context. Idle commits do not consume `maxHandoffsPerSession` or loop limits, including after session restoration; budget and hard commits still count as before. No further idle handoff is requested while a handoff is pending or a stored snapshot remains valid. The idle-input recovery path still awaits compaction before sending a new prompt after `idleMinutes` when a valid stored handoff and eligible history remain. Skip small/already-compacted history; tolerate pi's `Nothing to compact` error and pass the prompt through unchanged. Actual non-handoff tool activity and externally started runs invalidate old stored handoffs; blocked calls cannot make a snapshot stale. Cancellation, `Nothing to compact` and `Already compacted` are benign in both the hook and callback paths. Transient failures retry only at the next eligible input/automatic compaction boundary, at most twice; a third failure or a persistent owned/automatic error arms fallback. Unowned manual errors are ignored. Successful compaction or a mode/guard change disarms compaction-failure fallback. An idle preview without a prepared handoff is marked `requiresHandoff: true`; this records the missing prerequisite, not an actual compaction request.

### Overflow backstop

In enforce mode the package supplies a still-valid handoff, or a short, bounded mechanical summary of recent user requests plus instructions to re-establish state from files/git. The emergency summary needs neither writable handoff storage nor automatic metadata. **Enforce mode never delegates to pi's default summarizer**; backstop errors cancel rather than fall through. Inactive modes leave native behavior alone except for the bounded provider overflow recovery described above.

To restore automatic overflow recovery, enable pi compaction and choose model-specific reserves. Example for a **1,000,000-token window** with main hard limit 600,000:

```json
{
  "compaction": {
    "enabled": true,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "provider/model-id": { "reserveTokens": 380000, "keepRecentTokens": 20000 }
    }
  }
}
```

This triggers above 620,000 (`window - reserveTokens`). Use your actual model id/window and choose `reserveTokens = window - (hard + safetyMargin)`, with positive reserve and adequate output space. Per-model pi settings cannot express distinct main/child reserves. **Do not enable automatic compaction in uninstrumented live processes**; they could invoke the default summarizer before this hook exists.

### Optional resume checks

Set a trusted operator command with `PI_RESUME_CHECK='bash /absolute/path/resume-check.sh'`, or configure exact session names in `context-budget.json`:

```json
{ "resumeChecks": { "coordinator": "bash /absolute/path/resume-check.sh" } }
```

The nonempty env value wins, then the current Pi session name is looked up in the map. With neither source, this is completely off. In enforce mode only (respecting cwd restrictions and guard-off, and skipping subagent sessions), `bash -c` runs in the session cwd immediately before a handoff is written, under `## Resume check`, and again after a committed handoff context reset, before the first resumed provider call. Fresh results are injected into that call's context and retained there for subsequent calls until the next reset; the command runs once per boundary, not once per tool. The command inherits the process environment; the extension never sets identity variables globally. Only configure commands you trust (prefer read-only checks).

Combined stdout/stderr is capped so the result, command label and exit status fit within 4 KiB. Nonzero exit, spawn error, truncation and timeout are visible, never a reason to abort the handoff/reset. A **30-second timeout kills the process group**, then allows at most one second for output to drain before closing the pipes and returning a timed-out result. Direct child exit also starts a one-second drain limit, so inherited pipes cannot hang the check. Escaped descendants may outlive the check; commands should not daemonize/escape that group. These observations complement, not replace, verification of external state.


## `pi-session` wrapper

The npm package includes a `pi-session` binary. A pi-managed npm install normally places package binaries under `<agentDir>/npm/node_modules/.bin`; add that directory to PATH or invoke its binary explicitly. Alternatively install the wrapper on your normal npm PATH:

```sh
npm install -g --omit=peer @woksin/pi-context-budget
pi-session --model provider/model-id -- @/absolute/launch.md "initial request"
```

The extension must also be loaded in pi (via the pi package installation above). An alias is optional; preserve the real pi executable to avoid recursion:

```sh
export PI_SESSION_PI="$(command -v pi)"
alias pi=pi-session
```

Initial arguments are preserved (the wrapper's `--` separator is removed). After **exit 0 + a valid marker**, start a fresh session in the same cwd/terminal with ordinary CLI options, optional `@<launchPrompt>` and `continue from <handoff>`. Old messages and resume/session selectors are not replayed. No `eval` or terminal automation. This continuation path targets terminal/print sessions; RPC clients must manage protocol-driven reconnection themselves (pi RPC rejects `@file` arguments).

| Environment | Purpose |
|---|---|
| `PI_SESSION_PI` | Real pi executable, default `pi` |
| `PI_SESSION_MARKER_DIR` | Marker directory; default `<PI_CODING_AGENT_DIR or standard agent dir>/relaunch` |
| `PI_SESSION_MAX_RELAUNCHES_PER_HOUR` | Rolling-hour limit per wrapper invocation, default 5 |
| `PI_RELAUNCH_MARKER`, `PI_SESSION_WRAPPER`, `PI_SESSION_WRAPPER_PID`, `PI_SESSION_LAUNCH_ID` | Set by wrapper; ownership requires the current PID, exact nonce-bearing marker filename and the primary hosting identity. Do not forge these. |

Markers are `<pid>-<random-launch-nonce>.json` with `cwd`, nullable `launchPrompt`, `handoff`, nullable `sessionFile`. Descendant processes inherit the environment but fail the PID check; in-process SDK children fail the hosting check. Fresh nonces prevent retained markers from being mistaken for a later launch after PID reuse. Invalid markers, provider/non-zero exits or limit exhaustion stop without relaunch and retain evidence. Custom value-taking extension options should use `--flag=value`; built-in value-taking flags are parsed explicitly.

**SIGTERM is not an automatic recovery authorization.** A signal exit is commonly 143; the zero-exit contract intentionally refuses to relaunch it. Deliberate crash recovery requires inspecting the marker and starting a new wrapper after verifying the old process is gone. Relaunch tears down jobs/subagents and changes session-id claims.

### Duplicate back-off and optional state integrations

A new handoff is refused with a tool error and `retry after <time>` for 15 minutes after the previous handoff when repository HEAD is unchanged and narrative similarity is **> 0.9**. Similarity is token-set Jaccard (intersection/union) over lowercase Unicode words in `goal + facts + next_step`, ignoring word order and punctuation. Changed HEAD, sufficiently changed narrative or expiry permits another handoff. Unknown HEAD cannot establish unchanged state. Forced handoffs (handoff threshold or any fallback, including hard limit and compaction failure) always bypass this check; back-off applies only to voluntary/idle handoffs. The comparison metadata persists in tool results and survives session restoration.

Queued notifications and follow-ups never postpone a pending handoff's turn-boundary reset; Pi retains and delivers its queue after the reset.

Optional **pi-questions** integration reads `$PI_QUESTIONS_HOME` or `<agent dir>/user-questions`, without writing anything. Only the newest 200 item directories by modification time are scanned. The latest item revision contributes `Pending questions` lines for this session's open items only: `id | status | title`, at most 20 lines of 200 characters. Missing/unreadable stores and corrupt items are silently omitted.

The first resumed provider call compares recorded jobs/watches with the live **pi-jobs** registry. A `Watch check` block lists missing work as `id | label | full command` so it can be re-armed; no block appears when all recorded work is running or the registry is absent/unreadable. Full commands are retained in handoff metadata even when the display line was shortened. This is an observation, not automatic job execution.

## Telemetry and integration limits

- Atomic status: `getAgentDir()/context-budget/status/<sessionId>.json` (cwd, model, main/child role, tokens, floor, thresholds, last handoff path/time, count, effective/configured mode, policy phase/action, projection flag, fallback and wrapper ownership).
- Append-only events: `getAgentDir()/context-budget/events.jsonl` (crossings, blocks, handoffs, idle/backstop/fallback, `would_*` and errors). `PI_CONTEXT_BUDGET_STATE_DIR` redirects both.
- Status files survive exit: check PID/session identity before assuming liveness. Hook failures log and continue; telemetry write failures must not prevent a handoff commit.
- Read committed session JSONL entries (`type: "compaction"`, `details.kind: "handoff"`) rather than expecting `session_compact` for turn-end drafts. A file write/commit-intent event alone is not proof that pi appended the boundary.
- Optional integrations use the `pi-jobs.liveManagers` and `pi-subagents:manager` Symbol registries, and `<agentDir>/issue-work/registry.jsonl`. Missing data is labelled unavailable. Job managers are process-wide and can include sibling sessions. When `listAgents` is unavailable, the extension discovers ids in this session’s `$TMPDIR/pi-subagents-<uid>/<cwd-slug>/<sessionId>/tasks/*.output` directory and calls the live registry’s `getRecord` for each id, combined with known tool-result ids. Only authoritative running/queued records render, as `id | status | description`; stale files do not resurrect finished work. No transcript content is trusted as status. An inaccessible task directory/registry or pending work with no discoverable ids is labelled unavailable; an empty inventory is not an error. Job managers remain process-wide, while task-directory discovery is session-scoped.
- In-process subagents inherit the root environment but **do not own its wrapper**; current child sessions have no shutdown binding. They never write the parent's marker. Hard-limit handoffs can still recover in-process; loop/cap or unrecoverable fallback requires parent/operator intervention.
- No automatic event-log rotation or handoff deletion. Files may contain sensitive user constraints, paths and task state; keep them private.

## Lifecycle model

`src/core.ts` contains a pure immutable transition function with named idle, soft-notified, handoff-required, handoff-pending-commit, compacting and fallback-armed states. Pi hooks only translate observations and execute its explicit effects. Inactive threshold policy emits telemetry only; the separate, bounded provider overflow recovery layer is the exception in observe/guard-off. Attempt ids deduplicate pi's failure hook followed by `compact`'s `onError`, and success/mode changes clear failure recovery. Table-driven tests cover the transition matrix; offline real-pi tests cover internal continuations, native compaction pass-through, cancellation, no-op failures and SDK hosting.

## Limits and development

Retain-none compaction discards verbatim history. Structured fields reduce omissions but cannot guarantee losslessness; mechanical fallback is weaker still. Real-scale handoff quality, complete pending-work inventory and TUI idle reset require controlled trials. Print-mode checks do not establish every TUI behavior. Small-window budgets must be configured explicitly.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
npm run typecheck
npm test
npm run check:shell
npm pack --dry-run
```

Unit tests use `node:test`, fake extension contexts and a fake pi executable; they make no provider/network calls. Runtime smoke tests resolve a local peer, then pi's standard user installation roots; `PI_RUNTIME_DIR` overrides the package root. If no runtime exists, that smoke test skips clearly (CI requires it). Other tests need no runtime. Typechecking does require the host peer.

CI runs Node 22/24, installs the tested pi runtime, typechecks, tests, checks Bash syntax and inspects the npm tarball. To release, bump `package.json` and lockfile, commit, and publish a GitHub release tagged `v<version>`. The release workflow reruns CI and uses npm trusted publishing with provenance; configure the npm trusted publisher for this repository, `publish.yml` and the `npm` environment. Creating a release is the publication trigger; a normal push is not.

MIT licensed.

## Related projects

- [pi-setup](https://github.com/woksin/pi-setup): my full pi agent setup (rules, agents, extensions, installer) that ties these together
- [pi-jobs](https://github.com/woksin/pi-jobs): background shell jobs and watches that wake the agent when they finish
- [pi-recover](https://github.com/woksin/pi-recover): `/recover` picks up unfinished subagents, workflows and jobs after a crash or usage limit
- [pi-orch](https://github.com/woksin/pi-orch) (experimental): repo-owner orchestration with an order bus and batched candidate PRs

## License

MIT, see [LICENSE](LICENSE).
