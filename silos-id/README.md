# Silos ID

One Google sign-in for any Silos instance on any domain. Firebase only signs
in on domains authorized in its console, with no wildcards, so an instance
on a fresh domain cannot run the popup itself. Silos ID is the one
authorized domain: it runs Google (by redirect or popup) or a Firebase
email link — whichever the owner picked on the instance's own login page —, verifies
Firebase's ID token, and sends the browser back to the instance's
registered origin with a pass — a 120-second RS256 JWT for that instance
only. The instance checks the pass against `/jwks`, against the sign-in it
started in that browser, and against its own `SILOS_OWNER_EMAIL`. Silos ID
decides nothing about who gets in, and stores no account: only the origins
of the instances that registered, and their usage (below).

The official broker answers at `https://auth.silosplatform.com`. This
folder is that broker, a Cloudflare Worker that fits the Workers free tier.
Running your own takes about ten minutes.

| Route                                          | What                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /register` `{url}`                       | an instance's public origin → `{instanceId}` (idempotent; https, or http on loopback)                                                                                                                                                                              |
| `GET /login?instance&state[&method&email]`     | the sign-in page. `method=email&email=…`: the link is sent at once; `method=google`: Google by redirect when `SILOS_ID_FIREBASE_AUTH_DOMAIN` is this broker's own host, else the Google button (popup); no method, or an address that isn't one: both ways offered |
| `GET /__/auth/*`, `GET /__/firebase/init.json` | Firebase's auth handler, passed through from `<project>.firebaseapp.com` (only these paths, only GET; only `content-type`, `cache-control`, CSP, `x-frame-options`, `referrer-policy`, `location` come back) — what the redirect needs on the broker's domain      |
| `POST /login/exchange`                         | `{idToken, instance, state}` → `{redirect}` to the registered origin's `/api/auth/silos-id/callback`                                                                                                                                                               |
| `GET /jwks`                                    | the public key the passes are signed with                                                                                                                                                                                                                          |
| `GET /healthz`                                 | `{ok: true}`                                                                                                                                                                                                                                                       |

## Run your own

You need a Cloudflare account with your domain's zone on it, and a
Firebase project.

1. **Firebase.** In the Firebase console of your project: Authentication ›
   Sign-in method › enable **Google**, and **Email/Password** with «Email
   link (passwordless sign-in)». Authentication › Settings › Authorized
   domains › add the broker's domain (e.g. `auth.example.com`). Project
   settings › General › your web app gives the API key and project id.
2. **Log in to Cloudflare** (from this folder):
   ```sh
   cd silos-id
   npx wrangler@4.159.0 login
   ```
3. **The registry.** Create the KV namespace and paste the id it prints
   into `wrangler.toml` (`[[kv_namespaces]]`, binding `INSTANCES`):
   ```sh
   npx wrangler@4.159.0 kv namespace create INSTANCES
   ```
4. **The variables.** In `wrangler.toml`: `SILOS_ID_FIREBASE_API_KEY`,
   `SILOS_ID_FIREBASE_PROJECT`, `SILOS_ID_PUBLIC_URL` (the broker's own
   origin, which goes into every pass as `iss`; the Node broker called it
   `SILOS_PUBLIC_URL`), and the domain in `routes` (a custom domain:
   Cloudflare creates the DNS record and the certificate).
   `SILOS_ID_FIREBASE_AUTH_DOMAIN` (default `<project>.firebaseapp.com`)
   set to the broker's own host makes Google sign in by redirect, with no
   click and no third-party storage. Do this first: Google Cloud Console ›
   APIs & Services › Credentials › the project's «Web client (auto created
   by Google Service)» › Authorized redirect URIs › add
   `https://<broker domain>/__/auth/handler` — without it the redirect
   fails with `redirect_uri_mismatch`. Left at the default, Google works by
   button and popup.
5. **The signing key**, a Worker secret that never touches disk:
   ```sh
   node scripts/gen-key.mjs | npx wrangler@4.159.0 secret put SILOS_ID_PRIVATE_KEY
   ```
6. **Deploy:**
   ```sh
   npm run deploy
   ```
7. **Check:** `curl https://auth.example.com/healthz` answers `{"ok":true}`
   and `/jwks` lists one key. A misconfigured broker answers every other
   route with a 500 that names what is missing.
8. **Point your instances at it:** `SILOS_ID_URL=https://auth.example.com`
   (plus `SILOS_OWNER_EMAIL`, and `SILOS_PUBLIC_URL` off Railway). Each
   instance registers on boot.

`npm run dev` serves the Worker locally (`wrangler dev`, with a local KV).
Put the local values in a `.dev.vars` file, which git ignores:
`SILOS_ID_PRIVATE_KEY="<the PEM>"`.

## Operating it

- **Rotating the key:** run step 5 again. Passes live 120 seconds and
  instances refetch `/jwks` when they see an unknown `kid`, so a rotation
  costs at most a sign-in that was in flight.
- **Free tier:** a registration writes to KV only for an origin it has not
  seen (two writes); a re-registration on boot, a sign-in page and an
  exchange cost reads only. Workers KV's free tier allows 1,000 writes a
  day, which is 500 new instances a day.
- **Rate limits:** `/register` 20 and `/login/exchange` 10 per minute per
  IP, counted in each isolate's memory. That is best effort: Cloudflare can
  run several isolates. Add a Cloudflare rate-limiting rule on the route
  if you need a hard limit.
- **Look:** the page carries the house tokens and the tricorn inline, and
  takes Source Serif 4 and Inter from Google Fonts (Georgia and the system
  face if they don't load). No static assets to deploy.
- **Privacy:** KV holds `origin:<origin>` → id and `id:<id>` → the
  instance's record: `{origin, registeredAt}`, its reporting key, and its
  usage — boots (`boots`, `lastBootAt`), passes issued (`logins`,
  `lastLoginAt`) and, per UTC day for the last 90 days, the emails that
  signed in with their pass count, plus what the instance reported (the
  hours it was open, turns started by its owner and by Silos, its version).
  Tell the people who sign in through your broker. Counts are best effort —
  KV is read then written, so two writes racing may lose one.

## Usage

`https://<your broker>/stats` — sign in with Google; only the emails in
`SILOS_ID_ADMIN_EMAILS` (a Worker variable, comma-separated; unset = nobody)
see it. Per instance: version, days active this week, hours open per active
day, turns this week (yours · Silos'), people in 30 days, last sign-in; open
a row for its last 30 days. Then everyone who signed in.

- **Reports are signed.** The first registration that asks (`reports:
true`, what current instances send) gets the instance's key, once; its
  reports carry `x-silos-signature` (HMAC-SHA256 of the body). Nobody can
  report for an instance whose key they don't hold.
- **An operator's own report can't be proven** — they run the code. A row
  is flagged _unverified_ when it reported activity this week but no pass
  was issued to it for 8 days (a session lasts 7). Days are capped (24
  hours, `MAX_TURNS_PER_DAY` turns), so no row inflates the totals far.
- **A lost key** (the instance lost its data dir, or someone else asked
  first): the row says _not reporting_. Delete the `key` field from its
  `id:<id>` record in KV and the instance gets a new one at its next boot.

## Tests

`npm test -w silos-id` (from the repo root) runs the Worker in Node with
WebCrypto, a memory KV and a fake Google, and ends with the instance's own
verifier (`server/src/silos-id.ts`) accepting the Worker's pass.
