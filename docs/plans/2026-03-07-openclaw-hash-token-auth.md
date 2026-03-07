# OpenClaw Hash Fragment Token Auth — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user clicks "OpenClaw UI" from the Silos dashboard, the control UI auto-connects to the gateway without manual token entry — using the URL hash fragment `#token=<TOKEN>` mechanism native to OpenClaw.

**Architecture:** The Silos dashboard already has the `gatewayToken` in its Zustand store (from `/api/verify-owner`). We append `#token=<TOKEN>` to the `/openclaw/` URL when opening it. OpenClaw UI natively reads the token from the hash, saves it to localStorage, cleans the URL, and connects. Server-side: revert proxy.js to a simple pass-through (no cookies, no HTML injection).

**Tech Stack:** React (frontend), Express 5 + http-proxy (server), OpenClaw native `#token=` support

---

## Summary of Changes

| File | Action | What |
|------|--------|------|
| `server/proxy.js` | Revert | Remove cookie/injection code, simple proxy only |
| `server/routes/api.js` | Modify | Remove `setAuthCookie` import and 2 calls |
| `server.js` | Modify | Remove 3rd param from `createGatewayProxy()` |
| `src/App.tsx` | Modify | Remove `?redirect=openclaw` handling |
| `src/components/views/UnifiedDashboard.tsx` | Modify | Append `#token=` to openClawUiUrl |
| `src/components/layout/AppSidebar.tsx` | Modify | Append `#token=` to openclaw link |
| `package.json` | Modify | Bump version |

---

### Task 1: Clean up server/proxy.js — revert to simple proxy

**Files:**
- Modify: `server/proxy.js` (entire file)

**Step 1: Confirm working directory already has simplified version**

The working directory already has the simplified proxy.js (from previous session). Verify it has no `setAuthCookie`, no `crypto`, no `tokenInjectionProxy`, no cookie logic.

Run: `grep -c 'setAuthCookie\|crypto\|tokenInjectionProxy\|parseCookies' server/proxy.js`
Expected: `0`

**Step 2: Verify the simplified proxy.js exports correctly**

The file should export `createGatewayProxy(gatewayHost, gatewayPort)` (2 params, not 3) and return `{ proxy, httpMiddleware, upgradeHandler }`.

Run: `node -e "import('./server/proxy.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'createGatewayProxy' ]` — no `setAuthCookie` export

---

### Task 2: Fix server/routes/api.js — remove setAuthCookie

**Files:**
- Modify: `server/routes/api.js:8` (remove import)
- Modify: `server/routes/api.js:38` (remove call in no-owner branch)
- Modify: `server/routes/api.js:57` (remove call in verified-owner branch)

**Step 1: Remove the import**

```diff
- import { setAuthCookie } from '../proxy.js';
```

**Step 2: Remove setAuthCookie call in no-owner-email branch (line ~38)**

```diff
  if (!ownerEmail) {
-   if (gatewayToken) setAuthCookie(res, 'owner', gatewayToken);
    return res.json({
```

**Step 3: Remove setAuthCookie call in verified-owner branch (line ~57)**

```diff
-   if (gatewayToken) setAuthCookie(res, email, gatewayToken);
    res.json({
```

**Step 4: Verify no remaining references**

Run: `grep -n 'setAuthCookie' server/routes/api.js`
Expected: No output

---

### Task 3: Fix server.js — remove 3rd param from createGatewayProxy

**Files:**
- Modify: `server.js:80`

**Step 1: Remove GATEWAY_TOKEN parameter**

```diff
- const { httpMiddleware, upgradeHandler } = createGatewayProxy('127.0.0.1', parseInt(OPENCLAW_PORT), GATEWAY_TOKEN);
+ const { httpMiddleware, upgradeHandler } = createGatewayProxy('127.0.0.1', parseInt(OPENCLAW_PORT));
```

**Step 2: Verify server boots**

Run: `node --check server.js && echo "Syntax OK"`
Expected: `Syntax OK`

---

### Task 4: Fix src/App.tsx — remove redirect=openclaw logic

**Files:**
- Modify: `src/App.tsx:72-77`

**Step 1: Remove the redirect block**

Remove these lines from the `verifyOwner` success handler:

```diff
          if (data.authorized && data.gatewayToken) {
-            // Handle redirect before setting state to avoid re-render loops
-            const redirectParam = new URLSearchParams(window.location.search).get('redirect');
-            if (redirectParam === 'openclaw') {
-              window.location.replace('/openclaw/');
-              return;
-            }
             // If token changed (e.g. VPS reset), disconnect existing client so autoConnect
```

**Step 2: Verify no remaining redirect=openclaw references**

Run: `grep -rn 'redirect.*openclaw' src/`
Expected: No output

---

### Task 5: Add #token= to OpenClaw UI links

**Files:**
- Modify: `src/components/views/UnifiedDashboard.tsx:269-279`
- Modify: `src/components/layout/AppSidebar.tsx:624-638`

**Step 1: Update UnifiedDashboard.tsx — add token to useMemo**

Add `token` to the store destructuring and append `#token=` to the URL:

```tsx
// In the useDashboardStore() destructuring (line ~52), add token:
const {
  connected,
  loadAll,
  gatewayConfig,
  channels,
  gatewayUrl,
  token,          // <-- ADD THIS
  loadChannels,
  channelsLoading,
  client,
  patchGatewayConfig,
} = useDashboardStore();

// Replace the openClawUiUrl useMemo (lines 269-279):
const openClawUiUrl = useMemo(() => {
  if (!gatewayUrl) return null;
  const isLocal = gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1');
  const isHttps = window.location.protocol === 'https:';
  let base: string;
  if (isLocal && isHttps) {
    base = `${window.location.origin}/openclaw/`;
  } else {
    let httpUrl = gatewayUrl.replace(/^wss?:\/\//, 'http://');
    if (!httpUrl.startsWith('http')) httpUrl = `http://${httpUrl}`;
    base = `${httpUrl}/openclaw/`;
  }
  return token ? `${base}#token=${encodeURIComponent(token)}` : base;
}, [gatewayUrl, token]);
```

**Step 2: Update AppSidebar.tsx — add token to onclick URLs**

Add `token` to the store destructuring and append hash to URLs:

```tsx
// In the useDashboardStore() destructuring, add token:
// (Find the line with gatewayUrl and add token next to it)

// Replace the onClick handler (lines 629-638):
onClick={() => {
  const isLocal = gatewayUrl.includes('localhost') || gatewayUrl.includes('127.0.0.1');
  const isHttps = window.location.protocol === 'https:';
  const suffix = token ? `#token=${encodeURIComponent(token)}` : '';
  if (isLocal && isHttps) {
    window.open(`${window.location.origin}/openclaw/${suffix}`, '_blank');
  } else {
    let httpUrl = gatewayUrl.replace(/^wss?:\/\//, 'http://');
    if (!httpUrl.startsWith('http')) httpUrl = `http://${httpUrl}`;
    window.open(`${httpUrl}/openclaw/${suffix}`, '_blank');
  }
}}
```

**Step 3: Verify no compilation errors**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (or only pre-existing ones)

---

### Task 6: Bump version

**Files:**
- Modify: `package.json`

**Step 1: Bump to 2.4.0 (minor bump — new auth approach)**

```diff
- "version": "2.3.2",
+ "version": "2.4.0",
```

---

### Task 7: Build and test locally

**Step 1: Build the frontend**

Run: `npm run build`
Expected: Build succeeds, `dist/` populated

**Step 2: Build Docker image**

Run: `docker build -t openclaw-dashboard:test .`
Expected: Image builds successfully

**Step 3: Verify server starts**

Run: `timeout 5 node server.js 2>&1 || true`
Expected: Output includes "Silos Dashboard v2.4.0 listening on 127.0.0.1:3001" (or exits after timeout)

---

### Task 8: Deploy to test2 and verify

**Step 1: Save and load Docker image on test2**

```bash
docker save openclaw-dashboard:test | gzip > /tmp/dashboard-test.tar.gz
scp /tmp/dashboard-test.tar.gz root@91.98.69.128:/tmp/
ssh root@91.98.69.128 'docker load < /tmp/dashboard-test.tar.gz && docker tag openclaw-dashboard:test openclaw-dashboard:latest'
```

**Step 2: Restart dashboard on test2**

```bash
ssh root@91.98.69.128 'docker stop openclaw-dashboard 2>/dev/null; docker rm openclaw-dashboard 2>/dev/null; systemctl restart openclaw-dashboard'
```

**Step 3: Verify dashboard loads**

```bash
ssh root@91.98.69.128 'curl -s http://127.0.0.1:3001/api/health'
```
Expected: `{"ok":true,"uptime":...}`

**Step 4: Verify /openclaw/ loads without redirect loop**

```bash
ssh root@91.98.69.128 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/openclaw/'
```
Expected: `200` (proxied from gateway) or `502` (gateway not reachable from container — expected in container network mode)

**Step 5: Verify no setAuthCookie crash**

```bash
ssh root@91.98.69.128 'docker logs openclaw-dashboard --tail 20 2>&1 | grep -i error'
```
Expected: No "Cannot find named export 'setAuthCookie'" errors

**Step 6: Manual browser test**

Navigate to `https://test2.silosplatform.com/` — login with Firebase. After login, click the OpenClaw UI button. Verify:
1. New tab opens at `/openclaw/#token=<TOKEN>`
2. URL cleans to `/openclaw/chat?session=main` (or similar)
3. OpenClaw UI shows connected state
4. No redirect loops

---

### Task 9: Commit, push, and release (only after test passes)

**Step 1: Commit**

```bash
git add server/proxy.js server/routes/api.js server.js src/App.tsx \
  src/components/views/UnifiedDashboard.tsx \
  src/components/layout/AppSidebar.tsx \
  package.json
git commit -m "feat: auto-auth OpenClaw UI via hash fragment token pass-through

Replace cookie-based auth gate with native OpenClaw #token= URL mechanism.
Dashboard appends gateway token as hash fragment when opening /openclaw/.
OpenClaw UI reads it, saves to localStorage, cleans URL, and auto-connects.

Removes: cookie signing, HTML injection proxy, redirect loop logic.
Simpler, more secure (hash never sent to server), uses native OpenClaw API."
```

**Step 2: Push and create release**

```bash
git push origin main
gh release create v2.4.0 --title "v2.4.0" --notes "Auto-auth OpenClaw UI via hash fragment token"
```

---

### Task 10: Deploy to espejito and lina

After release is built by CI:

```bash
# espejito
ssh root@91.98.201.128 'systemctl restart openclaw-dashboard'

# lina
ssh root@178.104.5.225 'systemctl restart openclaw-dashboard'
```

Verify each with health check and manual browser test.
