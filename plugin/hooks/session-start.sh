#!/bin/sh
# SessionStart hook — the Silos briefing: every claude on this machine wakes
# knowing it runs inside Silos and how to integrate (deliverables in the
# project, shared plans, legibility), plus the fleet roster. Sources:
# plugin/context/briefing.d/ composed by compose.py for the skills THIS
# session has (never an order to use a missing skill),
# roster.py (agents from the API, else from ~/.silos/agents.json) and
# inbox.py. Never breaks claude: any failure degrades to less context, or
# to nothing, and the exit code is always 0.
# It also writes the session's birth marker (birth.py, from the JSON Claude
# Code pipes in on stdin) before anything else: the marker is how Silos
# tells a nested `claude -p` an agent launched from the owner's own
# conversations. A failed write never stops the briefing.
#
# What it sends, per Claude Code's `source` (startup|resume|clear|compact|
# fork) — one rule: each part is sent unless this session's context
# already carries it.
#  · The briefing (the static rules). A claude Silos launches carries it in
#    its system prompt ($SILOS_BRIEFING=system-prompt — the console's
#    --append-system-prompt-file, the SDK's systemPrompt.append): it lasts
#    across /clear and compaction, so the hook never repeats it. A claude
#    that inherited that variable but was launched from a shell (a
#    `claude -p` from Bash: a startup whose session id is not
#    $SILOS_SESSION_ID) does not carry it and gets it here. Otherwise (a
#    claude started by hand) it is sent on startup, clear and compact; on
#    resume and fork only when the transcript since its last compaction
#    does not already hold it. A session with no Silos identity
#    ($SILOS_AGENT_TOKEN empty: started by hand, not by Silos) cannot act on
#    the API recipes, so what it is sent is the slim briefing
#    (plugin/context/hand-started.md, about 1,700 characters): what Silos
#    is and the few rules that still apply to it.
#  · The roster: the same «already holds it» test on resume and fork.
#  · The inbox: always (it is what is new).
#  · The tasks this console still works: after /clear only.
# Whatever it sends is under Claude Code's 10,000-character cap for a hook's
# additionalContext (compose.py --hook --cap): over it the model would get a
# file path and a 2,000-character preview instead of the rules.
#
# The one tool it needs is python3 (stdlib only — the server is asked by
# silos_http.py: no curl, the bearer never in a command line, no proxy for a
# loopback Silos). Without it nothing can be composed or written: ONE line
# on stderr says so and the session starts anyway (the same contract as
# pre-cron.sh).
dir=$(dirname "$0")
CAP=9500

if ! command -v python3 >/dev/null 2>&1; then
  echo "silos session-start: python3 is not installed — no Silos briefing, roster, inbox or birth marker for this session (it starts without them)" >&2
  exit 0
fi

# stdin is read ONCE (Claude Code's JSON: session_id, cwd, source,
# transcript_path); never block a launch on a caller that left it open.
input=""
if [ ! -t 0 ]; then
  input=$(python3 -c 'import select,sys
r,_,_=select.select([sys.stdin],[],[],2)
sys.stdout.write(sys.stdin.read() if r else "")' 2>/dev/null) || input=""
fi
printf '%s' "$input" | python3 "$dir/birth.py" 2>/dev/null || true
# source, session_id and transcript_path, one per line ("" when absent or
# not a one-line string)
fields=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    d=json.loads(sys.stdin.read() or "{}")
except Exception:
    d={}
for k in ("source","session_id","transcript_path"):
    s=d.get(k) if isinstance(d,dict) else None
    print(s if isinstance(s,str) and "\n" not in s and "\r" not in s else "")' 2>/dev/null) || fields=""
src=$(printf '%s\n' "$fields" | sed -n 1p)
sid=$(printf '%s\n' "$fields" | sed -n 2p)
tp=$(printf '%s\n' "$fields" | sed -n 3p)

# Does this session's context already carry the briefing / the roster?
briefed=""
if [ "$SILOS_BRIEFING" = "system-prompt" ]; then
  briefed=1
  if [ "$src" != "resume" ] && [ "$src" != "fork" ] && [ "$src" != "clear" ] && [ "$src" != "compact" ] \
    && [ -n "$SILOS_SESSION_ID" ] && [ "$sid" != "$SILOS_SESSION_ID" ]; then
    briefed="" # launched from a shell inside a Silos session: not its system prompt
  fi
fi
held=""
case "$src" in
  resume|fork)
    [ -n "$tp" ] && held=$(python3 "$dir/compose.py" --carries "$tp" 2>/dev/null) || true
    ;;
esac
static=""
[ -z "$briefed" ] && case " $held " in *" briefing "*) ;; *) static=1 ;; esac
want_roster=1
case " $held " in *" roster "*) want_roster="" ;; esac

# The skills this session surely has — only what no setting can turn off:
# the plugin's own when it is loaded as a plugin (a plugin's skill takes no
# skillOverrides entry; by path, as Silos installs it, CLAUDE_PLUGIN_ROOT is
# empty). A copy in the project's .claude/skills or the personal skills
# folder is NOT counted: whether it loads depends on every settings tier,
# the launch's own flag tier (--settings) included, which a hook cannot see.
# A process Silos launches carries the briefing composed for exactly what
# it loads (server: launchSkillNames) and this hook never sends it; what
# gets the static briefing here with a bearer is a claude started from a
# shell inside a Silos session, whose launch Silos never saw — so it is
# composed neutral (the minimal recipes), never pointing at a skill its
# settings may have turned off.
has=""
for f in "$dir"/../context/briefing.d/*.with.md; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .with.md)
  if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/skills/$n/SKILL.md" ]; then
    has="${has:+$has,}$n"
  fi
done

dyn=""
add() { [ -n "$1" ] && dyn="${dyn:+$dyn

}$1"; }

if [ -n "$want_roster" ]; then
  roster=""
  agents=$(python3 "$dir/silos_http.py" /api/agents 2>/dev/null) || agents=""
  if [ -n "$agents" ]; then
    roster=$(printf '%s' "$agents" | python3 "$dir/roster.py" 2>/dev/null) || roster=""
  fi
  if [ -z "$roster" ] && [ -r "$HOME/.silos/agents.json" ]; then
    roster=$(python3 "$dir/roster.py" < "$HOME/.silos/agents.json" 2>/dev/null) || roster=""
  fi
  add "$roster"
fi

# The agent's unread messages (inbox.py — the server's store, fetched with
# the bearer and $SILOS_TURN: a console's or a chat's serving marks them
# read). A failed fetch says so in one line.
inbox=$(python3 "$dir/inbox.py" 2>/dev/null) || inbox=""
add "$inbox"

# Proof of life after /clear: the console is ONE conversation for
# its tasks, so it still works them — say which, and how to let go. Always
# the by-session route (the hook never re-derives Silos' folder names);
# any failure says nothing. At most WORKING_MAX tasks, then one line.
WORKING_MAX=3
if [ "$src" = "clear" ] && [ -n "$SILOS_SESSION_ID" ]; then
  q=$(printf '%s' "$SILOS_SESSION_ID" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))' 2>/dev/null) || q=""
  if [ -n "$q" ]; then
    bys=$(python3 "$dir/silos_http.py" "/api/tasks/by-session?session=$q" 2>/dev/null) || bys=""
    # the release recipe is plugin/context/recipes/release.sh, read now (its
    # one source): its <slug>/<id> markers are filled with
    # sed and it is emitted as a fenced block — the same text the server's
    # recipeText('release', fill) gives (recipes-identical.test.ts)
    recipe=""
    [ -r "$dir/../context/recipes/release.sh" ] && recipe=$(cat "$dir/../context/recipes/release.sh" 2>/dev/null) || recipe=""
    rows=""
    [ -n "$bys" ] && [ -n "$recipe" ] && rows=$(printf '%s' "$bys" | SESSION="$SILOS_SESSION_ID" python3 -c '
import json, os, re, sys
data = json.loads(sys.stdin.read())
rows = data.get(os.environ["SESSION"]) if isinstance(data, dict) else None
flat = lambda s: " ".join(s.split())
for t in rows if isinstance(rows, list) else []:
    if not isinstance(t, dict) or t.get("current") is not True or t.get("closed") is True:
        continue
    if t.get("state") in ("done", "cancelled"):
        continue
    ref, title, key = t.get("ref"), t.get("title"), t.get("key")
    if not isinstance(ref, str) or "#" not in ref:
        continue
    plan, task = ref.rsplit("#", 1)
    # the recipe sends the id of the FILE, from the key
    # (<location>/<plan>/tasks/<task>): "tasks" for the list of the project,
    # which the conversation narrows to its project; the ref
    # (<project>#t3) is only what the line says
    parts = key.split("/") if isinstance(key, str) else []
    if len(parts) >= 4 and parts[-1] == task and parts[-2] == "tasks" and parts[-3] != "":
        plan = parts[-3]
    # plan and task are filled into a command the model is told to run:
    # only ids made of letters, digits, dot, dash and underscore get there
    # (never a quote, a space or a shell character from the API)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", plan) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", task):
        continue
    ref = flat(ref)
    if len(ref) > 160:
        ref = ref[:159] + "…"
    if not isinstance(title, str) or flat(title) == "":
        title = task
    title = flat(title)
    if len(title) > 120:
        title = title[:119] + "…"
    sys.stdout.buffer.write(("%s\t%s\t%s\t%s\n" % (ref, plan, task, title)).encode("utf-8"))
' 2>/dev/null) || rows=""
    working=""
    count=0
    tab=$(printf '\t')
    while IFS="$tab" read -r ref plan task title; do
      [ -n "$plan" ] || continue
      count=$((count + 1))
      [ "$count" -le "$WORKING_MAX" ] || continue
      p=$(printf '%s' "$plan" | sed 's/[\\&|]/\\&/g')
      t=$(printf '%s' "$task" | sed 's/[\\&|]/\\&/g')
      filled=$(printf '%s\n' "$recipe" | sed -e "s|<slug>|$p|g" -e "s|<id>|$t|g") || continue
      line="This console was working on «$title» ($ref). Continue it — or, if you are switching to something else, release it (it goes back to pending; add \"state\" to say done/blocked/in_review — in_review only with waitingOn naming who reviews it):
\`\`\`
$filled
\`\`\`"
      working="${working:+$working
}$line"
    done <<EOF
$rows
EOF
    if [ "$count" -gt "$WORKING_MAX" ]; then
      working="$working
… and $((count - WORKING_MAX)) more tasks this console works — the list: GET \${SILOS_API:-http://127.0.0.1:3210}/api/tasks/by-session?session=\$SILOS_SESSION_ID (release each the same way)."
    fi
    add "$working"
  fi
fi

# The briefing within what the rest leaves of the cap, then the rest; the
# SessionStart JSON, encoded once. If python3 is unavailable (slim server
# images have none), emit NOTHING rather than malformed JSON.
slim=""
[ -z "$SILOS_AGENT_TOKEN" ] && slim=1
printf '%s' "$dyn" | python3 "$dir/compose.py" --hook ${static:+--static} ${slim:+--slim} --has "$has" --cap "$CAP" 2>/dev/null || true
exit 0
