// The sign-in page on the broker's domain, in the house's look (theme.css
// tokens, the tricorn, Source Serif + Inter from Google Fonts — Georgia and
// the system face when they don't load). With a method picked on the
// instance it carries it out with no second choice: Google by redirect when
// Firebase's auth handler is on this domain (else the button: a popup needs
// a click), an email link sent at once. Without one — or when the automatic
// step can't — it offers both. Either way the page posts the Firebase ID
// token to /login/exchange and follows the redirect it gets back: nothing
// in the page decides where the browser goes.

export interface BrokerFirebase {
  apiKey: string
  authDomain: string
  projectId: string
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function loginPage(
  cfg: { firebase: BrokerFirebase; instance: string; state: string; target: string; method?: 'google' | 'email'; email?: string; redirect: boolean },
  nonce: string,
): string {
  // JSON inside a script: `<` escaped so no value closes the tag
  const data = JSON.stringify({
    firebase: cfg.firebase,
    instance: cfg.instance,
    state: cfg.state,
    redirect: cfg.redirect,
    ...(cfg.method ? { method: cfg.method } : {}),
    ...(cfg.email ? { email: cfg.email } : {}),
  }).replace(/</g, '\\u003c')
  const host = esc(new URL(cfg.target).host)
  const auto = cfg.method === 'email' || (cfg.method === 'google' && cfg.redirect)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Silos</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,600&display=swap">
<style>
:root{--canvas:#faf9f5;--panel:#f0eee6;--ink:#141413;--ink-2:rgba(20,20,19,.62);--line:#e8e6dd;--terracotta:#d97757}
@media (prefers-color-scheme:dark){:root{--canvas:#262624;--panel:#30302e;--ink:#f5f4ef;--ink-2:#cfc0ad;--line:#3d3c39}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--canvas);color:var(--ink);font:14px/1.5 "Inter",system-ui,sans-serif;padding:0 24px}
main{width:100%;max-width:20rem;display:flex;flex-direction:column;align-items:center;text-align:center}
svg.mark{color:var(--terracotta)}
h1{font-family:"Source Serif 4",Georgia,serif;font-size:3rem;line-height:1;font-weight:600;letter-spacing:-.025em;margin:1rem 0 0}
.sub{color:var(--ink-2);margin:.65rem 0 0;font-size:14px}
.sub b{color:var(--ink);font-weight:500}
#go{margin-top:2.5rem;width:100%;display:flex;align-items:center;justify-content:center;gap:.6rem;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:.75rem;padding:.65rem 1rem;font:inherit;cursor:pointer;transition:border-color .15s}
#go:hover{border-color:var(--ink-2)}button:disabled{opacity:.6}
button:focus-visible,input:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px}
.link{margin-top:1rem;border:0;background:none;padding:0;font:inherit;font-size:12.5px;color:var(--ink-2);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px;cursor:pointer}
.link:hover{color:var(--ink);text-decoration-color:var(--ink-2)}
form{margin-top:1rem;width:100%;display:flex;gap:.5rem}
input{flex:1;min-width:0;border:1px solid var(--line);background:var(--canvas);color:var(--ink);border-radius:.6rem;padding:.5rem .7rem;font:inherit;font-size:13.5px}
form button{border:0;border-radius:.6rem;background:var(--ink);color:var(--canvas);padding:0 .9rem;font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
#status{margin-top:2.5rem;display:flex;align-items:center;gap:.55rem;color:var(--ink-2);font-size:14px}
#status i{width:6px;height:6px;border-radius:50%;background:var(--terracotta);animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){#status i{animation:none}}
#err{color:var(--terracotta);font-size:12.5px;margin-top:1rem;min-height:1em}
[hidden]{display:none!important}
small{display:block;width:100%;margin-top:3.5rem;border-top:1px solid var(--line);padding-top:1rem;font-size:11.5px;line-height:1.6;color:var(--ink-2)}
</style></head>
<body><main>
<svg class="mark" width="44" height="44" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.8 A26 26 0 0 1 2.5 20.25 A26 26 0 0 1 21.5 20.25 A26 26 0 0 1 12 3.8 Z"/></svg>
<h1>Silos</h1>
<p class="sub">Signing in to <b>${host}</b></p>
<p id="status" role="status"${auto ? '' : ' hidden'}><i aria-hidden="true"></i><span id="status-text">${cfg.method === 'email' ? 'Sending your sign-in link…' : 'Taking you to Google…'}</span></p>
<div id="choose" style="width:100%"${auto ? ' hidden' : ''}>
<button id="go" type="button"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg><span id="go-text">Continue with Google</span></button>
<button id="use-email" class="link" type="button">Use email instead</button>
<form id="email-form" hidden><input id="email" type="email" autocomplete="email" placeholder="you@example.com" required aria-label="Email"><button id="send" type="submit">Send link</button></form>
</div>
<div id="err" role="alert"></div>
<small>Silos ID passes your sign-in to ${host}. It keeps that Silos’s address and who signed in to it, never a password.</small>
</main>
<script type="module" nonce="${nonce}">
const cfg = ${data};
const $ = (id) => document.getElementById(id);
const choose = $('choose'), status = $('status'), statusText = $('status-text'), btn = $('go'), goText = $('go-text'), err = $('err'), useEmail = $('use-email'), form = $('email-form'), input = $('email'), send = $('send');
// the email a link was sent to, per attempt (finishing needs it again, and
// only the browser that asked has it); the redirect mark, so coming back
// from Google is read as the answer and never starts another trip
const KEY = 'silos-id-email:' + cfg.state, TRIP = 'silos-id-trip:' + cfg.state;
const keep = (s) => ({
  get(k) { try { return s.getItem(k) } catch { return null } },
  set(k, v) { try { s.setItem(k, v) } catch {} },
  drop(k) { try { s.removeItem(k) } catch {} },
});
const local = keep(localStorage), session = keep(sessionStorage);
let authP = null;
const firebase = () => authP ??= (async () => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js');
  const a = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js');
  return { a, auth: a.getAuth(initializeApp(cfg.firebase)) };
})();
const busy = (text) => { statusText.textContent = text; status.hidden = false; choose.hidden = true };
// what the automatic step couldn't do: said, and both ways offered
const offer = (e) => { status.hidden = true; choose.hidden = false; if (e) err.textContent = e && e.message ? e.message : String(e) };
// the email stays out of the address bar and the history
if (cfg.email) { const u = new URL(location.href); u.searchParams.delete('email'); history.replaceState(null, '', u) }
// one exchange for every method: a Firebase ID token → the pass
async function exchange(user) {
  busy('Signing you in…');
  const idToken = await user.getIdToken();
  const res = await fetch('/login/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken, instance: cfg.instance, state: cfg.state }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.redirect !== 'string') throw new Error(body.error || ('HTTP ' + res.status));
  local.drop(KEY); session.drop(TRIP);
  location.replace(body.redirect);
}
async function google() {
  const { a, auth } = await firebase();
  if (cfg.redirect) { session.set(TRIP, '1'); busy('Taking you to Google…'); await a.signInWithRedirect(auth, new a.GoogleAuthProvider()); return }
  await exchange((await a.signInWithPopup(auth, new a.GoogleAuthProvider())).user);
}
async function sendLink(email) {
  busy('Sending your sign-in link…');
  const { a, auth } = await firebase();
  const linkBack = location.origin + '/login?' + new URLSearchParams({ instance: cfg.instance, state: cfg.state });
  await a.sendSignInLinkToEmail(auth, email, { url: linkBack, handleCodeInApp: true });
  local.set(KEY, email);
  status.querySelector('i').hidden = true;
  statusText.textContent = 'Check ' + email + ' and open the link in this browser.';
}
btn.addEventListener('click', () => { btn.disabled = true; goText.textContent = 'Waiting for Google…'; err.textContent = ''; google().catch((e) => { offer(e); btn.disabled = false; goText.textContent = 'Continue with Google' }) });
useEmail.addEventListener('click', () => { useEmail.hidden = true; form.hidden = false; input.focus() });
let finishing = false;
form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const email = input.value.trim();
  if (!email) return;
  err.textContent = '';
  (finishing
    ? firebase().then(({ a, auth }) => a.signInWithEmailLink(auth, email, location.href)).then((r) => exchange(r.user))
    : sendLink(email)
  ).catch((e) => { offer(e); form.hidden = false; useEmail.hidden = true });
});
const q = new URLSearchParams(location.search);
(async () => {
  // back from the email: finish with the email this browser stored
  if (q.get('mode') === 'signIn' && q.get('oobCode')) {
    const { a, auth } = await firebase();
    if (!a.isSignInWithEmailLink(auth, location.href)) return offer();
    finishing = true;
    const email = local.get(KEY);
    if (!email) {
      // another browser: the instance refuses it anyway (its bind cookie
      // lives where the sign-in started); confirming only helps the same
      // browser with its storage cleared
      offer('Open this link in the browser where you started signing in. Same browser? Confirm your email.');
      btn.hidden = true; useEmail.hidden = true; form.hidden = false; send.textContent = 'Continue';
      return;
    }
    return exchange((await a.signInWithEmailLink(auth, email, location.href)).user);
  }
  // back from Google's redirect: its answer, once
  if (cfg.redirect && session.get(TRIP)) {
    session.drop(TRIP);
    busy('Signing you in…');
    const { a, auth } = await firebase();
    const r = await a.getRedirectResult(auth);
    return r ? exchange(r.user) : offer();
  }
  if (cfg.method === 'email' && cfg.email) return sendLink(cfg.email);
  if (cfg.method === 'google' && cfg.redirect) return google();
})().catch((e) => offer(e));
</script></body></html>`
}

/** The usage page (GET /stats): Google sign-in on this domain, then the
 *  rows from POST /stats/data — the broker checks the email against
 *  SILOS_ID_ADMIN_EMAILS, the page decides nothing. Every value is written
 *  with textContent, never as markup. */
export function statsPage(cfg: { firebase: BrokerFirebase; redirect: boolean }, nonce: string): string {
  const data = JSON.stringify({ firebase: cfg.firebase, redirect: cfg.redirect }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Usage · Silos ID</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,600&display=swap">
<style>
:root{--canvas:#faf9f5;--panel:#f0eee6;--ink:#141413;--ink-2:rgba(20,20,19,.62);--line:#e8e6dd;--terracotta:#d97757}
@media (prefers-color-scheme:dark){:root{--canvas:#262624;--panel:#30302e;--ink:#f5f4ef;--ink-2:#cfc0ad;--line:#3d3c39}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 "Inter",system-ui,sans-serif;padding:0 16px}
main{max-width:64rem;margin:0 auto;padding:3rem 0 4rem}
header{display:flex;align-items:center;gap:.75rem}
svg.mark{color:var(--terracotta);flex:none}
h1{font-family:"Source Serif 4",Georgia,serif;font-size:2rem;line-height:1;font-weight:600;letter-spacing:-.02em;margin:0}
h2{font-family:"Source Serif 4",Georgia,serif;font-size:1.25rem;font-weight:600;margin:2.5rem 0 .25rem}
.sub,.note{color:var(--ink-2);font-size:13px;margin:.35rem 0 0}
#who{margin-left:auto;color:var(--ink-2);font-size:12.5px}
button{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:.6rem;padding:.45rem .9rem;font:inherit;font-size:13px;cursor:pointer}
button:hover{border-color:var(--ink-2)}button:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px}
#gate{margin-top:3rem}
#err{color:var(--terracotta);font-size:12.5px;margin-top:1rem;min-height:1em}
.figs{display:flex;flex-wrap:wrap;gap:2.5rem;margin-top:1.75rem}
.fig b{display:block;font-family:"Source Serif 4",Georgia,serif;font-size:1.75rem;font-weight:600;line-height:1.1}
.fig span{color:var(--ink-2);font-size:12.5px}
.wrap{overflow-x:auto;margin-top:.75rem}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:500;color:var(--ink-2);font-size:12px;padding:.4rem .75rem .4rem 0;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:.55rem .75rem .55rem 0;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}
td.num,th.num{text-align:right}
tr.inst{cursor:pointer}tr.inst:hover td{background:var(--panel)}
tr.detail>td{background:var(--panel);white-space:normal;padding:.75rem}
tr.detail table{margin-top:.5rem}
.flag{color:var(--terracotta);font-size:12px}
.muted{color:var(--ink-2)}
.hours{display:inline-grid;grid-template-columns:repeat(24,6px);gap:1px;vertical-align:middle}
.hours i{height:10px;border-radius:1px;background:var(--line)}.hours i.on{background:var(--terracotta)}
[hidden]{display:none!important}
</style></head>
<body><main>
<header><svg class="mark" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.8 A26 26 0 0 1 2.5 20.25 A26 26 0 0 1 21.5 20.25 A26 26 0 0 1 12 3.8 Z"/></svg><h1>Usage</h1><span id="who"></span></header>
<p class="sub">Every Silos that signs in through this Silos ID — what the broker saw (boots, sign-ins) and what each instance reported (hours open, turns). Times UTC.</p>
<div id="gate"><button id="go" type="button">Continue with Google</button></div>
<div id="err" role="alert"></div>
<section id="out" hidden>
<div class="figs" id="figs"></div>
<h2>Instances</h2>
<p class="note">Open a row for its last 30 days. <span class="flag">unverified</span> = it reported activity this week, but nobody signed in to it for 8 days (a session lasts 7): its own report is all there is.</p>
<div class="wrap"><table><thead><tr><th>Silos</th><th>Version</th><th class="num">Days active 7d</th><th class="num">Hours / active day</th><th class="num">Turns 7d · you</th><th class="num">· Silos</th><th class="num">People 30d</th><th>Last sign-in</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
<h2>People</h2>
<p class="note">Who signed in, last 30 days.</p>
<div class="wrap"><table><thead><tr><th>Email</th><th>Silos</th><th class="num">Sign-ins</th><th class="num">Days</th><th>Last day</th></tr></thead><tbody id="people"></tbody></table></div>
</section>
</main>
<script type="module" nonce="${nonce}">
const cfg = ${data};
const $ = (id) => document.getElementById(id);
const err = $('err'), gate = $('gate'), out = $('out');
const TRIP = 'silos-id-stats-trip';
let authP = null;
const firebase = () => authP ??= (async () => {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js');
  const a = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js');
  return { a, auth: a.getAuth(initializeApp(cfg.firebase)) };
})();
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = String(text); if (cls) e.className = cls; return e };
const DAY = 86400000;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const when = (t) => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—';
function hoursBar(hours) {
  const g = el('span', null, 'hours');
  for (let h = 0; h < 24; h++) { const i = el('i', null, hours && hours.includes(h) ? 'on' : ''); i.title = h + ':00'; g.append(i) }
  return g;
}
function render(data) {
  const since = (n) => dayOf(data.now - (n - 1) * DAY);
  const rows = data.rows.map((r) => {
    const d7 = r.days.filter((d) => d.day >= since(7));
    const active = d7.filter((d) => (d.hours && d.hours.length) || d.attended || d.logins);
    const hrs = active.filter((d) => d.hours).map((d) => d.hours.length);
    const sum = (k) => r.reporting ? d7.reduce((n, d) => n + (d[k] || 0), 0) : null;
    return { r, activeDays: active.length, hoursPer: hrs.length ? (hrs.reduce((a, b) => a + b, 0) / hrs.length).toFixed(1) : '—', you: sum('attended'), silos: sum('unattended'), people: new Set(r.days.flatMap((d) => Object.keys(d.users))).size };
  }).sort((a, b) => b.activeDays - a.activeDays || (b.r.lastLoginAt || 0) - (a.r.lastLoginAt || 0));
  const figs = $('figs'); figs.replaceChildren();
  const fig = (n, label) => { const f = el('div', null, 'fig'); f.append(el('b', n), el('span', label)); figs.append(f) };
  fig(data.rows.length, 'registered');
  fig(rows.filter((x) => x.activeDays > 0).length, 'active this week');
  fig(new Set(data.rows.flatMap((r) => r.days.flatMap((d) => Object.keys(d.users)))).size, 'people, 30 days');
  const tb = $('rows'); tb.replaceChildren();
  for (const x of rows) {
    const tr = el('tr', null, 'inst');
    tr.append(el('td', new URL(x.r.origin).host), el('td', x.r.version || '—', x.r.version ? '' : 'muted'), el('td', x.activeDays, 'num'), el('td', x.hoursPer, 'num'),
      el('td', x.you === null ? '—' : x.you, 'num'), el('td', x.silos === null ? '—' : x.silos, 'num'), el('td', x.people, 'num'), el('td', when(x.r.lastLoginAt)));
    const flag = el('td');
    if (x.r.unverified) flag.append(el('span', 'unverified', 'flag'));
    else if (!x.r.reporting) flag.append(el('span', 'not reporting', 'muted'));
    tr.append(flag);
    const det = el('tr', null, 'detail'); det.hidden = true;
    const td = el('td'); td.colSpan = 9;
    td.append(el('div', 'Registered ' + when(x.r.registeredAt) + ' · ' + x.r.boots + ' boots, last ' + when(x.r.lastBootAt) + ' · last report ' + when(x.r.lastReportAt), 'muted'));
    if (x.r.days.length) {
      const t = el('table'); const h = el('tr');
      for (const c of ['Day', 'Hours open', 'Turns · you', '· Silos', 'Sign-ins', 'Who']) h.append(el('th', c));
      t.append(h);
      for (const d of x.r.days) {
        const row = el('tr'); const hc = el('td'); hc.append(hoursBar(d.hours));
        row.append(el('td', d.day), hc, el('td', d.attended ?? '—'), el('td', d.unattended ?? '—'), el('td', d.logins), el('td', Object.keys(d.users).join(', ') || '—'));
        t.append(row);
      }
      td.append(t);
    } else td.append(el('div', 'Nothing in the last 30 days.', 'muted'));
    det.append(td);
    tr.addEventListener('click', () => { det.hidden = !det.hidden });
    tb.append(tr, det);
  }
  const people = new Map();
  for (const r of data.rows) for (const d of r.days) for (const [p, n] of Object.entries(d.users)) {
    const e = people.get(p) || { hosts: new Set(), days: new Set(), last: '', signIns: 0 };
    e.hosts.add(new URL(r.origin).host); e.days.add(d.day); e.signIns += n; if (d.day > e.last) e.last = d.day; people.set(p, e);
  }
  const pb = $('people'); pb.replaceChildren();
  for (const [p, e] of [...people].sort((a, b) => b[1].last.localeCompare(a[1].last))) {
    const tr = el('tr'); tr.append(el('td', p), el('td', [...e.hosts].join(', ')), el('td', e.signIns, 'num'), el('td', e.days.size, 'num'), el('td', e.last)); pb.append(tr);
  }
  if (!people.size) { const tr = el('tr'); const td = el('td', 'Nobody yet.', 'muted'); td.colSpan = 5; tr.append(td); pb.append(tr) }
  out.hidden = false; gate.hidden = true;
}
async function load(user) {
  $('who').textContent = user.email || '';
  const res = await fetch('/stats/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: await user.getIdToken() }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  render(body);
}
async function signIn() {
  const { a, auth } = await firebase();
  if (cfg.redirect) { try { sessionStorage.setItem(TRIP, '1') } catch {} await a.signInWithRedirect(auth, new a.GoogleAuthProvider()); return }
  await load((await a.signInWithPopup(auth, new a.GoogleAuthProvider())).user);
}
const fail = (e) => { err.textContent = e && e.message ? e.message : String(e); gate.hidden = false };
$('go').addEventListener('click', () => { err.textContent = ''; signIn().catch(fail) });
(async () => {
  const { a, auth } = await firebase();
  let trip = null; try { trip = sessionStorage.getItem(TRIP); sessionStorage.removeItem(TRIP) } catch {}
  if (cfg.redirect && trip) { const r = await a.getRedirectResult(auth); if (r) return load(r.user) }
  // already signed in on this browser: straight to the numbers
  await auth.authStateReady();
  if (auth.currentUser) return load(auth.currentUser);
})().catch(fail);
</script>
</body></html>`
}
