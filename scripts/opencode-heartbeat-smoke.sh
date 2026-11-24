#!/usr/bin/env bash
# Smoke: does the heartbeat's per-process config
# really take the `task` tool (OpenCode's subagent) and the web tools away
# from `opencode run`? Until this is green, Silos says «subagents may not be
# blocked on your engine» in the heartbeat prompt and a child session in an
# OpenCode heartbeat undoes without cutting (opencode/index.ts
# traits.heartbeatBlocks.subagents stays false).
#
# Runs the INSTALLED opencode with the operator's own provider setup, in a
# throwaway project dir, with exactly the config Silos emits for a heartbeat
# (launch.ts HEARTBEAT_TOOLS_OFF / HEARTBEAT_PERMISSION_DENY). It spends one
# short turn. Never run from the test suite.
#
#   scripts/opencode-heartbeat-smoke.sh [provider/model]
set -u
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/work"
cd "$tmp/work" || exit 2
echo "opencode version: $(opencode --version)"
cfg='{"tools":{"webfetch":false,"websearch":false,"task":false},"permission":{"webfetch":"deny","websearch":"deny","task":"deny"}}'
model=()
[ $# -ge 1 ] && model=(--model "$1")
out=$(OPENCODE_CONFIG_CONTENT="$cfg" timeout 300 opencode run "${model[@]}" \
  "List the tools you can call, by exact name, one per line. Then try to start a subagent with the task tool to count to 3, and try to fetch https://example.com. Report exactly what each attempt returned." </dev/null 2>&1)
echo "$out"
echo "---"
fail=0
if echo "$out" | grep -qiE '^\s*-?\s*task\s*$'; then echo "FAIL: task is still listed"; fail=1; fi
if echo "$out" | grep -qiE '^\s*-?\s*webfetch\s*$'; then echo "FAIL: webfetch is still listed"; fail=1; fi
if echo "$out" | grep -qiE 'Example Domain'; then echo "FAIL: the fetch reached the web"; fail=1; fi
[ $fail -eq 0 ] && echo "OK: task and web tools withheld — flip heartbeatBlocks.subagents to true (opencode/index.ts) with this output in the commit"
exit $fail
