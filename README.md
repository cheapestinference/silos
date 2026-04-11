# 🚀 Silos: The Command Center for OpenClaw

**Silos transforms OpenClaw from a powerful framework into a professional AI Operation Center.**

Stop managing your agents through terminals and raw config files. Silos provides a high-performance, intuitive web interface to monitor, configure, and scale your AI agents in real-time.

[![GitHub Release](https://img.shields.io/github/v/release/cheapestinference/silos)](https://github.com/cheapestinference/silos/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-silos-blue)](https://github.com/cheapestinference/silos/pkgs/container/silos)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[![Silos Platform](https://img.shields.io/badge/Managed_Hosting-SilosPlatform.com-blueviolet?style=for-the-badge)](https://silosplatform.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://github.com/cheapestinference/silos/blob/main/LICENSE)

---

## 🎬 See it in Action


https://github.com/user-attachments/assets/86835726-f840-40e3-8847-cc33dee63ad4

*The most intuitive way to control your AI agents in real-time.*

---

## ⚡️ Quick Start (Self-Hosted)

Get your dashboard up and running in seconds using Docker:

```bash
docker pull ghcr.io/cheapestinference/silos:latest

docker run -p 3001:3001 \
 -e GATEWAY_TOKEN=your-token \
 -e OWNER_EMAIL=you@example.com \
 ghcr.io/cheapestinference/silos:latest
```
👉 Open `http://localhost:3001` and connect your OpenClaw Gateway.

---

## ☁️ The "Zero Friction" Path
**Don't want to manage VPS, Docker, or Security updates?**

Get a fully managed OpenClaw instance with **Flat-Rate AI included**. No per-token anxiety, no setup headaches. Ready in 5 minutes.

👉 **[Deploy on SilosPlatform.com](https://silosplatform.com)**

---

## 🛠 The Power of Silos

Silos isn't just a UI; it's a complete management layer for the OpenClaw ecosystem.

### 🧠 Total Brain Control
![Home Dashboard](docs/screenshots/silos-home.png)

*   **Live Brain Editor:** Edit `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, and `BOOTSTRAP.md` on the fly.
*   **Workspace Explorer:** Full CRUD access to your agent's files and folders.
*   **Dynamic Model Selection:** Swap between GPT, Claude, DeepSeek, or Mistral per agent.
*   **Tool Permissions:** Granular control over which tools each agent can access.

### 📈 Operational Intelligence
![Chat View](docs/screenshots/chat-view.png)

*   **Real-time Session Monitoring:** Track token usage, context window utilization, and active agents.
*   **Task Pipeline (Kanban):** Visualize running, completed, and failed tasks. Stop or abort any process instantly.
*   **Advanced Scheduling:** Create one-time, interval, or complex Cron-expression schedules for your agents.
*   **Subagent Hierarchy:** Full visibility into parent-child session delegation.

### 🌐 Seamless Connectivity
![Channels Settings](docs/screenshots/channels-settings.png)

*   **Omnichannel Hub:** One-click pairing for WhatsApp (QR), Telegram, Discord, and Slack.
*   **Skill Marketplace:** Browse, install, and manage skills directly from [ClawHub](https://clawhub.ai/).
*   **Gateway Management:** Centralized control of your OpenClaw Gateway connection and auth.

---

## 📐 Architecture

```mermaid
graph TD
    A[Silos Dashboard] -->|WebSocket + REST| B[OpenClaw Gateway]
    B --> C[OpenClaw AI Agents]
    C --> D[External Tools/API]
    C --> E[Messaging Channels]
```

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS, Zustand, Firebase Auth.

---

## 🤝 Contributing
We love contributions! Whether it's a new feature, a bug fix, or a translation, check out our [CONTRIBUTING.md](/CONTRIBUTING.md) to get started.

**Project by [CheapestInference](https://cheapestinference.com)**
