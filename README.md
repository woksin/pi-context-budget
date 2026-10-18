# pi-context-budget

Structured context handoffs for [pi](https://github.com/earendil-works/pi): keep working in the **same session and process** while replacing a large conversation with a concise, verified-state handoff. Jobs, subagents and session-scoped integrations stay alive. A `pi-session` wrapper provides fresh-process fallback when in-process recovery is no longer safe.

**Observe by default.** Installing the package does not block tools, compact history or restart sessions until you explicitly enable enforcement.

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
| `enforceCwds` | Optional array of absolute directory prefixes/globs. Outside it, enforce becomes observe. Empty array enforces nowhere. |
| `main`, `subagent` | Soft/handoff/hard thresholds and minimum growth above the measured context floor |
| `models` | Exact `provider/model-id` overrides, merged separately into main/subagent thresholds |
| `idleMinutes`, `idleMinTokens` | Minimum idle duration and settle-time context size for pending-work idle recovery |
| `keepRecentTokens` | Eligibility guard for idle compaction; align with pi's compaction setting |
| `maxHandoffsPerSession` | Allow this many committed handoffs, then fall back before another |
| `loop.maxHandoffsWithoutProgress`, `withinTurns` | Fall back after **more than** this many handoffs in this many turns without a successful non-handoff tool |

All numbers must be positive and finite; count limits must be integers; require soft <= handoff <= hard. Prefixes match directory boundaries, not adjacent names. Globs use Node `path.matchesGlob` (`*`, `**`, `?`, braces/classes); paths must be absolute, without implicit tilde expansion. Use consistent cwd paths rather than symlink aliases.

**Choose thresholds for your actual model window.** The defaults target large-window models; smaller windows need lower per-model overrides. Keep thresholds comfortably above the system/tool bootstrap size, leaving room for output and handoff generation.

### Modes and optional guard integration

- **off:** telemetry only; no enforcement or automatic action.
- **observe:** telemetry and `would_*` events; the handoff tool is a no-op. No blocks, forced continuations, compactions or relaunches.
- **enforce:** the policy below, restricted by `enforceCwds` when supplied.

Observe runs the **same enforce transition on a separate copy**, then converts every effect 1:1 to a `would_*` log. Soft notices, action crossings, handoff/settle/block decisions, hard recovery and idle decisions use the same latches as enforcement. Status `phase`/`action` describe that preview (`projected: true`), not actual activity; measured tokens and handoff counts remain actual. Preview-only commits and latches are discarded when enforcement is activated.

The package optionally reads `getAgentDir()/lib/guards.ts` if your setup provides a shared `isGuardOff(name)` API and a `context` guard. In that integration, `/guards off context` disables enforcement for the session. The package does not install or modify another extension's guard library. Without that integration, change the configuration to `off` or `observe` and submit the next input. Only the user/operator should disable enforcement, never a model following a chat instruction.

**Off/observe and guard-off leave native pi compaction unchanged**: the hook returns no summary and no cancellation for manual, threshold or overflow compaction. The package initiates nothing; pi can still compact using its own configured behavior and summarizer. Only enforce mode intercepts compaction.

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

Files: `<repo-root or cwd>/.ai-work/handoffs/<sessionId>-<n>.md` plus JSON sidecar. Markdown is capped at **12,288 UTF-8 bytes**, including automatic state. Automatic observations have separate fixed budgets with explicit truncation/omission counts, so unbounded job or claim volume cannot consume the whole narrative budget; user constraints are never truncated. Oversize is a clear tool error, never silent truncation. Each summary has a unique heading; retain-none compaction replaces previous summaries instead of stacking them. Read the handoff, verify HEAD and external state, then continue from Next step without asking the user to restate the task.

### Idle reset

At the last actionable settle boundary, if context is large **and work remains pending** (jobs, watches or subagents), request a warm-cache handoff. Writing it marks it pending: non-handoff tools are blocked until the same `turn_end` commits retain-none compaction and automatically continues in the same session. This uses the existing `handoff_committed` event and does not wait for `idleMinutes`; notifications or new runs after that boundary see the reset context. No further idle handoff is requested while a handoff is pending or a stored snapshot remains valid. The idle-input recovery path still awaits compaction before sending a new prompt after `idleMinutes` when a valid stored handoff and eligible history remain. Skip small/already-compacted history; tolerate pi's `Nothing to compact` error and pass the prompt through unchanged. Actual non-handoff tool activity and externally started runs invalidate old stored handoffs; blocked calls cannot make a snapshot stale. Cancellation, `Nothing to compact` and `Already compacted` are benign in both the hook and callback paths. Transient failures retry only at the next eligible input/automatic compaction boundary, at most twice; a third failure or a persistent owned/automatic error arms fallback. Unowned manual errors are ignored. Successful compaction or a mode/guard change disarms compaction-failure fallback. An idle preview without a prepared handoff is marked `requiresHandoff: true`; this records the missing prerequisite, not an actual compaction request.

### Overflow backstop

In enforce mode the package supplies a still-valid handoff, or a short, bounded mechanical summary of recent user requests plus instructions to re-establish state from files/git. The emergency summary needs neither writable handoff storage nor automatic metadata. **Enforce mode never delegates to pi's default summarizer**; backstop errors cancel rather than fall through. Inactive modes leave native behavior alone.

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

## Telemetry and integration limits

- Atomic status: `getAgentDir()/context-budget/status/<sessionId>.json` (cwd, model, main/child role, tokens, floor, thresholds, last handoff path/time, count, effective/configured mode, policy phase/action, projection flag, fallback and wrapper ownership).
- Append-only events: `getAgentDir()/context-budget/events.jsonl` (crossings, blocks, handoffs, idle/backstop/fallback, `would_*` and errors). `PI_CONTEXT_BUDGET_STATE_DIR` redirects both.
- Status files survive exit: check PID/session identity before assuming liveness. Hook failures log and continue; telemetry write failures must not prevent a handoff commit.
- Read committed session JSONL entries (`type: "compaction"`, `details.kind: "handoff"`) rather than expecting `session_compact` for turn-end drafts. A file write/commit-intent event alone is not proof that pi appended the boundary.
- Optional integrations use the `pi-jobs.liveManagers` and `pi-subagents:manager` Symbol registries, and `<agentDir>/issue-work/registry.jsonl`. Missing data is labelled unavailable. Job managers are process-wide and can include sibling sessions. The current subagent registry cannot enumerate: known tool-result ids are captured; unknown running work is explicitly reported.
- In-process subagents inherit the root environment but **do not own its wrapper**; current child sessions have no shutdown binding. They never write the parent's marker. Hard-limit handoffs can still recover in-process; loop/cap or unrecoverable fallback requires parent/operator intervention.
- No automatic event-log rotation or handoff deletion. Files may contain sensitive user constraints, paths and task state; keep them private.

## Lifecycle model

`src/core.ts` contains a pure immutable transition function with named idle, soft-notified, handoff-required, handoff-pending-commit, compacting and fallback-armed states. Pi hooks only translate observations and execute its explicit effects. Inactive modes can emit telemetry only, by construction. Attempt ids deduplicate pi's failure hook followed by `compact`'s `onError`, and success/mode changes clear failure recovery. Table-driven tests cover the transition matrix; offline real-pi tests cover internal continuations, native compaction pass-through, cancellation, no-op failures and SDK hosting.

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
