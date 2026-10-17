#!/usr/bin/env python3
"""Cache-cost digest of pi session jsonl files: bootstrap request, first request after each
compaction, and the other (normal) turns.  usage: analyze.py SESSION.jsonl..."""
import json, statistics, sys

def row(u):
    return dict(input=u.get("input", 0), cacheRead=u.get("cacheRead", 0), cacheWrite=u.get("cacheWrite", 0),
                output=u.get("output", 0), cost=round(u.get("cost", {}).get("total", 0), 5))

for path in sys.argv[1:]:
    entries = [json.loads(l) for l in open(path)]
    model, first, post, normal, after_compaction = None, None, [], [], False
    for e in entries:
        if e["type"] == "compaction":
            after_compaction = True
            continue
        m = e.get("message") if e["type"] == "message" else None
        if not m or m.get("role") != "assistant" or "usage" not in m:
            continue
        model = m.get("model")
        r = row(m["usage"])
        if first is None:
            first = r
        elif after_compaction:
            post.append(r)
        else:
            normal.append(r)
        after_compaction = False
    print(f"== {path.split('/')[-1]}  model={model}")
    print(f"  bootstrap          {first}")
    for i, r in enumerate(post):
        print(f"  post-compaction #{i+1} {r}")
    if normal:
        med = lambda k: statistics.median(r[k] for r in normal)
        print(f"  normal turns n={len(normal)} median cacheRead={med('cacheRead')} cacheWrite={med('cacheWrite')} cost={med('cost')}"
              f" total={round(sum(r['cost'] for r in normal),4)}")
    allc = [first] + post + normal if first else []
    print(f"  session total cost={round(sum(r['cost'] for r in allc), 4)}")
