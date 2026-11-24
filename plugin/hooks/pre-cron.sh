#!/bin/sh
# PreToolUse hook on CronCreate — the enforcement half of the briefing's
# "scheduled work uses Silos automations" rule. What it denies depends on
# whose session this is:
#
#  · A Silos agent's session (Silos sets $SILOS_AGENT_ID and the agent's
#    bearer $SILOS_AGENT_TOKEN on every launch — either one says so): a
#    RECURRING native cron is invisible to the owner (no state, no history,
#    no pause), so it is denied with the recipe for the visible equivalent,
#    a Silos automation the agent proposes. `recurring` is optional and
#    defaults to TRUE (Claude Code 2.1.319: "true (default) = fire on every
#    cron match"), so only a call that says `recurring: false` literally is
#    a one-shot. `durable: true` persists to .claude/scheduled_tasks.json —
#    work left scheduled in the operator's folder, invisible too — and is
#    denied as well. A one-shot, non-durable self-ping is the legitimate
#    native use and passes untouched.
#
#  · A session a person started by hand (neither variable): only a
#    `durable: true` cron is denied — it outlives the session, which is
#    exactly what a Silos automation is for. Everything session-scoped
#    passes, recurring or not: a fixed-interval /loop is a recurring,
#    session-scoped CronCreate and keeps working. And outside Silos the
#    hook stays out of the way altogether: on a machine where no Silos
#    answers ($SILOS_API, default http://127.0.0.1:3210, GET /healthz
#    within 1 s) even the durable one is allowed, silently — there is no
#    automation to point at. The probe runs only for a call that would be
#    denied.
#
# Same never-break-claude contract as session-start.sh: input that cannot
# be read allows, and without python3 (the one tool it needs) it allows
# with ONE line on stderr. It never exits 2: a denial is the JSON below on
# exit 0.
dir=$(dirname "$0")
api="${SILOS_API:-http://127.0.0.1:3210}"
input=$(cat 2>/dev/null) || exit 0
if ! command -v python3 >/dev/null 2>&1; then
  echo "silos pre-cron: python3 is not installed — the cron gate cannot read the call, so it allows it" >&2
  exit 0
fi
agent=""
if [ -n "$SILOS_AGENT_ID" ] || [ -n "$SILOS_AGENT_TOKEN" ]; then agent=1; fi

verdict=$(printf '%s' "$input" | SILOS_HOOK_AGENT="$agent" python3 -c 'import json,os,sys
try:
  t=json.load(sys.stdin).get("tool_input")
  t=t if isinstance(t,dict) else {}
except Exception:
  print("allow"); sys.exit(0)
recurring=t.get("recurring") is not False
durable=t.get("durable") is True
deny=(recurring or durable) if os.environ.get("SILOS_HOOK_AGENT") else durable
print("deny" if deny else "allow")' 2>/dev/null) || exit 0
[ "$verdict" = "deny" ] || exit 0

# An agent gets the recipe (its bearer proposes; the owner approves in one
# click).
if [ -n "$agent" ]; then
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Recurring or durable native crons are invisible to the owner (no state, no history, no pause). Propose a Silos automation instead — visible, pausable, with run history; the owner creates it in one click: curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/proposals -H \"Authorization: Bearer $SILOS_AGENT_TOKEN\" -H 'content-type: application/json' -d '{\"turn\":\"'\"$SILOS_TURN\"'\",\"kind\":\"automation\",\"reason\":\"<one line: why>\",\"input\":{\"name\":\"<short name>\",\"agentId\":\"'\"$SILOS_AGENT_ID\"'\",\"prompt\":\"<what each run must do>\",\"trigger\":{\"kind\":\"cron\",\"expr\":\"<5-field cron>\"}}}'. A one-shot CronCreate with recurring:false, never durable, is fine for a self-ping."}}
JSON
  exit 0
fi

# A person's own session asking for a durable cron: is there a Silos here
# to point at? If not, allow and say nothing.
python3 "$dir/silos_http.py" /healthz 1 2>/dev/null | grep -q '"ok":true' || exit 0
SILOS_HOOK_API="$api" python3 -c 'import json,os
api=os.environ["SILOS_HOOK_API"].rstrip("/")
why="A durable native cron outlives this session with no state, history or pause anyone can see. Create it as a Silos automation instead, visible, pausable, with run history: "+api+"/automation/new . A cron that lives only in this session (durable left out) is fine — /loop keeps working."
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":why}}))' 2>/dev/null || exit 0
