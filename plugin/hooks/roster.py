#!/usr/bin/env python3
# Renders the "Your fleet (Silos)" block from {"agents":[...]} on stdin.
# Stdlib only. Any failure prints nothing (the hook then emits the briefing alone).
import json
import os
import re
import sys

# Bounded (the SessionStart hook's output is capped, compose.py): at most
# LIST_MAX agents, each line at most LINE_MAX characters; the rest is one
# line saying how many and where the whole fleet is.
LIST_MAX = 12
LINE_MAX = 160
MORE = "- … and %d more — the whole fleet: GET ${SILOS_API:-http://127.0.0.1:3210}/api/agents"


def clip(line):
    return line if len(line) <= LINE_MAX else line[: LINE_MAX - 1] + "…"


def clean(s):
    return " ".join(str(s).split())


def mission_line(a):
    # The first sentence of the agent's mission text ("" without one) — the
    # same regex as server/src/mission.ts firstSentence.
    m = a.get("mission")
    if not isinstance(m, dict) or not m.get("text"):
        return ""
    s = clean(m["text"])
    hit = re.match(r"(.+?[.!?])(?=\s|$)", s)
    return hit.group(1) if hit else s


def folders_of(a):
    out = []
    if a.get("folder"):
        out.append(clean(a["folder"]))
    for f in a.get("folders") or []:
        if f:
            out.append(clean(f))
    return out


def main():
    try:
        agents = json.load(sys.stdin).get("agents") or []
    except Exception:
        return 1
    me = os.environ.get("SILOS_AGENT_ID", "")
    lines = ["Your fleet (Silos):"]
    agents = [a for a in agents if isinstance(a, dict)]
    listed = 0
    for a in agents:
        if a.get("archived") or a.get("id") == "master":
            continue
        listed += 1
        if listed > LIST_MAX:
            continue
        parts = [clean(f"{a.get('emoji', '')} {a.get('name', a.get('id', ''))}")]
        fl = folders_of(a)
        if fl:
            parts.append("in " + ", ".join(fl))
        # its mission's first sentence — nothing without one
        parts.append(mission_line(a))
        lines.append(clip("- " + " — ".join(p for p in parts if p)))
    if len(lines) == 1:
        return 1
    if listed > LIST_MAX:
        lines.append(MORE % (listed - LIST_MAX))
    mine = next((a for a in agents if me and a.get("id") == me), None)
    # Master has no territory, nor does an agent without folders: no line
    # rather than "Your territory: ." (stay inside nothing).
    if mine and mine.get("id") != "master" and folders_of(mine):
        lines.append(
            f"You are {clean(mine.get('name', me))}. Your territory: {', '.join(folders_of(mine))}. "
            'To get something done elsewhere, message its agent (see "Messages" below); '
            "do not work there."
        )
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
