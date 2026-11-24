#!/usr/bin/env python3
# Renders the roster block from {"agents":[...]} on stdin — the agents of the
# reader's projects, never the install (server/src/project-scope.ts is the
# rule; this file carries its twin of sameProject/knows because it may be
# given the raw ~/.silos/agents.json).
#
#   roster.py [--cwd DIR]     reader = $SILOS_AGENT_ID ("" = no identity)
#
# · An agent: "Your projects (Silos): …", the agents it knows — each with
#   those of its folders that are the reader's projects too — and where the
#   wall is.
# · No identity (a claude started by hand) or the owner's desk (master): the
#   agents of the folder it runs in (--cwd), under "This folder's agents
#   (Silos):"; a folder that is nobody's project gets nothing.
# A project is a folder; folders that nest are one project. Two agents know
# each other when they are of a common project — not transitively.
# Stdlib only. Any failure prints nothing (the hook then emits the briefing
# alone). server/src/harnesses/roster-text.ts is its twin, byte for byte
# (server/test/roster-text.test.ts).
import json
import os
import re
import sys

# Bounded (the SessionStart hook's output is capped, compose.py): at most
# LIST_MAX agents, each line at most LINE_MAX characters; the rest is one
# line saying how many and where to read them.
LIST_MAX = 12
LINE_MAX = 160
MORE = "- … and %d more — GET ${SILOS_API:-http://127.0.0.1:3210}/api/agents"
MASTER = "master"
WALL = "Outside your projects there is nobody for you to reach: ask the owner. Do not work outside your projects."
APART = "Your projects are kept apart: do not carry one project's matters, files or messages into another unless the owner asks."


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


def strip(p):
    return (p.rstrip("/") or "/") if len(p) > 1 else p


def folders_of(a):
    # the declared folders, absolute, no trailing slash, each once
    out = []
    more = a.get("folders")
    for p in [a.get("folder")] + (more if isinstance(more, list) else []):
        if not isinstance(p, str) or not p.startswith("/"):
            continue
        f = strip(p)
        if f != "/" and f not in out:
            out.append(f)
    return out


def same_project(f, g):
    return f == g or f.startswith(g + "/") or g.startswith(f + "/")


def in_play(a):
    return not a.get("archived") and a.get("id") != MASTER and len(folders_of(a)) > 0


def knows(a, b):
    if not in_play(a) or not in_play(b):
        return False
    return any(same_project(f, g) for f in folders_of(a) for g in folders_of(b))


def shared(a, b):
    # b's folders that are a's projects too
    fa = folders_of(a)
    return [g for g in folders_of(b) if any(same_project(f, g) for f in fa)]


def parts_of(a, folders):
    parts = [clean(f"{a.get('emoji', '')} {a.get('name', a.get('id', ''))}")]
    if folders:
        parts.append("in " + ", ".join(clean(f) for f in folders))
    # its mission's first sentence — nothing without one
    parts.append(mission_line(a))
    return clip("- " + " — ".join(p for p in parts if p))


def listed(rows):
    lines = [parts_of(a, fl) for a, fl in rows[:LIST_MAX]]
    if len(rows) > LIST_MAX:
        lines.append(MORE % (len(rows) - LIST_MAX))
    return lines


def apart(fl):
    # more than one project among its own folders (nesting joins them)
    groups = []
    for f in fl:
        hit = [g for g in groups if any(same_project(f, x) for x in g)]
        merged = [f]
        for g in hit:
            merged += g
            groups.remove(g)
        groups.append(merged)
    return len(groups) > 1


def render(agents, me, cwd):
    agents = [a for a in agents if isinstance(a, dict)]
    mine = next((a for a in agents if me and a.get("id") == me), None)
    if me and mine is None:
        return ""
    if mine is not None and mine.get("id") != MASTER:
        if not in_play(mine):
            return ""
        fl = folders_of(mine)
        rows = [(a, shared(mine, a)) for a in agents if a.get("id") != me and knows(mine, a)]
        name = clean(mine.get("name", me))
        lines = ["Your projects (Silos): " + ", ".join(clean(f) for f in fl)]
        if rows:
            lines.append("Agents who work there with you:")
            lines += listed(rows)
            lines.append(f'You are {name}. For work in a folder that is theirs and not yours, message that agent (see "Messages" below). {WALL}')
        else:
            lines.append(f"You are {name}, the only agent there. {WALL}")
        if apart(fl):
            lines.append(APART)
        return "\n".join(lines)
    # no identity, or the owner's desk: the agents of the folder it runs in
    if not cwd or not cwd.startswith("/") or strip(cwd) == "/":
        return ""
    here = strip(cwd)
    rows = [(a, [f for f in folders_of(a) if same_project(f, here)]) for a in agents if in_play(a)]
    rows = [(a, f) for a, f in rows if f]
    if not rows:
        return ""
    return "\n".join(["This folder's agents (Silos):"] + listed(rows))


def main():
    try:
        agents = json.load(sys.stdin).get("agents") or []
    except Exception:
        return 1
    args = sys.argv[1:]
    cwd = args[args.index("--cwd") + 1] if "--cwd" in args and args.index("--cwd") + 1 < len(args) else ""
    if not isinstance(agents, list):
        return 1
    out = render(agents, os.environ.get("SILOS_AGENT_ID", ""), cwd)
    if not out:
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
