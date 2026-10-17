#!/usr/bin/env python3
"""Use pi-phase's injectable state path; never write into the live agent directory."""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path.home() / ".pi/agent/pi-phase"))
from pi_phase import main

raise SystemExit(main(state=root / ".ai-work/phase-state",
                     configuration=Path.home() / ".pi/agent/pi-phase/config.json"))
