# Parent-applied staging, installation and release steps

These are instructions, **not actions taken by the builder**. No live agent directory or external checkout has been changed. The parent owns repository creation, review, npm trusted-publisher setup and publication. Public installation/use is in README.md; deployment-specific coordinator changes remain in L0-INTEGRATION.md, which is not shipped in npm.

## Verify the staging checkout

From this checkout's root (`P` is this directory, not a system installation):

```sh
P="$PWD"
export npm_config_cache="$P/.ai-work/npm-cache"
npm ci --legacy-peer-deps --ignore-scripts
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
npm run typecheck
npm test
npm run check:shell
npm pack --dry-run
git diff --check
```

Run each check separately and stop on failure. Tests resolve local peers or standard user runtime locations; `PI_RUNTIME_DIR` optionally selects the installed pi package root. For this staging build, bounded phases use `python3 -B scripts/phase.py run --kind build|test|integration --label NAME --timeout SECONDS --queue-timeout 10 -- COMMAND`. That adapter imports pi-phase read-only and injects its state path below this checkout's `.ai-work/`; it does not write into the live runner state directory and therefore does not participate in shared scheduling.

## Install observe first (new sessions)

Determine the actual agent root using the same API as the package, and preserve rollback inputs:

```sh
AGENT_DIR="$(node --input-type=module -e 'import {getAgentDir} from "@earendil-works/pi-coding-agent"; process.stdout.write(getAgentDir())')"
export AGENT_DIR
B="$P/.ai-work/install-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B/agents"
for f in settings.json context-budget.json; do
  test ! -e "$AGENT_DIR/$f" || cp -p "$AGENT_DIR/$f" "$B/$f"
done
test ! -f "$AGENT_DIR/lib/guards.ts" || cp -p "$AGENT_DIR/lib/guards.ts" "$B/guards.ts"
# Copy only existing files; absent directories do not require creation.
if test -d "$AGENT_DIR/agents"; then
  for f in "$AGENT_DIR/agents/"*.md; do test ! -f "$f" || cp -p "$f" "$B/agents/"; done
fi
printf 'Rollback inputs: %s\n' "$B"

# Before publication: local package; after publication use the public npm source instead.
pi install "$P"
# pi install npm:@woksin/pi-context-budget
python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['AGENT_DIR']) / 'context-budget.json'
p.write_text(json.dumps({'mode': 'observe'}, indent=2) + '\n')
p.chmod(0o600)
PY
```

Local package configuration points at this checkout; do not move it while installed. Do not also install a direct extension copy: that would load two instances. New sessions load observe mode; already-running sessions are not injected or restarted. Do not reload busy sessions to add the package.

### Alternative: exact direct-copy installation

For a setup that deliberately does not use pi packages, **instead of** `pi install`:

```sh
test ! -e "$AGENT_DIR/extensions/context-budget"
mkdir -p "$AGENT_DIR/extensions/context-budget"
install -m 600 "$P/src/extension.ts" "$AGENT_DIR/extensions/context-budget/index.ts"
install -m 600 "$P/src/core.ts" "$AGENT_DIR/extensions/context-budget/core.ts"
install -m 600 "$P/src/storage.ts" "$AGENT_DIR/extensions/context-budget/storage.ts"
```

This directory's allowlist name is `context-budget`; the packaged extension's name is `pi-context-budget`. All defaults still come from `getAgentDir()`.

## Optional shared guard integration

The package does not require a shared guard extension. Where one already exists with `GUARD_NAMES`, `isGuardOff` and a `/guards` command, this exact parent-applied script adds the name without disabling any guard or touching other extensions:

```sh
python3 - <<'PY'
import os, re
from pathlib import Path
p = Path(os.environ['AGENT_DIR']) / 'lib/guards.ts'
s = p.read_text()
m = re.search(r'export const GUARD_NAMES = \[([^\n]*)\] as const;', s)
assert m, 'Inspect changed guard source before patching'
if '"context"' not in m.group(1):
    s = s[:m.start(1)] + m.group(1) + ', "context"' + s[m.end(1):]
    error = re.search(r'Expected ([^`\n]+) or all\.', s)
    assert error, 'Inspect changed guard error message before patching'
    s = s[:error.start(1)] + error.group(1) + ', context' + s[error.end(1):]
p.write_text(s)
PY
```

This is the only shared-library change contemplated here. No provider-fallback, wait-guard or issue-work code changes. A missing/unpatched guard module does not silently disable enforcement. In the integrated setup, `/guards off context` is the user's session override; `/guards on context` restores it; `off all` includes context. Otherwise the user/operator controls config mode directly.

## Explicit subagent allowlists

In the staging setup, these existing agent files have an `extensions:` allowlist and need the package short name added:

```text
Explore.md  Plan.md  careful-implementer.md  cleanup-steward.md
content-writer.md  cratis-cli.md  doc-writer.md  general-purpose.md
grunt.md  implementer.md  ops.md  opus-implementer.md  prose-editor.md
reviewer.md  scout.md  second-opinion.md  sol-reviewer.md
```

These are deployment-specific filenames, **not package defaults**. For the npm/local-package method use `ALLOW_NAME=pi-context-budget`; for direct-copy use `ALLOW_NAME=context-budget`. Validate all files before writing any:

```sh
export ALLOW_NAME=pi-context-budget
python3 - <<'PY'
import os, re
from pathlib import Path
root = Path(os.environ['AGENT_DIR']) / 'agents'
names = '''Explore Plan careful-implementer cleanup-steward content-writer cratis-cli doc-writer general-purpose grunt implementer ops opus-implementer prose-editor reviewer scout second-opinion sol-reviewer'''.split()
updates = []
for name in names:
    p = root / f'{name}.md'
    s = p.read_text()
    matches = list(re.finditer(r'^extensions: \[([^\n]*)\]$', s, re.M))
    assert len(matches) == 1, f'Inspect changed frontmatter: {p}'
    m = matches[0]
    items = [x.strip() for x in m.group(1).split(',') if x.strip()]
    if os.environ['ALLOW_NAME'] not in items:
        items.append(os.environ['ALLOW_NAME'])
        updates.append((p, s[:m.start()] + 'extensions: [' + ', '.join(items) + ']' + s[m.end():]))
for p, s in updates:
    p.write_text(s)
PY
```

Agents without an extensions field or with `extensions: true` inherit globally installed extensions. Inspect new/project agent allowlists separately; do not rewrite unrelated definitions or tool lists blindly.

## Wrapper install and alias

```sh
mkdir -p "$HOME/.local/bin"
test ! -e "$HOME/.local/bin/pi-session" || cp -p "$HOME/.local/bin/pi-session" "$B/pi-session"
install -m 755 "$P/bin/pi-session" "$HOME/.local/bin/pi-session"
export PI_SESSION_PI="$(command -v pi)"
alias pi="$HOME/.local/bin/pi-session"
```

The alias applies only to this shell; adding it to shell configuration is an explicit parent choice. Markers default to the configured agent root's `relaunch/<childpid>-<launch-nonce>.json`; the wrapper honors `PI_CODING_AGENT_DIR` and `PI_SESSION_MARKER_DIR`. Already-running sessions without the wrapper will never be shut down by this package.

## Enable the overflow backstop last

**Do not change global compaction settings while live processes lack this package's hook.** Wait for those processes to exit, or scope the settings to newly launched isolated trials. Otherwise pi's default uncached summarizer could run without interception.

After confirming instrumentation, use actual model/window values, not assumed 1M defaults:

```sh
: "${MODEL_REF:?set provider/model-id}"
: "${MODEL_WINDOW:?set verified context window tokens}"
: "${MODEL_HARD:?set configured main hard tokens}"
export MODEL_REF MODEL_WINDOW MODEL_HARD
python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['AGENT_DIR']) / 'settings.json'
s = json.loads(p.read_text()) if p.exists() else {}
reserve = int(os.environ['MODEL_WINDOW']) - (int(os.environ['MODEL_HARD']) + 20000)
assert reserve > 0, 'Lower thresholds or choose an adequate model window'
c = s.setdefault('compaction', {})
c.update(enabled=True, keepRecentTokens=20000)
c.setdefault('modelOverrides', {}).setdefault(os.environ['MODEL_REF'], {}).update(reserveTokens=reserve, keepRecentTokens=20000)
p.write_text(json.dumps(s, indent=2) + '\n')
PY
```

For a verified 1M window and 600k hard, reserve=380k and threshold=620k. Per-model pi settings cannot express distinct main/child reserves. Children can recover hard limits through a fresh in-process handoff; cap/loop recovery needs parent intervention if no owned wrapper exists. Observe/off and guard-off leave all native compaction untouched, including `/compact`, default summaries and overflow recovery; only enforce supplies the handoff/mechanical backstop. Scope compaction settings to enforced trials if native summarizer cost is not wanted in observe sessions.

## Trial and rollback

Activate only explicitly selected absolute cwd prefixes, leaving everyone else observe:

```sh
: "${TRIAL_CWD:?set an approved absolute directory}"
export TRIAL_CWD
python3 - <<'PY'
import json, os
from pathlib import Path
cwd = os.environ['TRIAL_CWD']
assert Path(cwd).is_absolute()
p = Path(os.environ['AGENT_DIR']) / 'context-budget.json'
s = json.loads(p.read_text())
s.update(mode='enforce', enforceCwds=[cwd])
p.write_text(json.dumps(s, indent=2) + '\n')
PY
```

Require useful large-context handoffs, progress between compactions, preserved background completion and one real TUI idle cycle before wider enforcement. `L0-INTEGRATION.md` documents deployment-specific changes and the SIGTERM/zero-exit contract limitation.

Rollback order:
1. Set config to observe/off (next input reloads it), or have the user invoke the integrated `/guards off context` immediately. No agent should toggle guards for the user.
2. Restore the saved pi compaction settings **before** removing interception.
3. Remove the local/npm package with `pi remove <the-exact-installed-source>`, or remove only the three files from the direct-copy alternative after processes stop using them; remove its directory only if empty. Never blanket-delete an extensions directory.
4. Restore only the backed-up guard/agent definitions you changed, and an existing wrapper if one was saved. Remove an added alias deliberately; do not force busy sessions to reload.
5. Retain handoffs, telemetry and markers as recovery evidence; do not blanket-delete `.ai-work/` or agent state.

Use the exact `B` saved above, not a wildcard. Example restoration commands for existing backups:

```sh
: "${B:?set reviewed rollback backup directory}"
for f in settings.json context-budget.json; do test ! -f "$B/$f" || cp -p "$B/$f" "$AGENT_DIR/$f"; done
test ! -f "$B/guards.ts" || cp -p "$B/guards.ts" "$AGENT_DIR/lib/guards.ts"
for f in "$B/agents/"*.md; do test ! -f "$f" || cp -p "$f" "$AGENT_DIR/agents/$(basename "$f")"; done
test ! -f "$B/pi-session" || cp -p "$B/pi-session" "$HOME/.local/bin/pi-session"
unalias pi 2>/dev/null || true
```

## Public release (parent only, after review)

The target is `github.com/woksin/pi-context-budget`, package `@woksin/pi-context-budget`, MIT. The builder does **not** create the repository, push, create a release or publish. Before the parent publishes: configure npm trusted publishing for that repository's `.github/workflows/publish.yml` and `npm` environment, verify the exact tarball allowlist, and confirm CI Node 22/24 is green. Publishing a GitHub release tagged `v<package version>` triggers CI then `npm publish --provenance --access public`; ordinary pushes do not publish. No npm token fallback is configured.
