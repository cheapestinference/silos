#!/usr/bin/env python3
# Renders "Your Silos inbox" for the SessionStart briefing: the messages other
# agents (or the owner) left for THIS agent that nobody has read yet — a
# message is read at the recipient's next conversation, any conversation
# starts with its inbox.
#
# The inbox is the SERVER's store (~/.silos/messages, fenced from agents):
# fetched with GET $SILOS_API/api/agents/$SILOS_AGENT_ID/messages?state=new,
# the agent's bearer AND its turn token ($SILOS_TURN). Serving marks them
# read only for a console or the owner's chat (the token's class says it);
# an unattended turn's are marked when it ends with output — the server
# decides, never this script.
# If the fetch fails (Silos down while `claude` is relaunched by hand) one
# line says so and nothing is marked. Stdlib only; any other failure prints
# nothing; nothing unread prints nothing.
#
# Then the asks other agents left THIS agent through Silos: GET
# $SILOS_API/api/agents/$SILOS_AGENT_ID/asks — linked and open, their words
# from Silos' store, never from a plan file. A fetch of the asks that fails
# lists none (the inbox above still prints).
import json
import os
import re
import sys
import urllib.parse

sys.dont_write_bytecode = True  # never leave a __pycache__ in the plugin's folder
import silos_http  # noqa: E402

LIST_MAX = 5
TEXT_MAX = 140
UNFETCHED = "Your Silos inbox could not be fetched this start"
ASK_TITLE_MAX = 120
OUTSIDE_MAX = 3   # tool names shown in «after reading the web (…)»
OUTSIDE_NAME_MAX = 40


def clean(s):
    return " ".join(str(s).split())


def outside_mark(verb, outside):
    """« — <verb> after reading the web (A, B, C, …)»: only the strings in
    the list, each cleaned and clipped, at most OUTSIDE_MAX of them. ""
    when there is none — a list of anything else never breaks the inbox."""
    if not isinstance(outside, list):
        return ""
    names = [clean(x)[:OUTSIDE_NAME_MAX] for x in outside if isinstance(x, str) and clean(x) != ""]
    if not names:
        return ""
    shown = ", ".join(names[:OUTSIDE_MAX]) + (", …" if len(names) > OUTSIDE_MAX else "")
    return f" — {verb} after reading the web ({shown})"


def row(m):
    text = clean(m.get("text", ""))
    if len(text) > TEXT_MAX:
        text = text[: TEXT_MAX - 1] + "…"
    mark = outside_mark("sent", m.get("readOutside"))
    return f"- {clean(m.get('at', ''))[:16]} from {clean(m.get('from', '?'))} ({clean(m['id'])}): {text}{mark}"


def render(messages):
    fresh = [m for m in messages if isinstance(m, dict) and m.get("state") == "new" and isinstance(m.get("id"), str)]
    if not fresh:
        return ""
    # oldest first: the order they should be read in
    fresh.sort(key=lambda m: str(m.get("at", "")))
    n = len(fresh)
    lines = [f"Your Silos inbox: {n} unread message{'s' if n != 1 else ''}. Read them before other work unless the owner's request in this conversation is more urgent — "
             "GET /api/agents/$SILOS_AGENT_ID/messages?state=new, then PATCH each to answered (with an \"answer\") / read / needs_owner "
             "(your Messages rule has the exact curl)."]
    for m in fresh[:LIST_MAX]:
        lines.append(row(m))
    if n > LIST_MAX:
        lines.append(f"- … and {n - LIST_MAX} more")
    return "\n".join(lines)


def clip(s, n):
    s = clean(s)
    return s[: n - 1] + "…" if len(s) > n else s


def ask_row(a):
    key = clean(a.get("key", ""))
    who = clean(a.get("fromName", "") or a.get("from", "?"))
    ref = clean(a.get("ref", ""))
    if a.get("silos") is True:
        return f"- ask:{key} — {ref} «{clip(a.get('title', ''), ASK_TITLE_MAX)}» is stuck and Silos asks you to help unstick it ({who} stays its owner)"
    asked = a.get("asked")
    what = asked if isinstance(asked, str) and clean(asked) != "" else a.get("action", "")
    mark = outside_mark("asked", a.get("readOutside"))
    return f"- ask:{key} — {who} waits on you for {ref}: «{clip(what, TEXT_MAX)}»{mark}"


def render_asks(asks):
    fresh = [a for a in asks if isinstance(a, dict) and isinstance(a.get("key"), str)]
    if not fresh:
        return ""
    # oldest first, like the messages
    fresh.sort(key=lambda a: str(a.get("at", "")))
    n = len(fresh)
    lines = [f"Asks waiting on you through Silos: {n}. Answer each with POST /api/tasks/ask/answer "
             "{\"key\":\"<key>\",\"text\":\"<your answer>\",\"turn\":\"$SILOS_TURN\"} — it lands as your note on their task and moves it on; "
             "«not mine — ask the owner» is an answer too (your Tasks rule has the recipe)."]
    for a in fresh[:LIST_MAX]:
        lines.append(ask_row(a))
    if n > LIST_MAX:
        lines.append(f"- … and {n - LIST_MAX} more")
    return "\n".join(lines)


def get(me, path):
    return json.loads(silos_http.get(f"/api/agents/{urllib.parse.quote(me, safe='')}/{path}", turn=True).decode("utf-8"))


def fetch(me):
    data = get(me, "messages?state=new")
    msgs = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(msgs, list):
        raise ValueError("no messages in the answer")
    return msgs


def fetch_asks(me):
    data = get(me, "asks")
    asks = data.get("asks") if isinstance(data, dict) else None
    if not isinstance(asks, list):
        raise ValueError("no asks in the answer")
    return asks


def main():
    me = os.environ.get("SILOS_AGENT_ID", "")
    # master (Anywhere) has no inbox: a message there is refused (409)
    if not me or me == "master" or not re.fullmatch(r"[A-Za-z0-9_.-]+", me) or set(me) == {"."}:
        return 0
    try:
        msgs = fetch(me)
    except Exception:
        print(UNFETCHED)
        return 0
    try:
        asks = fetch_asks(me)
    except Exception:
        asks = []
    text = "\n".join(t for t in (render(msgs), render_asks(asks)) if t)
    if text:
        print(text)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
