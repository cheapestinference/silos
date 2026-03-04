# Silos Dashboard

> Open source dashboard for [OpenClaw](https://openclaw.ai) — connect, monitor and control your AI agents across all your channels.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/cheapestinference/silos)](https://github.com/cheapestinference/silos/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-silos-blue)](https://github.com/cheapestinference/silos/pkgs/container/silos)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## What is Silos Dashboard?

Silos Dashboard is a modern, multilingual web UI that connects to an **OpenClaw gateway** and gives you a complete interface to manage your AI agent deployments. It is designed to be self-hosted, lightweight and easy to extend.

[OpenClaw](https://openclaw.ai) is an open-source AI agent framework. The gateway is the local service that Silos Dashboard communicates with over WebSocket and HTTP to read state, trigger actions and receive real-time updates.

**Key capabilities:**

- 🤖 **Agent management** — create, configure and monitor OpenClaw agents
- 💬 **Multi-channel sessions** — WhatsApp, Telegram, Discord and more
- 📋 **Task & session tracking** — Kanban view, session detail, activity log
- ⏱ **Cron jobs** — schedule automated agent tasks
- 🌐 **i18n** — English, Spanish, French and German out of the box
- 🌗 **Theme** — respects your OS dark/light preference, fully toggleable
- 🔌 **Gateway-first** — talks to any OpenClaw gateway instance via configurable URL

---

## Architecture

```
┌─────────────────────────────┐
│       Silos Dashboard       │  ← this repo (React / TypeScript / Vite)
│        (browser SPA)        │
└────────────┬────────────────┘
             │  WebSocket + REST
             ▼
┌─────────────────────────────┐
│      OpenClaw Gateway       │  ← runs locally or on your server
│  (default: localhost:18789) │
└─────────────────────────────┘
             │
             ▼
     OpenClaw AI Agents
```

The dashboard is a pure frontend — it has no backend of its own. All state lives in the OpenClaw gateway.

---

## Getting Started

### Prerequisites

- Node.js 20+
- A running [OpenClaw](https://openclaw.ai) instance with its gateway exposed

### Development

```bash
git clone https://github.com/cheapestinference/silos.git
cd silos
npm install
npm run dev
```

The dev server starts at `http://localhost:5173`. By default it connects to the gateway at `http://localhost:18789`. You can override this in the Settings panel inside the dashboard.

### Production build

```bash
npm run build
# Output in ./dist
```

---

## Docker

Every release is published as a Docker image to the GitHub Container Registry.

```bash
docker pull ghcr.io/cheapestinference/silos:latest
```

Run it:

```bash
docker run -p 8080:80 ghcr.io/cheapestinference/silos:latest
```

Available tags:

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `v1.2.3` | Specific version |
| `main` | Built from the tip of main (may be unstable) |

---

## Releases

Releases follow [Semantic Versioning](https://semver.org/). Each release is:

- Published on [GitHub Releases](https://github.com/cheapestinference/silos/releases) with a changelog entry
- Built and pushed as a Docker image to [ghcr.io/cheapestinference/silos](https://github.com/cheapestinference/silos/pkgs/container/silos)

---

## Configuration

The gateway URL is configurable at runtime from the Settings panel — no rebuild required. You can also set it during development via a `.env` file:

```env
VITE_GATEWAY_URL=http://localhost:18789
```

---

## Project Structure

```
silos/
├── src/
│   ├── components/        # UI components (agents, sessions, cron, layout…)
│   ├── store/             # Zustand global store
│   ├── hooks/             # React hooks
│   ├── types/             # TypeScript types
│   ├── i18n/              # Translations (en, es, fr, de)
│   └── lib/               # Utilities and gateway client
├── public/
├── index.html
└── vite.config.ts
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

**Quick start:**

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and make sure `npm run build` passes
4. Open a PR against `main`

---

## Related projects

| Project | Description |
|---------|-------------|
| [OpenClaw](https://openclaw.ai) | The open-source AI agent framework this dashboard connects to |
| [Silos Platform](https://github.com/cheapestinference/silosplatform) | Managed hosting platform for OpenClaw |

---

## License

[MIT](LICENSE) © [cheapestinference](https://github.com/cheapestinference)
