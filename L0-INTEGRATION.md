# L0 integration — parent-applied plan

Nothing in this document has been applied to `/Volumes/sourcecode/`. The initial rollout remains observe with existing lanes running. Apply L0 behavior changes only after the selected lanes are launched through `pi-session` and status confirms the intended effective mode.

## Remove context restart traffic

For instrumented enforced lanes, remove the context-size `RESTART <wt> <prompt> <handoff>` rule and L0 context nudges. The lane calls `context_handoff`; `turn_end` commits retain-none compaction and automatically continues **without changing sessionId, PID or terminal**. Do not nudge the lane to stop after its handoff. Keep unrelated pause/scope/CI messages unchanged.

`process-restarts.sh` must stop treating context `RESTART` lines as work. Do not silently discard unprocessed crash/hang requests: migrate those explicitly to the crash-recovery path below. Existing lanes without instrumentation keep their old lifecycle until deliberately migrated. Never kill/restart a lane merely because an observe event says it *would* hand off.

## Read status instead of lane-context.sh

Read `~/.pi/agent/context-budget/status/*.json` directly. For example:

```sh
python3 - <<'PY'
from pathlib import Path
import json
for path in sorted((Path.home() / '.pi/agent/context-budget/status').glob('*.json')):
    try:
        s = json.loads(path.read_text())
        print(json.dumps({k: s.get(k) for k in ('at', 'pid', 'sessionId', 'cwd', 'role', 'model', 'mode', 'tokens', 'thresholds', 'floor', 'handoffCount', 'lastHandoffPath', 'fallbackReason', 'wrapper')}))
    except (OSError, ValueError):
        pass
PY
```

Join by exact cwd/sessionId, not display labels or parsed terminal titles. A null token measurement immediately after compaction is expected; wait for the next completed assistant usage before evaluating progress. Status files are retained after exit: check PID and session-file identity/mtime before treating one as live. A stale file or an old/dead PID alone does **not** authorize killing another process, cleaning up work or closing an issue.

Observe events are measurements, not instructions. Useful alerts: repeated blocked tools, `relaunch_unavailable`, `hook_error`, `config_error`, `backstop_error`, cap/loop fallback, missing fresh status for a known-live lane. A main/child floor persistently above handoff indicates a misconfigured budget, not a reason to lower thresholds further.

Watch the existing session JSONL (append entries), not `session_compact` notifications: draft compactions at `turn_end` emit no `session_compact`. Match:

```json
{"type":"compaction","details":{"kind":"handoff","path":"/absolute/repo/.ai-work/handoffs/<sessionId>-<n>.md","n":1}}
```

Pi serializes the null retain-none id as the compaction entry's own id. `events.jsonl` records `handoff_committed` and the matching path/n; `handoff_written` alone may be idle-only or later invalidated. The commit event is emitted immediately before returning the draft; the actual session entry remains the authority if a boundary later fails.

`main-session.py` can keep tracking the same file across in-process handoffs. On a wrapper relaunch a new sessionId/file appears; associate it by cwd plus its startup status, not the previous file's size. No periodic lane-context shell command or model nudge is needed for tokens.

## Crash/hang recovery: marker + SIGTERM, no terminal automation

Retain restart-lane.sh's current safety gates: exact worktree/prompt/handoff validation, at most one matching pi PID, no recent session writes, and no busy build/test/git/other children. Also require **fresh status with `wrapper: true`**, matching session file and owned relaunch marker. A context event alone is never a crash diagnosis. Have L0 obtain operator approval for crash termination under its existing lane rules.

After those gates, replace the old osascript/new-window section and sleep/poll loops with this small parent-applied tail (arguments: reviewed status JSON, absolute launch prompt, absolute handoff):

```sh
python3 - "$STATUS_FILE" "$PROMPT" "$HANDOFF" <<'PY'
import json, os, signal, sys
from pathlib import Path
status, prompt, handoff = map(Path, sys.argv[1:])
s = json.loads(status.read_text())
assert s.get('wrapper') is True and s.get('role') == 'main', 'Not a wrapper-owned main session'
pid = s['pid']
assert isinstance(pid, int) and pid > 1 and pid != os.getpid()
marker = Path(s['relaunchMarker'])
assert marker.is_absolute() and marker.name.startswith(f'{pid}-') and marker.suffix == '.json'
assert len(marker.stem.split('-', 1)[1]) == 32  # exact marker comes from fresh wrapper-owned status
assert prompt.is_absolute() and prompt.is_file()
assert handoff.is_absolute() and handoff.is_file()
cwd = Path(s['cwd'])
assert cwd.is_absolute() and cwd.is_dir()
session = Path(s['sessionFile'])
assert session.is_absolute() and session.is_file()
header = json.loads(session.open().readline())
assert header.get('id') == s['sessionId'] and header.get('cwd') == str(cwd), 'Wrong session identity'
os.kill(pid, 0)  # Liveness only; outer checks must also verify process identity/start time.
# Refuse to replace an extension-written or earlier recovery marker.
marker.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(dict(cwd=str(cwd), launchPrompt=str(prompt), handoff=str(handoff), sessionFile=str(session)), f)
    f.write('\n')
os.kill(pid, signal.SIGTERM)
print(f'Marker stored at {marker}; SIGTERM sent to verified lane pid {pid}. Inspect the wrapper exit outcome; no polling.')
PY
```

**Contract limitation that must not be hidden:** the required wrapper relaunches only on **exit 0** plus marker, never on provider errors or generic non-zero exits. A SIGTERM commonly exits 143; in that case the wrapper intentionally **does not relaunch**, retains the marker and reports the exit code. No real SIGTERM→zero-exit guarantee was established by the spikes or these tests. Thus marker+SIGTERM is a safe termination/recovery-evidence step, **not guaranteed automatic crash recovery** under the present specification. Do not weaken the exit-code guard implicitly. Automatic signal-authorized recovery would need a separately approved contract change (and tests).

For a stopped lane whose wrapper has exited non-zero, inspect the retained marker and use this deliberate same-terminal recovery command after confirming no old process remains:

```sh
# Read these absolute paths from the retained marker; do not eval JSON or infer them by whitespace.
cd "$CWD_FROM_MARKER"
"$HOME/.local/bin/pi-session" "@$LAUNCH_PROMPT_FROM_MARKER" "continue from $HANDOFF_FROM_MARKER"
```

Restore any lane-specific CLI/environment settings from the original reviewed launch configuration. When `launchPrompt` is null, omit that `@` argument. Keep the old marker until the operator confirms the recovery succeeded. No osascript, Terminal focus stealing, repeated kill/sleep checks or guessed PID is part of the normal path.

## Child sessions and pending work

In-process handoffs preserve children/jobs/watches and issue_work session claims. Relaunch does not: shutdown kills in-flight work and creates a new sessionId. The successor must inspect jobs/CI/PR/issue state and re-establish claims rather than trusting stale handoff claims or auto-retrying a still-running external action.

Current pi-subagents binds children without a shutdown action. They inherit the root process environment, but are **not** independent wrapper processes. This extension refuses to write the root marker for a child. A child's valid hard-limit handoff now commits in-process. For exhausted loop/cap or unrecoverable compaction failure, L0/parent receives `relaunch_unavailable`; stop/replace that child using the parent integration after saving/reviewing its handoff. Do not kill the main lane PID on behalf of a child. Registry enumeration limitations are recorded in each handoff (README.md).

## Trial acceptance

Choose one or two approved lanes, start new wrapper-owned sessions, enforce only those exact cwd prefixes, and retain observe elsewhere. Require: real-scale useful handoffs, progress between commits, no loops, no lost background completion/claims, correct idle reset, correct L0 matching and acceptable spend. Verify one idle reset in actual TUI mode before broader enforcement. These are rollout gates, not claims made by the small print-mode E2E runs.
