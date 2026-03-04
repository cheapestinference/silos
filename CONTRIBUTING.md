# Contributing to Silos Dashboard

Thank you for your interest in contributing! This document explains how to get involved.

---

## Code of Conduct

Be respectful and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

---

## Ways to Contribute

- **Bug reports** — open an issue with steps to reproduce
- **Feature requests** — open an issue describing the use case
- **Pull requests** — fix a bug, add a feature, improve docs or translations

---

## Development Setup

```bash
git clone https://github.com/cheapestinference/silos.git
cd silos
npm install
npm run dev
```

You need a running OpenClaw gateway (default: `http://localhost:18789`). The gateway URL can be changed in the Settings panel at runtime.

---

## Pull Request Guidelines

1. **Fork** the repo and create your branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   # or
   git checkout -b fix/bug-description
   ```

2. **Keep PRs focused** — one feature or fix per PR.

3. **Build must pass:**
   ```bash
   npm run build
   ```

4. **Follow existing conventions:**
   - TypeScript strict mode
   - Tailwind CSS for styling — no inline styles
   - Zustand for global state — no prop drilling for shared state
   - i18n keys for all user-facing strings (add to all 4 locale files: `en`, `es`, `fr`, `de`)

5. **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add agent memory tab
   fix: reconnect loop on gateway timeout
   docs: update gateway URL config
   ```

6. Open your PR against `main` and fill in the PR template.

---

## Adding Translations

Locale files live in `src/i18n/locales/`. To add or update a string:

1. Add the key to `en.json` first (source of truth for the TypeScript type)
2. Add the equivalent to `es.json`, `fr.json` and `de.json`
3. Machine translation is acceptable for initial PRs — native speakers will refine

---

## Reporting Bugs

Open an issue and include:

- Steps to reproduce
- Expected vs actual behaviour
- Browser and OS
- OpenClaw gateway version (if relevant)

---

## Releases

Maintainers handle releases. Each release:

1. Bumps the version in `package.json`
2. Updates `CHANGELOG.md`
3. Tags the commit (`v1.2.3`)
4. Publishes a GitHub Release
5. Triggers the Docker build and push to `ghcr.io/cheapestinference/silos`

---

## Questions

Open a [GitHub Discussion](https://github.com/cheapestinference/silos/discussions) or an issue.
