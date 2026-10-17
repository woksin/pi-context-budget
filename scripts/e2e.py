#!/usr/bin/env python3
"""Bounded real-provider checks. All runtime writes stay below prod/.ai-work/.
Credentials are read into the child environment, never copied to disk or printed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
scenario = sys.argv[1]
assert scenario in ("enforce", "observe", "wrapper")
tag = sys.argv[2] if len(sys.argv) > 2 else ""
assert not tag or tag.replace("-", "").isalnum()
work = ROOT / ".ai-work/e2e" / (scenario + ("-" + tag if tag else ""))
work.mkdir(parents=True, exist_ok=False)
agent = work / "agent"
agent.mkdir()
# Read only; do not let pi rotate/write the live auth file.
auth = json.loads((Path.home() / ".pi/agent/auth.json").read_text())
credential = auth.get("anthropic", {})
key = credential.get("access") or credential.get("key")
if not key:
    raise SystemExit("No existing Anthropic credential; no login/refresh attempted")
env = dict(os.environ)
# A nested test process must not inherit ownership of the invoking session's marker.
env.pop("PI_SESSION_WRAPPER", None)
env.pop("PI_RELAUNCH_MARKER", None)
env.pop("PI_SESSION_WRAPPER_PID", None)
env.pop("PI_SESSION_LAUNCH_ID", None)
env.update(PI_CODING_AGENT_DIR=str(agent), PI_CODING_AGENT_SESSION_DIR=str(work / "sessions"),
           PI_CONTEXT_BUDGET_CONFIG=str(work / "config.json"), PI_CONTEXT_BUDGET_STATE_DIR=str(work / "state"),
           PI_JOBS_DIR=str(work / "jobs"), PI_SESSION_MARKER_DIR=str(work / "markers"),
           JITI_FS_CACHE="false", ANTHROPIC_API_KEY=key, PI_SESSION_MAX_RELAUNCHES_PER_HOUR="1")
config = {"mode": "observe" if scenario == "observe" else "enforce",
          "main": {"soft": 9000, "handoff": 12000, "hard": 100000, "minProgress": 1000},
          "maxHandoffsPerSession": 10}
if scenario == "wrapper":
    # A valid handoff now recovers hard limits. Exercise the independent cap fallback.
    config["maxHandoffsPerSession"] = 1
(work / "config.json").write_text(json.dumps(config))
(agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": True, "keepRecentTokens": 1000}}))
for n in range(1, 7):
    # Natural language filler, not gibberish (prototype provider-refusal caveat).
    text = f"Section {n}. The code word for this section is TAG-{n}.\n" + (
        "A reliable handoff records verified facts separately from hypotheses. "
        "Readers should check the current repository state before continuing a task. "
        "Background work remains attached to the session when context is compacted.\n" * 82)
    (work / f"part{n}.txt").write_text(text)
if scenario != "wrapper":
    prompt = (
        "Complete this file-reading task without asking questions. Work ONLY in this cwd. "
        "Read part1.txt through part6.txt IN ORDER, one file per read call, never combine reads. "
        "After EACH read, write/update notes.md with the section code words collected so far and next file number. "
        "After all six files, write done.txt containing DONE and all six code words. "
        "Use notes.md as durable progress if context changes. If context_handoff is requested, "
        "include the exact next file number and the code words already verified, then continue automatically. "
        "Never re-read a completed part. Keep handoffs concise."
    )
else:
    launch = work / "launch.md"
    launch.write_text("Work ONLY in this cwd. Continue from the supplied handoff, then write done.txt containing WRAPPER-DONE. Do not read the part files again. End when done.txt is written.")
    prompt = (
        "Work ONLY in this cwd. Read part1.txt only. "
        "Then call context_handoff with goal='wrapper fallback test', facts containing the verified code words, "
        "next_step='write done.txt containing WRAPPER-DONE without re-reading parts', "
        f"launch_prompt='{launch}', and user_constraints='Work only in this cwd; never re-read parts'. "
        "After that tool call end your turn immediately with a short acknowledgement and no more tools. "
        "Do not write done.txt in this initial session."
    )
(work / "prompt.md").write_text(prompt)
auth_extension = Path.home() / ".pi/agent/npm/node_modules/@gotgenes/pi-anthropic-auth/src/index.ts"
args = ["-ne", "-nc", "--no-mcp", "--no-skills", "--no-prompt-templates", "--session-dir", str(work / "sessions"),
        "-e", str(auth_extension), "-e", str(ROOT / "context-budget.ts"), "--model", "anthropic/claude-haiku-5-5", "-p"]
command = ["pi", *args, "@" + str(work / "prompt.md")]
if scenario == "wrapper":
    command = ["bash", str(ROOT / "bin/pi-session"), *args, "--", "@" + str(work / "prompt.md")]
with (work / "pi.log").open("w") as log:
    result = subprocess.run(command, cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=270)
print("command:", " ".join(command))
print("exit:", result.returncode)
if result.returncode:
    raise SystemExit(result.returncode)
entries = []
for path in (work / "sessions").rglob("*.jsonl"):
    entries.extend(json.loads(line) for line in path.read_text().splitlines())
events = [json.loads(line) for line in (work / "state/events.jsonl").read_text().splitlines()]
compactions = [e for e in entries if e.get("type") == "compaction"]
commits = [e for e in events if e.get("event") == "handoff_committed"]
blocks = [e for e in events if e.get("event") == "blocked"]
relaunches = [e for e in events if e.get("event") == "relaunch"]
# Same digest as the prototype analyze.py; sum ALL assistant usage (including post-compaction).
cost = sum(e.get("message", {}).get("usage", {}).get("cost", {}).get("total", 0) for e in entries if e.get("type") == "message")
status = [json.loads(path.read_text()) for path in (work / "state/status").glob("*.json")]
assert all(s["cwd"] == str(work) and s["model"] == "anthropic/claude-haiku-5-5" and s["role"] == "main" for s in status)
assert not any(e["event"] == "hook_error" for e in events), "Hook errors; inspect pi.log/events"
if scenario == "enforce":
    assert commits and blocks and compactions
    assert all(e["details"]["kind"] == "handoff" and e["firstKeptEntryId"] == e["id"] for e in compactions)
    assert any(s["handoffCount"] >= 1 for s in status)
    assert "DONE" in (work / "done.txt").read_text()
    assert all(f"TAG-{n}" in (work / "done.txt").read_text() for n in range(1, 7))
elif scenario == "observe":
    assert not blocks and not compactions and not commits and not relaunches
    assert any(e["event"].startswith("would_") for e in events)
    assert all(f"TAG-{n}" in (work / "done.txt").read_text() for n in range(1, 7))
else:
    assert len(relaunches) == 1
    assert len(status) == 2
    assert not list((work / "markers").glob("*.json"))
    assert "WRAPPER-DONE" in (work / "done.txt").read_text()
summary = dict(scenario=scenario, exit=result.returncode, compactions=len(compactions), commits=len(commits), blocks=len(blocks), relaunches=len(relaunches), sessions=len(status), cost=cost)
(work / "result.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
