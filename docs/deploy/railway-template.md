# Railway template

Silos deploys on Railway as **one service running the released image**,
`ghcr.io/cheapestinference/silos:latest`, with **one volume** and no
database: the filesystem is the source of truth. Every GitHub release
publishes that image (`.github/workflows/release.yml`), and Railway's image
auto-updates move an instance to it — the template's service has
**Settings → Source → Image** set to it, with automatic updates on. A
service can still build the repo's `Dockerfile` instead (below: «Without a
template»); it then updates only when you redeploy.

The image (~1.2 GB) carries everything an instance needs: the built server and web UI,
the Silos plugin, `tmux` (the real console) and the **Claude Code CLI** pinned
to the release the Agent SDK is paired with (`CLAUDE_CODE_VERSION` build arg,
bumped together with `@anthropic-ai/claude-agent-sdk` in `server/package.json`).
Its `node_modules` is only the server workspace's production tree: the web UI
ships prebuilt (`web/dist`), and the Agent SDK's own per-platform `claude`
binaries (its optional packages) are left out — every SDK query runs the
`claude` on PATH (`server/src/harnesses/claude-code/binary.ts`).

## What the template declares

The repo carries **no Railway config file**. `railway.json` (Config as Code)
is deprecated and stops being read on **2026-12-01**, and its replacement,
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
(`.railway/railway.ts`), is desired state for one whole project (its volume's
region and size included) applied with `railway config apply` — not a file a
product shipped to any install can carry. The **template composer** is the
source of truth. Set these on the service there:

| Setting (composer → service)            | Value                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings → Source                       | **Image** `ghcr.io/cheapestinference/silos:latest`, automatic updates **on** (building from the repo instead: Builder **Dockerfile**, path `Dockerfile`) |
| Settings → Deploy → Healthcheck path    | **`/healthz`**                                                                                                                                           |
| Settings → Deploy → Healthcheck timeout | **120** s                                                                                                                                                |
| Settings → Deploy → Restart policy      | **Always**                                                                                                                                               |
| Settings → Deploy → Replicas            | **1** (the resident holds a lock on `/data`)                                                                                                             |
| Settings → Deploy → Serverless / sleep  | **off** (the resident runs automations with nobody watching)                                                                                             |
| Attach Volume → mount path              | **`/data`** (everything persistent lives there)                                                                                                          |
| Variables                               | `SILOS_TOKEN = ${{secret(32)}}`, `SILOS_OWNER_EMAIL` **required, empty — the deployer fills it** (below; `SILOS_ID_URL` comes preset in the image)       |
| Networking                              | a generated domain; the server reads Railway's `PORT` (`SILOS_HOST=0.0.0.0` in the image)                                                                |

**Without a template** (a plain `railway up` or a GitHub-linked service), the
service starts with Railway's defaults: set the same values **once** in the
service's Settings and attach the volume at `/data` before the first deploy.
They are stored on the service and every later deploy keeps them.

Whether a root `Dockerfile` wins over a service whose builder is Railpack is
not settled by the docs: [Dockerfiles](https://docs.railway.com/builds/dockerfiles)
says «When building a service, Railway will look for and use a `Dockerfile`
at the root of the source directory», but neither it nor
[Build configuration](https://docs.railway.com/builds/build-configuration) or
[Railpack](https://docs.railway.com/builds/railpack) states the precedence
against an explicit builder setting. Set the builder to Dockerfile explicitly.

### Variables

| Variable            | Required                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SILOS_TOKEN`       | recommended                   | The owner's access token. Template it as `${{secret(32)}}` so every deploy gets its own and it never appears in the deploy logs. Unset: Silos generates one on first boot and prints it in the logs (see below).                                                                                                                                                                                 |
| `SILOS_ID_URL`      | preset in the image           | The Silos ID broker (`https://auth.silosplatform.com`): turns on **Continue with Google** for this instance on whatever domain Railway gives it (see _Google login_ below). The image carries it as a default — a generated template cannot carry a literal default value, only `${{…}}` expressions. Set it empty to turn the broker off.                                                       |
| `SILOS_OWNER_EMAIL` | **yes** (with `SILOS_ID_URL`) | Who may sign in — one email or a comma list. In the composer it is a required variable with no default and the description «The email you will sign in with — a Google account, or any address (you get a sign-in link)», so whoever deploys types their own. Nobody else gets in; there is no "first login claims the instance". Unset: sign-in stays off and only the `?token=` link opens it. |
| `SILOS_PUBLIC_URL`  | no                            | This instance's public origin. Defaults to `https://$RAILWAY_PUBLIC_DOMAIN`, which Railway injects.                                                                                                                                                                                                                                                                                              |
| `PORT`              | no                            | Injected by Railway.                                                                                                                                                                                                                                                                                                                                                                             |

Nothing else. In particular **no `ANTHROPIC_API_KEY`**: Silos removes every
inherited `ANTHROPIC_*` / `CLAUDE_CODE_*` variable at boot
(`server/src/inherited-env.ts`) — which account an engine runs on is Silos'
decision, made inside the app (see _Logging into Claude_ below).

## The volume

Railway allows a single volume per service, so everything persistent lives
under `/data`:

| Path                      | Content                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `/data/home`              | `$HOME` of the process                                         |
| `/data/home/.claude/`     | Claude Code: login, settings, JSONL transcripts (the history)  |
| `/data/home/.claude.json` | Claude Code's account state                                    |
| `/data/home/.silos/`      | Silos: `token`, `agents.json`, automations, `trash/`, `cache/` |
| `/data/projects/`         | the agents' working folders (clone repos here)                 |

`SILOS_DATA_DIR` stays at its default (`$HOME/.silos`): the plugin's hooks read
`~/.silos` directly, so Silos' data must live under `HOME`.

The volume mounts as root. The entrypoint (`deploy/docker-entrypoint.sh`)
starts as root, takes ownership of `/data/home` and `/data/projects` (a full
`chown -R` only when something there is not already owned by `silos`) and drops
to the unprivileged `silos` user with `HOME=/data/home`.

### Backups

Railway does not back up the volume unless you ask it to. Turn it on once,
in the Silos service › **Backups**: a daily schedule (kept 6 days) is enough
for most instances; weekly and monthly schedules keep copies longer. Since
everything Silos and Claude Code keep is under `/data`, a volume backup is a
full backup — restoring one brings back agents, conversations, the Claude
login, projects and installed packages.

## What agents can do in the container

A Silos container is the agents' own server, not a sandbox: they run as the
`silos` user with **passwordless sudo** (`/etc/sudoers.d/silos`). They stay
non-root by default because Claude Code refuses
`--dangerously-skip-permissions` as root (it checks the uid, and only lets it
through with `IS_SANDBOX=1`), and the consoles run in bypass mode.

The image already carries the basics: `gcc`/`g++`/`make`
(build-essential), `python3` with `pip`, `venv`, `pipx` and `uv`, `git`,
`curl`, `wget`, `jq`, `zip`/`unzip`, `ssh`, `rsync`, `sqlite3`, `rg`, `fd`,
`file`, `less`, `nano`, `ip`, `nc`.

Only `/data` survives a redeploy, so what an agent installs is kept like this:

| How it was installed                                                                    | Where it lands                                                       | After a redeploy                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `npm i -g`, `pip install` (user site), `pipx`, `uv tool`, `go install`, `cargo install` | `/data/home/.local`, `~/go`, `~/.cargo` (on the volume, on `PATH`)   | still there                           |
| `sudo apt-get install X` / `sudo apt install X`                                         | the system; the name goes to `/data/home/.silos/system-packages.txt` | reinstalled at boot                   |
| anything else as root (a service, a file in `/etc`…)                                    | the system                                                           | put it in `/data/home/.silos/boot.sh` |

At boot the entrypoint, as root and in the background (the healthcheck never
waits for it), reinstalls the remembered packages (`apt-get update` +
`install`, up to 10 min; one bad name does not cost the rest) and then runs
`boot.sh` (up to 5 min). Both are non-fatal and log to
`/data/home/.silos/boot.log`. A successful `sudo apt-get remove`/`purge`
drops the name from the list; you can also edit the list by hand (one name per
line, `#` comments). Packages may still be installing during the first minute
after a redeploy. The user-level bin dirs come after the system ones on
`PATH`, so the image's pinned `claude` and `opencode` are always the ones that
run.

**Security.** A Silos container is single-tenant: one owner, their agents.
Agents have root inside it, by design; the isolation boundary is the
container/VM (Railway's, or your Docker host's), not anything inside it. Do
not put anything in the container, or on its volume, that its agents should
not be able to read. Territory still keeps agents out of each other's way
inside Claude Code, but it is not a security boundary against an agent with
sudo.

## First boot: the token

- With `SILOS_TOKEN` set (the template's `${{secret(32)}}`), that is the
  token (written to `/data/home/.silos/token` too; changing the variable
  rotates it). The boot log says only `Silos at http://0.0.0.0:<port>/ (token
from SILOS_TOKEN)` — the value is never echoed, and it is removed from the
  environment at boot, so no console or agent process inherits it
  (`server/src/env.ts`). Read it in the service's **Variables** tab.
- Without it, Silos generates one into `/data/home/.silos/token` and prints the
  ready link in the deploy logs: `Silos at http://0.0.0.0:<port>/?token=<token>`.
  Read it there, or from the service shell: `cat /data/home/.silos/token`.

Open `https://<your-domain>/?token=<token>` once; the browser keeps it.

**Auth is per request.** Railway's edge always adds `X-Forwarded-*`, so every
request from the Internet is remote and needs the token (or a login session).
A request is treated as the local owner only when the socket peer is loopback,
the `Host` is loopback and no forwarding header is present — i.e. a process
inside the container. Other services on the project's private network reach
the container directly but are not loopback peers, so they need the token too.

## Google login (Silos ID)

Firebase signs in only on domains authorized in its console, with no
wildcards — a fresh `*.up.railway.app` domain is never one of them. Silos ID
is the way around it: one broker on one authorized domain runs the Google
sign-in for every instance.

1. The image presets `SILOS_ID_URL` (the broker); the template asks for
   `SILOS_OWNER_EMAIL`.
2. On boot the instance registers its public origin with the broker
   (`POST /register`, idempotent) and keeps the id in
   `/data/home/.silos/silos-id.json`.
3. **Continue with Google** → the instance mints a single-use state (bound to
   the browser by a cookie) → the broker's page runs Google (redirect or
   popup, below) → the broker
   sends the browser back to the instance's REGISTERED origin with a pass
   (RS256, 120 s, for this instance only) → the instance checks it against
   the broker's `/jwks` and its own `SILOS_OWNER_EMAIL`, and opens the usual
   7-day session.

**One page, one choice.** The way in is picked on the instance's own login
page — «Continue with Google», or «Use email instead» and an address — and
travels to the broker (`method`, `email`), which carries it out without a
second screen: the email link is sent at once («Check your inbox»), and
Google opens by redirect when the broker hosts Firebase's auth handler.
For that, once:

1. Google Cloud Console › APIs & Services › Credentials › the project's
   «Web client (auto created by Google Service)» › Authorized redirect URIs
   › add `https://<broker domain>/__/auth/handler`.
2. Set `SILOS_ID_FIREBASE_AUTH_DOMAIN=<broker domain>` on the broker (a
   Worker variable in `silos-id/wrangler.toml`). It passes Firebase's `/__/auth/*` and `/__/firebase/init.json` through from
   `<project>.firebaseapp.com`, so the redirect never depends on
   third-party storage (Safari, Chrome without third-party cookies).

Without step 2 Google still works — the broker's page shows its button and
opens a popup (one more click). Step 2 without step 1 breaks Google sign-in
(`redirect_uri_mismatch`): do 1 first.

**Email instead of Google** («Use email instead» under the Google button
on the instance's page): the broker sends a Firebase email link
(passwordless) that returns to the same `/login` attempt; the resulting ID
token goes through the same `/login/exchange`, so nothing else changes —
the email must be verified (it is, by the link) and the instance still
checks the browser cookie and `SILOS_OWNER_EMAIL`. The link only works in
the browser where the sign-in started. To enable it: Firebase Console ›
Authentication › Sign-in method › Email/Password › «Email link
(passwordless sign-in)». The broker's domain must be in Authorized domains
(it already is, for Google).

**Privacy**: the sign-in passes through Silos ID. The broker stores the
instance's URL and sees the email of whoever signs in (it stores no account);
the decision of who gets in stays in the instance.

The `?token=` link keeps working with Silos ID on — it is the escape hatch.

Silos ID is the only remote sign-in: an instance never runs a Firebase
project of its own (a `firebase.json` left in the data folder by an older
version is simply not read).

### Without a service manager: `server.env`

On Railway the variables above live in the service. A server started by hand
(or with `npm run dev`) has nothing to keep them across restarts, so the
Silos ID settings can also live in `server.env` in the data folder
(`~/.silos/server.env`, or `$SILOS_DATA_DIR/server.env`), read once at
boot — restart after editing it:

```sh
# ~/.silos/server.env — Silos ID for https://silos.example.com
SILOS_ID_URL=https://auth.silosplatform.com
SILOS_PUBLIC_URL=https://silos.example.com
SILOS_OWNER_EMAIL="owner@example.com, teammate@example.com"
```

One `KEY=VALUE` per line; blank lines and lines starting with `#` are
skipped; a value may be wrapped in matching `"…"` or `'…'` (taken literally).
It holds only `SILOS_ID_URL`, `SILOS_PUBLIC_URL` and `SILOS_OWNER_EMAIL` — any
other key, and any line that is not `KEY=VALUE`, is ignored and named (keys
only) in one warning at boot. A variable set in the real environment wins
over the file. The values are never copied into the server's environment,
so no agent or command it starts inherits them, and the agents' fence
denies the file.

### The broker

The broker is a Cloudflare Worker (`silos-id/` in this repo), not part of
the Silos image: it serves only `/register`, `/login`, `/login/exchange`,
`/jwks`, `/healthz` and Firebase's `/__/auth/*` pass-through. The official one answers at
`https://auth.silosplatform.com`. Running your own (your Firebase project,
your domain, Workers free tier) takes a KV namespace, one secret and three
variables — the steps are in `silos-id/README.md`; then point your
instances' `SILOS_ID_URL` at it.

## Logging into Claude

The image has the `claude` CLI but no login: that happens once, from the Silos
UI, the same way as on a laptop.

1. Open Silos and start a conversation with an agent, in the **real console**.
2. Claude Code starts in that console and, with no account yet, walks you
   through its own login (or type `/login`). Choose the Claude subscription
   (or Console API billing) — it prints a URL.
3. Open the URL in your browser, approve, and paste the code back into the
   console.

The login is written to `/data/home/.claude*` on the volume, so it survives
redeploys. Every later console and chat turn uses it.

The CLI's auto-updater is off (`DISABLE_AUTOUPDATER=1`): it is installed
root-owned in the image, and a new Claude Code release ships as a new image
with the paired SDK.

## Verify an image locally

```bash
docker build -t silos .
mkdir -p /tmp/silos-vol
docker run -d --name silos -e PORT=3344 -p 127.0.0.1:3344:3344 -v /tmp/silos-vol:/data silos
curl -s http://127.0.0.1:3344/healthz                                  # {"ok":true}
docker exec silos cat /data/home/.silos/token
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 1.2.3.4' http://127.0.0.1:3344/api/agents            # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 1.2.3.4' "http://127.0.0.1:3344/api/agents?token=$T"  # 200
docker exec silos claude --version
```

## Typical problems

- **Healthcheck fails at start**: look at the logs. `could not listen on`
  means `SILOS_HOST` was overridden to `127.0.0.1`; remove it.
- **Deploy refuses to start, asks for a volume**: add one mounted at `/data`.
- **Data gone after a redeploy**: the volume is not on `/data`.
- **A redeploy has a short downtime**: a service with a volume cannot run two
  deployments at once; Railway stops the old one before the new one starts.
