# Silos Dashboard

> Open-source web dashboard for [OpenClaw](https://openclaw.ai) AI agents — manage agents, chat, skills, channels (WhatsApp, Telegram, Discord), cron jobs, and more from a single interface.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/cheapestinference/silos)](https://github.com/cheapestinference/silos/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-silos-blue)](https://github.com/cheapestinference/silos/pkgs/container/silos)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

https://github.com/user-attachments/assets/86835726-f840-40e3-8847-cc33dee63ad4

## Screenshots

| Home | Chat | Channels |
|------|------|----------|
| ![Home](docs/screenshots/silos-home.png) | ![Chat](docs/screenshots/chat-view.png) | ![Channels](docs/screenshots/channels-settings.png) |

---

## Don't want to self-host?

**[Silos Platform](https://silosplatform.com)** — Managed OpenClaw hosting with flat-rate AI included. Your agent running 24/7 on its own server, from $29/mo. No setup, no maintenance.

---

## Features

### Agent Management
- Create, configure and monitor multiple OpenClaw agents
- Per-agent model selection (GPT, Claude, DeepSeek, Mistral, any provider)
- Brain editor — edit SOUL.md, IDENTITY.md, MEMORY.md, BOOTSTRAP.md, HEARTBEAT.md directly
- Workspace file browser — full CRUD on agent workspace files and folders
- Tool permissions — enable/disable tool groups globally or per agent
- Agent-to-agent delegation rules
- Knowledge base management with RAG indexing

### Skills
- Browse and install skills from [ClawHub](https://clawhub.ai/) marketplace
- View skill details, stats, changelog, security scans
- Enable/disable skills per agent
- Built-in skill catalog organized by category

### Chat & Sessions
- Live chat with real-time streaming
- Markdown rendering with syntax-highlighted code blocks
- Tool call visualization — see what the agent is doing as it runs tools
- Session intelligence panel — active agents, token usage, context window size
- Per-session model override
- Message queue and retry
- Subagent parent-child session hierarchy

### Tasks
- Kanban board — To Do, In Progress, Done columns
- Filter by running, completed, or failed
- Task detail with full conversation transcript, tokens, duration
- Stop/abort running tasks

### Cron Jobs
- Create one-time, interval, or cron-expression schedules
- System event or agent turn payloads
- Run manually, enable/disable, view run history
- Last run status, duration, next run time

### Channels
- Connect WhatsApp, Telegram, Discord, Slack
- QR code pairing for WhatsApp
- Per-channel connection status and account details
- Default agent routing

### Settings
- **Model Providers** — add/edit API keys, base URLs, test connections, see available models
- **Channels** — manage all messaging platform connections
- **Tools** — global tool group toggles, loop detection
- **Skills** — manage installed skills
- **Gateway** — connection URL and auth token
- **Appearance** — dark/light theme, language selector (EN, ES, FR, DE)

### Analytics & Monitoring
- Dashboard stats — agents, sessions, tokens, active tasks, cron jobs
- Token activity chart (14-day bar chart with input/output breakdown)
- Per-session token tracking
- Context window utilization display
- Gateway connection status with auto-reconnect

### UX
- Command palette (Cmd/Ctrl+K) — fuzzy search across pages, agents, sessions
- Keyboard shortcuts throughout
- Dark/light theme with OS preference detection
- 4 languages — English, Spanish, French, German
- Responsive layout
- Real-time WebSocket updates

---

## Quick Start

### Docker (recommended)

```bash
docker pull ghcr.io/cheapestinference/silos:latest

docker run -p 3001:3001 \
  -e GATEWAY_TOKEN=your-token \
  -e OWNER_EMAIL=you@example.com \
  ghcr.io/cheapestinference/silos:latest
```

Open `http://localhost:3001` and configure the gateway URL in Settings.

### From source

```bash
git clone https://github.com/cheapestinference/silos.git
cd silos
cp .env.example .env  # fill in your config
npm install
npm run dev
```

Dev server starts at `http://localhost:3001`.

### Prerequisites

- Node.js 20+ (from source only)
- A running [OpenClaw](https://openclaw.ai) instance with its gateway exposed

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

Connects to any OpenClaw gateway instance. All state lives in the gateway.

---

## Tech Stack

| | |
|---|---|
| **Frontend** | React 19 · TypeScript · Vite · Tailwind CSS |
| **State** | Zustand |
| **Auth** | Firebase Auth (Google OAuth + email/password) |
| **Charts** | Recharts |
| **Routing** | React Router |
| **Rendering** | React Markdown with GFM + syntax highlighting |

---

## Project Structure

```
silos/
├── src/
│   ├── components/
│   │   ├── views/          # Page components (Dashboard, Chat, Tasks, Cron, Settings…)
│   │   ├── agents/         # Agent detail panels (Brain, Skills, Tools, Workspace…)
│   │   ├── sessions/       # Session intelligence, task pipeline
│   │   ├── layout/         # Sidebar, command palette
│   │   └── ui/             # Shared UI components
│   ├── store/              # Zustand store (gateway connection, streaming, state)
│   ├── hooks/              # React hooks (auth, theme)
│   ├── types/              # TypeScript types
│   ├── i18n/               # Translations (en, es, fr, de)
│   ├── lib/                # Gateway client, utilities, validation
│   └── services/           # OpenClaw RPC service layer
├── server.js               # Express server (static files + API proxy + gateway proxy)
├── server/                 # Server-side routes and middleware
└── vite.config.ts
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make sure `npm run build` passes
4. Open a PR against `main`

---

## Related Projects

| Project | Description |
|---------|-------------|
| [OpenClaw](https://openclaw.ai) | The open-source AI agent framework |
| [Silos Platform](https://silosplatform.com) | Managed OpenClaw hosting — no setup, flat-rate AI |
| [CheapestInference](https://cheapestinference.com) | AI inference provider powering Silos Platform |

---

## License

[MIT](LICENSE) © [cheapestinference](https://github.com/cheapestinference)
