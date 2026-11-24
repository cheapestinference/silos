# Security policy

Silos runs coding agents with access to your files, your credentials and
your Claude account, and its transcripts contain secrets. We take reports
seriously.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:
the repository's **Security** tab › **Report a vulnerability**.

Please include what an attacker can do, the steps to reproduce, the version
(commit or image tag) and your deployment (local, tunnel, Railway, VPS).
We acknowledge within a few days, keep you posted while we fix it, and credit
you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest `main` (and the image built from it) receives fixes.

## Scope

In scope, for example:

- Reaching the API, the consoles or the WebSocket without a token or session
  (including through tunnels, proxies, forged `Host` or encoded paths).
- An agent escaping its territory fence, reading another agent's private
  files or the vault, or forging another agent's identity.
- The webhook trigger, `POST /api/hooks/:id`: the one write route that
  takes no token or session — its automation's secret (`x-hook-secret`) is
  its whole authentication. Firing a run without the secret, learning
  another automation's secret, or a payload escaping its untrusted-data
  fence are in scope.
- Silos ID: a pass accepted for the wrong instance, replayed, or minted for
  an email that is not the owner's; an open redirect at the broker.
- Secrets leaking into logs, transcripts Silos writes, error messages or the
  UI.

Out of scope: what an agent you started does with the permissions you gave
it; agents having root inside the Silos container (passwordless sudo is by
design: a container is single-tenant and its isolation is the container/VM
boundary — see docs/deploy/railway-template.md); vulnerabilities in Claude Code, OpenCode or their providers (report those
upstream); running Silos bound to `0.0.0.0` without a token, which the
documentation warns against.

## What holds, and what doesn't

Silos is a console for agents that run as **your** Unix user, with your
files. It narrows what they do; it is not a sandbox. Per surface:

| Surface                      | What holds it                                                                                                                                                                                                                           | What doesn't                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The web and the API          | Bound to `127.0.0.1`. A request that came through a tunnel or proxy (forwarding headers) needs a session or the token. Every write needs an identity: the owner's token or session, or an agent's own bearer.                           | Anyone with a shell as your user can read `~/.silos/token`. Binding `0.0.0.0` without a token is unsupported.                                                                                                   |
| An agent's identity          | Each agent has its own bearer token. A write with another agent's token is refused, and every write names the turn it comes from.                                                                                                       | An unfenced agent can read the owner token from disk and act as the owner.                                                                                                                                      |
| Territory (the fence)        | A per-agent `permissions.deny` that the engine enforces on its file tools and on direct Bash. It covers Silos' state, other agents' private files, credential files, `/proc/*/environ`, and every file the engine loads behaviour from. | An interpreter (`python -c`, `node -e`) run from Bash is not covered: it runs as your user and can read or write anything you can. Real isolation per agent (a separate Unix user or a container) is not built. |
| Egress                       | An agent on an allowlist goes through a local proxy that refuses hosts outside its list and private addresses, and logs every refusal.                                                                                                  | A process that ignores `HTTP(S)_PROXY` is not stopped. An agent left `open` goes anywhere.                                                                                                                      |
| The seal                     | Silos' own data files have one declared writer. A change made behind Silos' back is detected and not served, and the loaded plugin code is watched.                                                                                     | It detects changes; it does not prevent them. An engine's auto-update and a hand-made version bump look the same.                                                                                               |
| Secrets                      | The Vault reaches agents as environment variables at launch, through a `0600` file that is removed after it is read. Secrets never go on a command line.                                                                                | Transcripts are the engine's and contain whatever an agent printed. Treat `~/.claude` and `~/.silos` as a password store.                                                                                       |
| Webhooks                     | `POST /api/hooks/:id` needs its automation's secret. The body reaches the agent marked as untrusted data.                                                                                                                               | Marking text as untrusted is a prompt convention, not a boundary. Give a webhook automation's agent only what it needs.                                                                                         |
| A hosted container (Railway) | One owner per container. Its isolation is the container or VM boundary.                                                                                                                                                                 | Agents have root inside the container (passwordless sudo, by design).                                                                                                                                           |

## Hardening notes for operators

- Keep the default binding (`127.0.0.1`) and reach Silos through a tunnel,
  or deploy with `SILOS_TOKEN` set and remote sign-in enabled.
- `~/.silos` is created `0700`; keep it that way and back it up as you would
  a password store.
- Turn on Territory for agents that do not need to see each other's files.
