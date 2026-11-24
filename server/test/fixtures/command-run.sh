#!/bin/sh
# command-run.sh — the fixture a command automation execs in the tests
# (server/test/command-automations.test.ts). One verb per behaviour.
case "$1" in
  ok) echo "starting"; echo "synced 3 invoices"; exit 0 ;;
  fail) echo "working"; echo "boom: ledgerly said 500" >&2; exit "${2:-2}" ;;
  sleep) echo "going to sleep"; sleep 30; exit 0 ;;
  big) i=0; while [ $i -lt 30000 ]; do echo "line $i of a long and very chatty output that goes on and on"; i=$((i+1)); done; echo "the end"; exit 0 ;;
  secret) echo "token is $FIXTURE_SECRET here"; echo "bearer $SILOS_AGENT_TOKEN"; exit 0 ;;
  env) env | sort; exit 0 ;;
  outcome) echo "did the thing"; echo "OUTCOME: acted — synced 3 invoices"; exit 0 ;;
  pwd) pwd; exit 0 ;;
  api) echo "$SILOS_API"; exit 0 ;;
  args) for a in "$@"; do echo "[$a]"; done; exit 0 ;;
  *) echo "unknown verb $1" >&2; exit 64 ;;
esac
