---
name: vault-secrets
description: Use when a task needs a credential (API key, token, password, webhook secret), when the user offers to paste one, when a tool fails with 401/403/missing-key, or when you are about to write a secret to a file or print it — route it through the Silos Vault instead.
---

# Vault secrets — credentials never travel through the conversation

Everything you read or write lands in the transcript (JSONL on disk, read
by other tools). A secret pasted in chat, echoed by a command, or saved to
an ad-hoc file is leaked the moment it exists. The Silos Vault is the one
place for credentials: the owner stores them there and Silos injects them
as ENVIRONMENT VARIABLES into your process.

## Refuse the paste, ask for the Vault

When a secret is needed — or the user starts to paste one — stop and ask
for it to be added to the Vault. Give the owner the exact spec so they can
do it in one step:

- **name** — the env var you will read, `UPPER_SNAKE` (e.g. `EXAMPLE_API_TOKEN`).
  Never `CLAUDE*` / `ANTHROPIC_*` (reserved for the provider layer), `SILOS_*`
  (Silos' own wiring) nor shell basics (`PATH`, `HOME`, `SHELL`, `TERM`, `USER`).
- **scope** — the narrowest that works:
  - `agent` — only you need it (default for an agent's own duty)
  - `folder` — every agent working in that project folder
  - `global` — everyone on this machine (rare; say why)
- **where** — Silos → the agent's page → *Secrets* (one agent's entries),
  or the *Vault* page (the key in the left rail) for a folder or everyone.

Precedence on a collision: agent > folder > global.

## Your own scope — secrets you obtain yourself

A credential YOU produce (you signed up for an account, minted an API key,
captured or rotated a session cookie) does not need the owner: write it into
your own scope of the Vault, which only you see. The value is already in
your hands, so put it there right away and do not repeat it in the chat:

```sh
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/agents/$SILOS_AGENT_ID/vault \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg v "$NEW_VALUE" --arg t "$SILOS_TURN" '{name:"SERVICE_SESSION_COOKIE",value:$v,turn:$t}')"
```

Build the body from a variable, as above (`jq` builds the JSON, so a value
with quotes or newlines stays intact), and never type the value inline
where it gets echoed. The answer is `201` (created) or `200`
(`replaced: true`, a name you already wrote: the value is rotated in place).
List what reaches you, masked, with `mine: true` on the ones you may change:
`GET /api/agents/$SILOS_AGENT_ID/vault`. Delete one of yours with
`DELETE /api/agents/$SILOS_AGENT_ID/vault/<id>` with `-H "x-silos-turn: $SILOS_TURN"`.
Every write names the turn it comes from (`$SILOS_TURN`, which Silos
hands each turn and console): without it the write is refused.

What stays with the owner:
- a secret the owner set, even one visible only to you: a write returns
  `409` and a delete `403`. Ask the owner, with the spec above;
- sharing with other agents, a project or everyone: you only write for
  yourself. If another agent needs it, ask the owner to widen the visibility
  on the Vault page;
- `POST /api/vault` and the rest of the Vault: `403` for you, on purpose.

If the user has already pasted the secret, do not use it, do not repeat
it, and say the value should be rotated (it is in the transcript now).

## Signed entries — Silos holds the value, you make the call

The owner can turn an entry into a **signed** one: it is bound to one
service (a fixed host) and stops travelling in any environment — yours
included. Silos adds the credential to your call on the way out; the value
never enters your process, so it cannot leak from it.

**How you know which ones are signed**: your brief says it, name by name —
a delivered entry as «read NAME from your environment», a signed one as
«sign with NAME via …/api/egress/NAME/…». `GET /api/agents/$SILOS_AGENT_ID/vault`
lists signed entries with their `binding` (the host, never the value).
A signed entry is NOT in your env: `test -n "$NAME"` says missing, and that
is correct — do not report it as a missing secret, and do not ask for it.

**How you call the service**: put the path (and query) you would send to the
service after `/api/egress/<NAME>/`, any method, your body as is, with your
identity and your turn:

```sh
curl -s ${SILOS_API:-http://127.0.0.1:3210}/api/egress/GITHUB_TOKEN/repos/OWNER/REPO/issues \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  -H "x-silos-turn: $SILOS_TURN"

curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/egress/STRIPE_KEY/v1/customers \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  -H "x-silos-turn: $SILOS_TURN" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'email=a@example.com'
```

Silos forwards it to the bound host + that path, with the credential in the
header the owner set; your own `Authorization` is dropped (it carries your
Silos bearer, never the service's). The answer is the service's own status
and body, as is. What is Silos' and not the service's:
- `401` — no identity: the bearer header is missing or wrong;
- `404` with a sentence — that name is not signed for you (not visible, or
  delivered: then read it from your env as usual);
- `502` / `504` — the service could not be reached, or sent nothing for 30 s.

Redirects are returned, not followed — the credential never goes to another
host. Every signed call is recorded for the owner (who, method, host+path,
status — never the query or the body). Signing limits where the credential
goes, not what it can do: the service still allows everything that key
allows, and if a response quotes the credential you are reading it — treat
it as you would any secret, never repeat it.

**Need an entry signed, or signed differently?** Only the owner signs. Ask
on your task — `waitingOn` on `owner` with a `binding` naming the entry and
the exact shape your code consumes:
`"binding": { "entry": "<VAULT_ENTRY_NAME>", "baseUrl": "https://<host>",
"inject": { "header": "<header>", "format": "Bearer %s" } }` (`baseUrl` and
`inject` optional: `entry` alone links the wait to the entry). Never a
credential value — host, header and format only. The entry must already
exist in the Vault where you see it; a name that is not there is a broken
ask (Needs you says so) — ask for the credential first. Silos shows your
proposal to the owner in clear and prefills the Vault's editor; the owner's
save is the only write, and ANY save of that entry's binding clears your
wait with a note saying what was saved — which may differ from what you
proposed: verify with a first signed call before going on. One entry has
ONE binding: two consumers needing different shapes need two entries.

## Verify without revealing

The Vault is injected at process start. In THIS session the variable is
only present if it was stored before the session began; otherwise it
arrives in your next session (or your next beat) — say so, do not poll.

Check presence and shape, never the value:

```sh
test -n "$EXAMPLE_API_TOKEN" && echo "present (${#EXAMPLE_API_TOKEN} chars)" || echo missing
```

Never `echo $NAME`, `env`, `printenv`, `cat` a `.env`, or log a request
that carries the secret in the URL. Pass it to tools by name
(`-H "X-Api-Key: $EXAMPLE_API_TOKEN"`), and keep it out of
plan files, memory, notes, commit messages and status files.

## Files are not a vault

Do not create `~/.something.env`, `.env.local`, or config files holding
secrets "for now" — they outlive the task and sit outside the owner's
inventory. If a tool can only read a file, generate it at runtime from the
env var into a `0600` temp file and remove it when done.
