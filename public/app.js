'use strict';

// Tier 3 storage: the session lives only on this device.
const SESSION_KEY = 'spotswap.user';
// SSE delivers changes instantly; polling is only a fallback + countdown refresh.
const POLL_MS = 30 * 1000;

const $ = (sel) => document.querySelector(sel);

let user = loadSession();
let gracePeriodMinutes = 15;
let pollTimer = null;
let stream = null;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(u) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(u));
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (user) headers['X-User-Id'] = user.id;
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Server restarted (in-memory store) or unknown user: re-register.
    logout();
    throw new Error('Session expired — please rejoin your neighborhood.');
  }
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function toast(message) {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtCountdown(ts) {
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return mins <= 1 ? 'about a minute' : `~${mins} min`;
}

function show(viewId) {
  $('#view-register').hidden = viewId !== 'register';
  $('#view-app').hidden = viewId !== 'app';
  $('#hood-label').hidden = viewId !== 'app';
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  user = null;
  clearInterval(pollTimer);
  stream?.close();
  stream = null;
  show('register');
}

function connectStream() {
  if (!('EventSource' in window) || !user) return;
  stream?.close();
  stream = new EventSource(`/api/stream?u=${encodeURIComponent(user.id)}`);
  stream.addEventListener('update', refresh);
  // On error EventSource reconnects on its own; the poll timer covers the gap.
}

// ---------- rendering ----------

function spotCard(spot) {
  const card = document.createElement('div');
  card.className = 'card' + (spot.mode === 'warming' ? ' warming' : '') + (spot.isMine ? ' mine' : '');

  const when = spot.mode === 'warming'
    ? `🔥 Warming up — leaving in ${fmtCountdown(spot.leavingAt)}`
    : `🕐 Leaving at ${fmtTime(spot.leavingAt)}`;

  card.innerHTML = `
    <div class="car">${escapeHtml(spot.car)}
      ${spot.status === 'claimed' ? '<span class="badge claimed">claimed</span>' : ''}
      ${spot.isMine ? '<span class="badge">your spot</span>' : ''}
    </div>
    <div class="when">${when}</div>
    ${spot.locationText ? `<div class="loc">📍 ${escapeHtml(spot.locationText)}</div>` : ''}
    ${spot.claimerName ? `<div class="loc">🚗 ${escapeHtml(spot.claimerName)} is heading there</div>` : ''}
    <div class="card-actions"></div>
  `;

  const actions = card.querySelector('.card-actions');
  if (spot.isMine) {
    actions.append(
      button('✅ I\'ve left — handoff done', 'primary', () => act(`/api/spots/${spot.id}/complete`)),
      button('Cancel', '', () => act(`/api/spots/${spot.id}/cancel`))
    );
  } else if (!spot.claimerName) {
    actions.append(button('🚗 I\'m heading there', 'primary', () => act(`/api/spots/${spot.id}/claim`)));
  } else if (spot.claimedByMe) {
    actions.append(document.createTextNode('You claimed this spot — good luck!'));
  }
  if (!actions.hasChildNodes()) actions.remove();
  return card;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s ?? '';
  return div.innerHTML;
}

async function act(path) {
  try {
    await api(path, { method: 'POST' });
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function refresh() {
  if (!user) return;
  try {
    const { spots } = await api('/api/spots');
    const mine = spots.find((s) => s.isMine);
    const others = spots.filter((s) => !s.isMine);

    const myCard = $('#my-spot-card');
    myCard.hidden = !mine;
    myCard.replaceChildren();
    if (mine) myCard.appendChild(spotCard(mine));
    $('#announce-panel').hidden = !!mine;

    const list = $('#spot-list');
    list.replaceChildren();
    if (!others.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No spots opening right now. Announcements appear here live.';
      list.appendChild(p);
    } else {
      others.forEach((s) => list.appendChild(spotCard(s)));
    }
  } catch (err) {
    if (user) toast(err.message);
  }
}

// ---------- wiring ----------

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const { user: u } = await api('/api/register', { method: 'POST', body: JSON.stringify(data) });
    user = u;
    saveSession(u);
    enterApp();
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-warming').addEventListener('click', () => {
  $('#warming-form').hidden = false;
  $('#schedule-form').hidden = true;
});

$('#btn-schedule').addEventListener('click', () => {
  $('#schedule-form').hidden = false;
  $('#warming-form').hidden = true;
});

$('#warming-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { locationText } = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/spots', {
      method: 'POST',
      body: JSON.stringify({ mode: 'warming', locationText }),
    });
    e.target.reset();
    e.target.hidden = true;
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('#schedule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { time, locationText } = Object.fromEntries(new FormData(e.target));
  const [h, m] = time.split(':').map(Number);
  const leaving = new Date();
  leaving.setHours(h, m, 0, 0);
  if (leaving.getTime() <= Date.now()) leaving.setDate(leaving.getDate() + 1);
  try {
    await api('/api/spots', {
      method: 'POST',
      body: JSON.stringify({ mode: 'scheduled', leavingAt: leaving.getTime(), locationText }),
    });
    e.target.reset();
    e.target.hidden = true;
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-logout').addEventListener('click', logout);

async function enterApp() {
  show('app');
  $('#hood-label').textContent = `${user.name} · ${user.car} · #${user.neighborhood}`;
  try {
    const cfg = await api('/api/config');
    gracePeriodMinutes = cfg.gracePeriodMinutes;
  } catch { /* default stands */ }
  $('#grace-note').textContent =
    `"Warming up" gives you a ${gracePeriodMinutes}-minute window; announcements auto-delete when they expire.`;
  $('#btn-warming').textContent = `🔥 Warming up now (${gracePeriodMinutes} min)`;
  await refresh();
  connectStream();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

if (user) {
  enterApp();
} else {
  show('register');
}
