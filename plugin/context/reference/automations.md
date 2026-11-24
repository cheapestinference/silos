# Silos automations — triggers, command runs, limits

The reference behind the briefing's scheduling rule. An automation is proposed with `POST /api/proposals` (the recipe is in the rule itself); this is what its `input` may say.

## Trigger kinds

- `{"kind":"cron","expr":"<5-field cron>"}`
- `{"kind":"once","at":"<ISO>"}`
- `{"kind":"files","glob":"<pattern>"}` (fires on file changes; optional `"folder"` — your own folder when left out)
- `{"kind":"webhook"}` (optional `"secret"` — when left out Silos makes one and shows it once, as `generatedSecret` in the answer)
- `{"kind":"conversation","when":"finished"|"needs_you"}`

## Options

Optional: `"thread":{"mode":"keep"}` to run every time in one persistent conversation, `"approval":true` to require the owner's OK before each run, `"maxRunsPerDay":N`.

## A command run

A script with no judgment (a command) is proposed the same way, with a `run`:

`"input":{"name":"<short name>","agentId":"'"$SILOS_AGENT_ID"'","prompt":"<what you are asked if it fails>","trigger":{"kind":"cron","expr":"0 */2 * * *"},"run":{"kind":"command","argv":["<absolute path>","<arg>"],"cwd":"<absolute dir>","onFailure":"inbox"|"agent","okCodes":[0]}}`

`onFailure:"agent"` hands a failure to a turn of yours with the log's tail. A command runs with no conversation: it never claims or releases a task (its run's outcome is its record).

## Limits

Withdraw your own with `POST /api/proposals/<id>/dismiss` and `{"turn":"$SILOS_TURN"}`. At most 3 of your suggestions wait for the owner at once.
