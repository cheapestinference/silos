# Silos — one image for the Railway template and any VPS with Docker
# (docker compose). See docs/deploy/railway-template.md.
#
# State: EVERYTHING lives on ONE volume mounted at /data (Railway allows a
# single volume per service). HOME=/data/home, so ~/.claude (Claude Code's
# login, settings and JSONL transcripts) and ~/.silos (agents, token,
# automations) both sit on it; new projects are born in ~/Silos (/data/home/Silos,
# the Projects folder — changed in Settings › Territory).
# Without a volume on /data every redeploy starts from zero.

# ---------- build: web (Vite) + server (tsc) + native addons (node-pty) ----------
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# plugin-opencode is a workspace of the root package.json: npm ci needs its manifest
COPY plugin-opencode/package.json plugin-opencode/
RUN npm ci
COPY server server
COPY web web
# web/vite.config.ts imports ../scripts/yield-cpu (test-run CPU yielding)
COPY scripts/yield-cpu.ts scripts/
# plain vite build (without the `build` script's `tsc --noEmit`, which also
# checks the tests): the image carries no tests and CI does the typecheck.
RUN npm exec -w web -- vite build && npm run build -w server

# ---------- deps: only what `node server/dist/index.js` loads ----------
# web/dist is prebuilt above, so the runtime needs no web dependency (react,
# lucide…), no devDependency and no plugin-opencode tooling: only the
# server workspace's production tree.
# --omit=optional drops the Agent SDK's per-platform `claude` binaries
# (@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl], ~730 MB): Silos never
# runs them — every SDK query gets `pathToClaudeCodeExecutable` = the `claude`
# on PATH, and without one it refuses instead of falling back
# (harnesses/claude-code/binary.ts withClaudeExecutable). They are the only
# optional packages in the server's production tree.
# node-pty compiles its addon here (build/Release, loaded first); its bundled
# win32/darwin prebuilds are never read on Linux.
FROM build AS deps
RUN rm -rf node_modules server/node_modules web/node_modules plugin-opencode/node_modules \
  && npm ci --omit=dev --omit=optional --workspace server \
  && rm -rf node_modules/node-pty/prebuilds/win32-* node_modules/node-pty/prebuilds/darwin-* \
  && npm cache clean --force \
  && test -f node_modules/node-pty/build/Release/pty.node \
  && test ! -e node_modules/@anthropic-ai/claude-agent-sdk-linux-x64

# ---------- runtime ----------
FROM node:22-bookworm-slim
# tmux: the real console under the chat (server/src/terminal-service.ts).
# git/bash/curl/ca-certificates: what Claude Code agents expect to find on
# any machine. python3: the plugin's hooks (plugin/hooks/*.py and the
# one-liners in session-start.sh/pre-cron.sh) — without it the briefing is
# not injected and the CronCreate fence lets everything through.
# jq: the plugin/skills/vault-secrets recipe builds its JSON with it.
# gosu: start as root so the entrypoint can take ownership of the volume,
# then drop to an unprivileged user.
# sudo + the toolchain below: agents are root-capable in their container —
# it is their own server, single-tenant; the isolation boundary is the
# container/VM, not a sandbox inside it (docs/deploy/railway-template.md
# «What agents can do in the container»). They still run as `silos`, never
# root: Claude Code refuses --dangerously-skip-permissions as root unless
# IS_SANDBOX=1, and the consoles run in bypass mode.
# The toolchain is what agents would otherwise install first: compilers,
# Python packaging, archives, network and file basics, search.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git bash curl ca-certificates procps python3 jq gosu \
    sudo build-essential python3-pip python3-venv pipx unzip zip wget \
    openssh-client rsync less nano iproute2 netcat-openbsd sqlite3 \
    ripgrep fd-find file \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && useradd --home-dir /data/home --no-create-home --uid 1001 --shell /bin/bash silos \
  && echo 'silos ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/silos \
  && chmod 0440 /etc/sudoers.d/silos \
  && visudo -cq
# uv (Python projects and tools), pinned, from Astral's official image.
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/
# `sudo apt-get install X` / `sudo apt install X` are remembered on the volume
# (~/.silos/system-packages.txt) and reinstalled at boot by the entrypoint:
# this shim sits ahead of /usr/bin on root's and sudo's secure_path.
COPY deploy/apt-remember.sh /usr/local/sbin/apt-get
RUN chmod 0755 /usr/local/sbin/apt-get && ln -s apt-get /usr/local/sbin/apt
# Claude Code CLI: consoles AND chat turns run the `claude` on PATH (never the
# Agent SDK's bundled binary — harnesses/claude-code/binary.ts). Pinned to the
# release the SDK in server/package.json is paired with (0.3.N <-> 2.1.N);
# bump both together. Installed globally (/usr/local/bin, root-owned), so the
# in-place auto-updater is off — a new version ships as a new image.
ARG CLAUDE_CODE_VERSION=2.1.330
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && claude --version
# OpenCode CLI: the second engine, offered at creation beside Claude Code. It
# costs disk only — nothing runs until an agent on OpenCode starts a turn.
# Pinned at or above OPENCODE_MINIMUM (harnesses/opencode/version.ts); the
# package's postinstall copies the platform binary into bin/, so the
# per-platform packages it pulled (two of ~200 MB on x64) are dropped.
# Root-owned like claude: `opencode upgrade` is off, a new version ships as
# a new image.
ARG OPENCODE_VERSION=1.19.6
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-* \
  && npm cache clean --force \
  && opencode --version
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# plugin/ ships in the image: index.ts resolves pluginSkillsDir to /app/plugin/skills
# (two levels up from server/dist), which the "Install autonomy skills" route and
# the SessionStart briefing hook read. Without it that feature 500s in exactly the
# container deploys the docs treat as primary (Railway, compose).
COPY plugin ./plugin
# plugin-opencode/ next to it: launch.ts loads /app/plugin-opencode/silos.ts into every
# OpenCode process Silos starts (OPENCODE_CONFIG_CONTENT). The `opencode` binary is
# installed below, so the first run can offer both engines.
COPY plugin-opencode/silos.ts plugin-opencode/package.json plugin-opencode/README.md ./plugin-opencode/
# docs/standard/ ships too: the silo kernel validates manifests against
# docs/standard/silo.schema.json at runtime (manifest.ts resolves it three
# levels up from server/dist/silos). Without it every silo reads as `error`
# in exactly these deploys (.dockerignore re-includes only this subfolder).
COPY docs/standard ./docs/standard
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown silos:silos /data \
  && printf '%s\n' 'case ":$PATH:" in *:/data/home/.local/bin:*) ;; *) PATH="$PATH:/data/home/.local/bin:/data/home/go/bin:/data/home/.cargo/bin" ;; esac' >/etc/profile.d/silos-path.sh

# /data = the single volume; HOME lives inside it so ~/.claude and ~/.silos
# persist. SILOS_DATA_DIR stays at its default ($HOME/.silos): the plugin's
# hooks and some server paths read ~/.silos directly, so it must stay under HOME.
# User-level installs land on the volume (~/.local, ~/go, ~/.cargo): npm -g,
# `pip install` (user site; PIP_BREAK_SYSTEM_PACKAGES lifts Debian's
# externally-managed refusal), pipx and `uv tool` survive a redeploy. Their
# bin dirs come AFTER the system ones, so the pinned `claude`/`opencode`
# always win; /etc/profile.d repeats the PATH for login shells.
# SILOS_ID_URL defaults to the hosted Silos ID broker so «Continue with
# Google» needs only SILOS_OWNER_EMAIL; without that email, sign-in stays
# off (silos-id.ts). Set SILOS_ID_URL= (empty) to turn the broker off.
ENV HOME=/data/home \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/data/home/.local/bin:/data/home/go/bin:/data/home/.cargo/bin \
    NPM_CONFIG_PREFIX=/data/home/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    GOPATH=/data/home/go \
    CARGO_HOME=/data/home/.cargo \
    RUSTUP_HOME=/data/home/.rustup \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    SILOS_HOST=0.0.0.0 \
    SILOS_ID_URL=https://auth.silosplatform.com \
    PORT=3210 \
    NODE_ENV=production \
    SHELL=/bin/bash
# no VOLUME: Railway refuses the instruction (its own Volumes mount /data); docker run -v / compose declare it
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3210}/healthz" || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
