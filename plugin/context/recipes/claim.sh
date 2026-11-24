curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/claim \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
