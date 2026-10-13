'use strict';

const $ = (id) => document.getElementById(id);
const ICON = {
  person: '<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
  group: '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
};
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const REACT_EMOJI = { love: '❤️', like: '👍', dislike: '👎', laugh: '😂', emphasize: '‼️', question: '❓', sticker: '🏷️' };
const isTouch = matchMedia('(hover: none)').matches;
const mobileMQ = matchMedia('(max-width: 760px)');

const state = {
  convs: [],
  convById: new Map(),
  lastIds: null,            // Map convId -> lastId, for new-message detection
  currentId: null,
  msgs: [],
  hasMore: false,
  loadingOlder: false,
  pending: [],
  tray: [],
  draftTo: null,            // {handle, name} when composing a new conversation
  searchTerm: '',
  searchResults: null,
  contacts: null,
  loadSeq: 0,
  quietIds: new Set(),      // real messages that replaced an optimistic bubble (already animated)
  reactCounts: new Map(),   // message id -> tapback count, to pop newly added tapbacks
};
const settings = {
  sound: load('webim.sound', true),
  notify: load('webim.notify', false),
  theme: load('webim.theme', 'system'),
  anim: load('webim.anim', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'normal'),
};
const SPEEDS = { off: 0, slow: 1.75, normal: 1, fast: 0.55 };
const speed = () => (SPEEDS[settings.anim] === undefined ? 1 : SPEEDS[settings.anim]);
/** Adds a class for the length of an animation, so moving or reusing the node later doesn't replay it. */
function flashClass(el, cls, ms = 900) {
  if (!el || !speed()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el['_t_' + cls]);
  el['_t_' + cls] = setTimeout(() => el.classList.remove(cls), ms * speed() + 120);
}

function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }

// ------------------------------------------------------------------ utils

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function linkify(text) {
  return esc(text).replace(/\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]!?'])/gi, (m) => {
    const href = /^https?:/i.test(m) ? m : 'https://' + m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${m}</a>`;
  });
}
function fmtHandle(h) {
  if (!h) return '';
  const d = h.replace(/[^\d+]/g, '');
  let m = d.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);
  if (m && !h.includes('@')) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return h;
}
function personName(p) { return p.name || fmtHandle(p.handle); }
function convTitle(c) {
  if (c.name) return c.name;
  const ps = c.participants || [];
  if (!ps.length) return 'Unknown';
  if (ps.length === 1) return personName(ps[0]);
  return ps.map((p) => (p.name ? p.name.split(' ')[0] : fmtHandle(p.handle))).join(', ');
}
function initials(name) {
  if (!name || /^[\d\s()+\-.]+$/.test(name) || name.includes('@')) return '';
  const parts = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w[0] || ''));
  if (!parts.length) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatar(p, cls = '') {
  // p: {handle, name, hasPhoto}
  const ini = initials(p.name);
  const img = p.hasPhoto ? `<img src="/api/avatar?h=${encodeURIComponent(p.handle)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="av ${cls}">${ini ? esc(ini) : ICON.person}${img}</span>`;
}
function convAvatar(c, cls = '') {
  const ps = c.participants || [];
  if (c.isGroup || ps.length > 1) {
    // iMessage-style group avatar: two overlapping member monograms.
    const two = ps.slice(0, 2);
    return `<span class="av grp ${cls}">${two.length ? two.map((p) => avatar(p)).join('') : `<span class="av">${ICON.group}</span>`}</span>`;
  }
  return avatar(ps[0] || { handle: '?' }, cls);
}

const DAY = 86400000;
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtListDate(t) {
  if (!t) return '';
  const today = startOfDay(Date.now());
  if (t >= today) return fmtTime(t);
  if (t >= today - 6 * DAY) return new Date(t).toLocaleDateString([], { weekday: 'short' });
  const d = new Date(t);
  if (d.getFullYear() === new Date().getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
}
/** iMessage-style separator, e.g. "<b>Today</b> 6:28 PM" or "<b>Sat, Oct 3</b> at 6:28 PM". Returns HTML. */
function fmtSep(t) {
  const today = startOfDay(Date.now());
  const time = esc(fmtTime(t));
  if (t >= today) return `<b>Today</b> ${time}`;
  if (t >= today - DAY) return `<b>Yesterday</b> ${time}`;
  const d = new Date(t);
  if (t >= today - 6 * DAY) return `<b>${esc(d.toLocaleDateString([], { weekday: 'long' }))}</b> ${time}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return `<b>${esc(d.toLocaleDateString([], opts))}</b> at ${time}`;
}
function fmtFull(t) { return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function isBigEmoji(t) {
  if (!t || t.length > 24) return false;
  return /^(?:\s*\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|⃣)*){1,3}\s*$/u.test(t);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function toast(msg, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

/** Keyed DOM update: reuses nodes whose HTML hasn't changed (keeps images/videos from reloading). */
function reconcile(container, items) {
  const old = container._nodes || new Map();
  const next = new Map();
  for (const it of items) {
    let rec = old.get(it.key);
    if (!rec || rec.html !== it.html) {
      const t = document.createElement('template');
      t.innerHTML = it.html.trim();
      rec = { html: it.html, el: t.content.firstElementChild };
    }
    next.set(it.key, rec);
  }
  for (const [k, r] of old) if (!next.has(k) || next.get(k).el !== r.el) r.el.remove();
  let prev = null;
  for (const r of next.values()) {
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== r.el) container.insertBefore(r.el, want);
    prev = r.el;
  }
  container._nodes = next;
  return [...next.entries()].filter(([k]) => !old.has(k)).map(([key, r]) => ({ key, el: r.el }));
}

// ------------------------------------------------------------------ api

class AuthError extends Error {}
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }
  if (res.status === 401) { showLogin(); throw new AuthError('auth'); }
  if (res.status === 503 && data && data.error === 'no_access') { showNoAccess(data.detail); throw new Error('no access'); }
  if (!res.ok) throw new Error((data && (data.error || data.detail)) || `HTTP ${res.status}`);
  return data;
}
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

// ------------------------------------------------------------------ screens

function showScreen(id) {
  for (const s of ['login', 'noaccess', 'app']) $(s).hidden = s !== id;
}
function showLogin() {
  showScreen('login');
  setTimeout(() => $('password').focus(), 50);
}
function showNoAccess(detail) {
  showScreen('noaccess');
  $('noaccessDetail').textContent = detail ? `Details: ${detail}` : '';
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $('loginError').textContent = data.error || 'Sign-in failed'; return; }
    $('password').value = '';
    start();
  } catch (err) {
    $('loginError').textContent = 'Could not reach the Mac.';
  }
});
$('retryAccess').addEventListener('click', () => start());

// ------------------------------------------------------------------ boot

let started = false;
async function start() {
  try {
    await api('/api/me');
  } catch (e) {
    if (!(e instanceof AuthError) && $('noaccess').hidden) {
      toast('Could not reach the Mac. Retrying…');
      setTimeout(start, 5000);
    }
    return;
  }
  showScreen('app');
  await loadConversations();
  if (!started) {
    started = true;
    connectEvents();
    setInterval(() => { if (!evtOK) refresh(); }, 15000);
    window.addEventListener('hashchange', route);
  }
  route();
}

// ------------------------------------------------------------------ live updates

let evtOK = false;
let evtSource = null;
function connectEvents() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.addEventListener('hello', () => { setConn(true); });
  evtSource.addEventListener('change', () => refreshSoon());
  evtSource.addEventListener('call', (e) => { try { onCallState(JSON.parse(e.data)); } catch (err) { /* calls.js not loaded */ } });
  evtSource.onerror = () => {
    setConn(false);
    // EventSource retries on its own; check whether we got logged out.
    api('/api/me').catch(() => {});
  };
}
function setConn(ok) {
  if (ok && !evtOK) refreshSoon();
  evtOK = ok;
  $('connDot').classList.toggle('off', !ok);
  $('connDot').title = ok ? 'Live updates connected' : 'Reconnecting…';
}
const refreshSoon = debounce(() => refresh(), 120);
let refreshing = null;
async function refresh() {
  if (refreshing) { refreshing.again = true; return; }
  refreshing = { again: false };
  try {
    await Promise.all([loadConversations(), state.currentId ? loadLatest() : null]);
  } catch (e) { /* handled in api() */ }
  const again = refreshing.again;
  refreshing = null;
  if (again) refresh();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshSoon();
    if (state.currentId) markRead(state.currentId);
  }
});

// ------------------------------------------------------------------ conversation list

async function loadConversations() {
  const data = await api('/api/conversations');
  const convs = data.conversations;
  for (const c of convs) c.title = convTitle(c);
  detectIncoming(convs);
  state.convs = convs;
  state.convById = new Map(convs.map((c) => [c.id, c]));
  renderList();
  updateTitle();
  if (state.currentId) {
    renderHeader();
    // A list fetched while a read was in flight can still count the open conversation as unread.
    const cur = state.convById.get(state.currentId);
    if (cur && cur.unread) markRead(cur.id);
  }
}

function detectIncoming(convs) {
  const prev = state.lastIds;
  state.lastIds = new Map(convs.map((c) => [c.id, c.lastId]));
  if (!prev) return;
  const fresh = convs.filter((c) => c.lastId !== prev.get(c.id) && !c.fromMe && c.unread > 0);
  if (!fresh.length) return;
  const viewing = document.visibilityState === 'visible';
  const notable = fresh.filter((c) => !(viewing && c.id === state.currentId));
  if (!notable.length) return;
  if (settings.sound) ping();
  if (settings.notify && 'Notification' in window && Notification.permission === 'granted' && !viewing) {
    for (const c of notable.slice(0, 3)) {
      const n = new Notification(c.title, { body: c.snippet, tag: 'conv-' + c.id, icon: '/icon.svg' });
      n.onclick = () => { window.focus(); location.hash = '#/c/' + c.id; n.close(); };
    }
  }
}

let audioCtx = null;
function ping() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1320, 0.09]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + d);
      o.stop(t + d + 0.3);
    });
  } catch (e) { /* audio blocked until user interacts */ }
}

function updateTitle() {
  const n = state.convs.reduce((a, c) => a + (c.unread ? 1 : 0), 0);
  document.title = n ? `(${n}) Messages` : 'Messages';
}

function convRowHtml(c) {
  const unread = c.unread ? ' unread' : '';
  let snippet = esc(c.snippet || '');
  if (c.fromMe && snippet) snippet = 'You: ' + snippet;
  if (c.error) snippet = '<span class="err">Not delivered</span> · ' + snippet;
  return `<button class="conv${unread}" data-id="${c.id}" role="listitem"${c.unread ? ` title="${c.unread} unread"` : ''}>
    <span class="dot"></span>
    ${convAvatar(c)}
    <span class="conv-text">
      <span class="conv-top"><span class="conv-name">${esc(c.title)}</span><span class="conv-time">${fmtListDate(c.date)}${CHEV}</span></span>
      <span class="conv-snippet">${snippet}</span>
    </span>
  </button>`;
}

function highlight(text, term) {
  const t = esc(text);
  if (!term) return t;
  const re = new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return t.replace(re, (m) => `<mark>${m}</mark>`);
}

function renderList() {
  const list = $('convList');
  const term = state.searchTerm.trim().toLowerCase();
  const items = [];
  let convs = state.convs;
  if (term) {
    convs = convs.filter((c) => c.title.toLowerCase().includes(term)
      || (c.participants || []).some((p) => (p.handle || '').toLowerCase().includes(term) || (p.handle || '').replace(/\D/g, '').includes(term.replace(/\D/g, '') || '\u0000')));
    items.push({ key: 'lbl-c', html: `<div class="list-label">Conversations</div>` });
  }
  for (const c of convs) items.push({ key: 'c' + c.id, html: convRowHtml(c) });
  if (term && !convs.length) items.push({ key: 'none-c', html: '<div class="list-empty">No matching conversations</div>' });
  if (term && state.searchResults) {
    items.push({ key: 'lbl-m', html: `<div class="list-label">Messages</div>` });
    if (!state.searchResults.length) items.push({ key: 'none-m', html: '<div class="list-empty">No matching messages</div>' });
    for (const r of state.searchResults) {
      const c = state.convById.get(r.convId) || { id: r.convId, participants: [], title: r.convTitle };
      const who = r.fromMe ? 'You: ' : (c.isGroup && r.senderName ? esc(fmtHandle(r.senderName)) + ': ' : '');
      items.push({
        key: 'r' + r.id,
        html: `<button class="conv" data-id="${r.convId}" data-cursor="${esc(r.cursor)}" data-mid="${r.id}">
          <span class="dot"></span>
          ${convAvatar(c)}
          <span class="conv-text">
            <span class="conv-top"><span class="conv-name">${esc(c.title || r.convTitle)}</span><span class="conv-time">${fmtListDate(r.date)}${CHEV}</span></span>
            <span class="conv-snippet">${who}${highlight(r.text, state.searchTerm.trim())}</span>
          </span></button>`,
      });
    }
  } else if (term && term.length >= 2) {
    items.push({ key: 'lbl-m', html: `<div class="list-label">Messages</div>` });
    items.push({ key: 'srch', html: '<div class="list-empty">Searching…</div>' });
  }
  if (!term && !state.convs.length) items.push({ key: 'empty', html: '<div class="list-empty">No conversations yet</div>' });
  const animate = speed() > 0 && list._nodes && !term;
  const before = new Map();
  if (animate) for (const [k, r] of list._nodes) before.set(k, r.el.getBoundingClientRect().top);
  const added = reconcile(list, items);
  if (animate) {
    const addedKeys = new Set(added.map((a) => a.key));
    for (const [k, r] of list._nodes) {
      if (addedKeys.has(k)) { if (k[0] === 'c') flashClass(r.el, 'anim-new', 440); continue; }
      const dy = before.get(k) - r.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && Math.abs(dy) < 2000) {
        r.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
          { duration: 460 * speed(), easing: 'cubic-bezier(.32,1.2,.5,1)' });
      }
    }
  }
  // Toggled outside the HTML so selecting a conversation doesn't rebuild rows (and reload avatars).
  for (const el of list.querySelectorAll('.conv')) {
    el.classList.toggle('active', !el.dataset.cursor && Number(el.dataset.id) === state.currentId);
  }
}

$('convList').addEventListener('click', (e) => {
  const b = e.target.closest('.conv');
  if (!b) return;
  if (b.dataset.cursor) {
    jumpTo = { cursor: b.dataset.cursor, mid: Number(b.dataset.mid) };
    if (state.currentId === Number(b.dataset.id)) { openConversation(state.currentId, true); return; }
  }
  location.hash = '#/c/' + b.dataset.id;
});

const runSearch = debounce(async () => {
  const term = state.searchTerm.trim();
  if (term.length < 2) { state.searchResults = null; renderList(); return; }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(term));
    if (term === state.searchTerm.trim()) { state.searchResults = data.results; renderList(); }
  } catch (e) { /* ignore */ }
}, 300);
$('search').addEventListener('input', (e) => {
  state.searchTerm = e.target.value;
  state.searchResults = null;
  renderList();
  runSearch();
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.searchTerm = ''; state.searchResults = null; renderList(); }
});

// ------------------------------------------------------------------ routing

let jumpTo = null;
function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/c\/(\d+)/))) {
    openConversation(Number(m[1]));
  } else if (h.startsWith('#/new')) {
    openNew();
  } else {
    closeThread();
  }
}
function goBack() {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = '';
}

function setThreadVisible(on) {
  $('app').classList.toggle('in-thread', on);
  $('thread').classList.toggle('has-conv', on);
}

function closeThread() {
  closeDetails(true);
  state.currentId = null;
  state.draftTo = null;
  state.msgs = [];
  state.pending = [];
  setThreadVisible(false);
  $('threadHead').hidden = true;
  $('composer').hidden = true;
  $('toBar').hidden = true;
  clearMessages();
  renderList();
}

function clearMessages() {
  const list = $('msgList');
  list.innerHTML = '';
  list._nodes = null;
  $('older').textContent = '';
  $('jumpBtn').hidden = true;
}

// ------------------------------------------------------------------ thread

async function openConversation(id, force) {
  if (state.currentId === id && !force && !jumpTo) return;
  const switching = state.currentId !== id;
  state.currentId = id;
  state.draftTo = null;
  if (switching) {
    closeDetails(true);
    state.msgs = [];
    state.pending = [];
    state.hasMore = false;
    clearTray();
    clearMessages();
    $('input').value = loadDraft(id);
  }
  setThreadVisible(true);
  $('threadHead').hidden = false;
  $('composer').hidden = false;
  $('toBar').hidden = true;
  autosize();
  renderHeader();
  if (switching) flashClass($('headMain'), 'anim-swap', 480);
  renderList();
  if (!isTouch) setTimeout(() => $('input').focus({ preventScroll: true }), 0);

  const seq = ++state.loadSeq;
  $('older').textContent = 'Loading…';
  try {
    const target = jumpTo;
    jumpTo = null;
    let msgs, hasMore;
    if (target) {
      const [after, before] = await Promise.all([
        api(`/api/conversations/${id}/messages?since=${encodeURIComponent(target.cursor)}`),
        api(`/api/conversations/${id}/messages?before=${encodeURIComponent(target.cursor)}&limit=25`),
      ]);
      msgs = before.messages.concat(after.messages);
      hasMore = before.hasMore;
    } else {
      const data = await api(`/api/conversations/${id}/messages?limit=60`);
      msgs = data.messages;
      hasMore = data.hasMore;
    }
    if (seq !== state.loadSeq) return;
    state.msgs = msgs;
    state.hasMore = hasMore;
    state.reactCounts = new Map();
    renderMessages();
    flashClass($('msgList'), 'anim-enter', 440);
    if (target) {
      const el = $('msgList').querySelector(`.msg[data-id="${target.mid}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1700);
      }
    } else {
      $('scroller').scrollTop = 0;
    }
  } catch (e) {
    if (!(e instanceof AuthError)) $('older').textContent = 'Could not load messages.';
    return;
  }
  markRead(id);
}

function markRead(id) {
  if (document.visibilityState !== 'visible') return;
  const c = state.convById.get(id);
  if (c && c.unread) { c.unread = 0; renderList(); updateTitle(); }
  postJSON(`/api/conversations/${id}/read`).catch(() => {});
}

function renderHeader() {
  const c = state.convById.get(state.currentId);
  $('infoBtn').hidden = !c;
  $('callBtn').hidden = !c || c.isGroup || (c.participants || []).length !== 1;
  if (!c) {
    $('headTitle').textContent = 'Conversation';
    $('headSub').textContent = '';
    $('headAvatar').innerHTML = '';
    return;
  }
  $('headAvatar').innerHTML = convAvatar(c, 'md');
  $('headTitle').textContent = c.title;
  const ps = c.participants || [];
  let sub;
  if (ps.length > 1) sub = `${ps.length} people`;
  else if (ps[0] && ps[0].name) sub = fmtHandle(ps[0].handle);
  else sub = '';
  const sms = /sms|rcs/i.test(c.service);
  const svc = sms ? 'Text Message' : 'iMessage';
  $('headSub').textContent = sub ? `${sub} · ${svc}` : svc;
  $('input').placeholder = svc;
  $('composer').classList.toggle('sms', sms);
}

async function loadLatest() {
  const id = state.currentId;
  if (!id || !state.msgs.length) return;
  const anchor = state.msgs[Math.max(0, state.msgs.length - 40)];
  const data = await api(`/api/conversations/${id}/messages?since=${encodeURIComponent(anchor.cursor)}`);
  if (id !== state.currentId) return;
  const keep = state.msgs.filter((m) => cmpCursor(m.cursor, anchor.cursor) < 0);
  state.msgs = keep.concat(data.messages);
  resolvePending();
  const atBottom = nearBottom();
  renderMessages({ animate: true });
  if (atBottom) $('scroller').scrollTop = 0;
  if (document.visibilityState === 'visible') {
    const c = state.convById.get(id);
    if (c && c.unread) markRead(id);
  }
}

function cmpCursor(a, b) {
  const [ad, ai] = a.split('_').map(Number);
  const [bd, bi] = b.split('_').map(Number);
  return ad - bd || ai - bi;
}

async function loadOlder() {
  const id = state.currentId;
  if (!id || !state.hasMore || state.loadingOlder || !state.msgs.length) return;
  state.loadingOlder = true;
  $('older').textContent = 'Loading…';
  try {
    const data = await api(`/api/conversations/${id}/messages?before=${encodeURIComponent(state.msgs[0].cursor)}&limit=60`);
    if (id !== state.currentId) return;
    const have = new Set(state.msgs.map((m) => m.id));
    state.msgs = data.messages.filter((m) => !have.has(m.id)).concat(state.msgs);
    state.hasMore = data.hasMore;
    renderMessages();
  } catch (e) {
    /* leave as-is */
  } finally {
    state.loadingOlder = false;
    if (id === state.currentId) $('older').textContent = state.hasMore ? '' : (state.msgs.length ? 'Beginning of conversation' : '');
  }
}

function nearBottom() { return Math.abs($('scroller').scrollTop) < 120; }

$('scroller').addEventListener('scroll', () => {
  const s = $('scroller');
  const fromTop = s.scrollHeight - s.clientHeight - Math.abs(s.scrollTop);
  if (fromTop < 600) loadOlder();
  $('jumpBtn').hidden = Math.abs(s.scrollTop) < 600;
}, { passive: true });
$('jumpBtn').addEventListener('click', () => { $('scroller').scrollTo({ top: 0, behavior: 'smooth' }); });

function needsSep(a, b) {
  if (!a) return true;
  return b.date - a.date > 3600000 || startOfDay(a.date) !== startOfDay(b.date);
}
function sameCluster(a, b) {
  return a && b && !a.system && !b.system && a.fromMe === b.fromMe && a.sender === b.sender && Math.abs(b.date - a.date) < 300000 && !needsSep(a, b);
}

function statusFor(m) {
  if (m.pendingStatus === 'sending') return '<div class="status">Sending…</div>';
  if (m.pendingStatus === 'failed') return `<div class="status err">Not Delivered<button data-retry="${m.tempId}">Retry</button><button data-discard="${m.tempId}">Remove</button></div>`;
  if (m.pendingStatus === 'sent') return '<div class="status">Sent</div>';
  if (m.error) return '<div class="status err">Not Delivered</div>';
  if (m.dateRead) return `<div class="status"><b>Read</b> ${fmtTime(m.dateRead)}</div>`;
  if (m.delivered) return '<div class="status">Delivered</div>';
  if (/sms|rcs/i.test(m.service)) return '<div class="status">Sent as Text Message</div>';
  return '<div class="status">Sent</div>';
}

function attachmentHtml(a, pending) {
  const src = pending ? a.url : `/api/attachments/${a.id}`;
  if (a.missing) return `<div class="att-missing">${esc(a.name)} — not downloaded on this Mac</div>`;
  if (a.kind === 'image') {
    const thumb = pending ? a.url : `${src}?v=thumb`;
    return `<img class="att-img${a.sticker ? ' sticker' : ''}" src="${thumb}" alt="${esc(a.name)}" loading="lazy" data-view="${pending ? '' : a.id}" data-kind="image">`;
  }
  if (a.kind === 'video') {
    return `<video class="att-video" src="${src}" controls preload="metadata" playsinline></video>
      <div class="att-alt"><a href="${src}?v=download">Download ${esc(a.name)}</a></div>`;
  }
  if (a.kind === 'audio') {
    return `<audio class="att-audio" src="${pending ? src : src + '?v=view'}" controls preload="none"></audio>`;
  }
  return `<a class="att-file" href="${pending ? src : src + '?v=download'}" ${pending ? '' : 'download'}>
    ${ICON.file}<span><b>${esc(a.name)}</b><small>${fmtSize(a.size)}</small></span></a>`;
}

function reactionsHtml(rs) {
  if (!rs || !rs.length) return '';
  const emojiOf = (r) => (r.type === 'emoji' && r.emoji ? r.emoji : REACT_EMOJI[r.type] || '❤️');
  // One tapback bubble per distinct reaction; it's blue when it includes yours.
  const groups = [];
  for (const r of rs) {
    const e = emojiOf(r);
    let g = groups.find((x) => x.e === e);
    if (!g) groups.push((g = { e, mine: false }));
    if (r.fromMe) g.mine = true;
  }
  const who = rs.map((r) => `${r.fromMe ? 'You' : fmtHandle(r.sender || '')}: ${emojiOf(r)}`).join('\n');
  return `<div class="reacts" title="${esc(who)}">${groups.slice(0, 3).map((g) => `<span class="tb${g.mine ? ' mine' : ''}">${g.e}</span>`).join('')}</div>`;
}

function renderMessages(opts = {}) {
  const c = state.convById.get(state.currentId);
  const isGroup = !!(c && (c.isGroup || (c.participants || []).length > 1));
  const pend = state.pending.map((p) => ({
    id: 'p' + p.tempId, tempId: p.tempId, date: p.time, fromMe: true, sender: null, text: p.text || '',
    attachments: p.file ? [{ kind: p.file.type.startsWith('image/') ? 'image' : 'file', url: p.url, name: p.file.name, size: p.file.size }] : [],
    reactions: [], pendingStatus: p.status, pending: true, service: c ? c.service : '',
  }));
  const all = state.msgs.concat(pend);
  let lastOut = -1;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].fromMe && !all[i].system) { lastOut = i; break; }

  const items = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    const prev = all[i - 1];
    const next = all[i + 1];
    if (needsSep(prev, m)) items.push({ key: 'sep' + m.id, html: `<div class="sep">${fmtSep(m.date)}</div>` });
    if (m.system) {
      items.push({ key: 'm' + m.id, html: `<div class="sys" title="${esc(fmtFull(m.date))}">${esc(m.text)}</div>` });
      continue;
    }
    const first = !sameCluster(prev, m);
    const last = !sameCluster(m, next);
    const cls = ['msg', m.fromMe ? 'out' : 'in'];
    if (first) cls.push('first');
    if (last) cls.push('last');
    if (isGroup) cls.push('group');
    if (/sms|rcs/i.test(m.service)) cls.push('sms');
    if (m.pending) cls.push('pending');
    const big = !m.attachments.length && isBigEmoji(m.text);
    if (big) cls.push('big-emoji');
    if (m.reactions && m.reactions.length) cls.push('has-react');

    let h = `<div class="${cls.join(' ')}" data-id="${m.id}">`;
    if (isGroup && !m.fromMe && first) h += `<div class="sender" data-handle="${esc(m.sender || '')}">${esc(m.senderName ? fmtHandle(m.senderName) : fmtHandle(m.sender))}</div>`;
    h += '<div class="line">';
    if (isGroup && !m.fromMe) {
      const p = (c.participants || []).find((x) => x.handle === m.sender) || { handle: m.sender || '?', name: m.senderName };
      h += `<div class="msg-av"${last ? ` data-handle="${esc(m.sender || '')}"` : ''}>${last ? avatar(p, 'sm') : ''}</div>`;
    }
    h += '<div class="body">';
    if (m.replyTo) {
      const who = m.replyTo.fromMe ? 'You' : fmtHandle(m.replyTo.sender || '');
      h += `<div class="reply-quote" title="${esc(m.replyTo.text)}">↩ ${esc(who)}: ${esc(m.replyTo.text)}</div>`;
    }
    h += '<div class="content">';
    for (const a of m.attachments) h += attachmentHtml(a, m.pending);
    if (m.text) h += `<div class="bubble" title="${esc(fmtFull(m.date))}">${linkify(m.text)}</div>`;
    h += reactionsHtml(m.reactions);
    h += '</div></div></div>';
    if (m.edited) h += '<div class="edited">Edited</div>';
    h += `<div class="meta">${esc(fmtFull(m.date))}</div>`;
    if (i === lastOut || m.pendingStatus === 'failed') h += statusFor(m);
    h += '</div>';
    items.push({ key: 'm' + m.id, html: h });
  }
  const added = reconcile($('msgList'), items);
  const counts = new Map(state.msgs.map((m) => [m.id, (m.reactions || []).length]));
  if (opts.animate && speed()) {
    for (const { key, el } of added) {
      if (el.classList.contains('sep') || el.classList.contains('sys')) flashClass(el, 'anim-fade', 300);
      else if (el.classList.contains('out')) { if (!state.quietIds.has(Number(el.dataset.id))) flashClass(el, 'anim-out', 440); }
      else if (el.classList.contains('in')) flashClass(el, 'anim-in', 440);
    }
    for (const [id, n] of counts) {
      if (n > (state.reactCounts.get(id) || 0)) flashClass($('msgList').querySelector(`.msg[data-id="${id}"]`), 'react-new', 500);
    }
  }
  state.reactCounts = counts;
  if (!state.hasMore && state.msgs.length) $('older').textContent = 'Beginning of conversation';
  else if (!state.loadingOlder) $('older').textContent = '';
  if (!all.length && state.currentId) $('older').textContent = 'No messages yet';
}

// tap a message to show its full timestamp; open images in the lightbox; retry/remove failed sends
$('msgList').addEventListener('click', (e) => {
  const retry = e.target.closest('[data-retry]');
  if (retry) { retrySend(Number(retry.dataset.retry)); return; }
  const discard = e.target.closest('[data-discard]');
  if (discard) {
    state.pending = state.pending.filter((p) => p.tempId !== Number(discard.dataset.discard));
    renderMessages();
    return;
  }
  const img = e.target.closest('img[data-kind="image"]');
  if (img && !img.classList.contains('sticker')) { openLightbox(img.dataset.view, 'image', img.src, img.alt); return; }
  const who = e.target.closest('[data-handle]');
  if (who) { openDetails(who.dataset.handle); return; }
  if (e.target.closest('a, video, audio')) return;
  const msg = e.target.closest('.msg');
  if (msg && !window.getSelection().toString()) msg.classList.toggle('show-meta');
});

// ------------------------------------------------------------------ lightbox

function openLightbox(id, kind, fallbackSrc, alt) {
  const full = id ? `/api/attachments/${id}${kind === 'video' ? '' : '?v=view'}` : fallbackSrc;
  $('lbBody').innerHTML = kind === 'video'
    ? `<video src="${esc(full)}" controls autoplay playsinline></video>`
    : `<img src="${esc(full)}" alt="${esc(alt || '')}">`;
  const dl = $('lbDownload');
  dl.href = id ? `/api/attachments/${id}?v=download` : fallbackSrc;
  dl.hidden = false;
  $('lightbox').hidden = false;
  history.pushState({ lightbox: true }, '');
}
function closeLightbox(fromPop) {
  if ($('lightbox').hidden) return;
  $('lightbox').hidden = true;
  $('lbBody').innerHTML = '';
  if (!fromPop && history.state && history.state.lightbox) history.back();
}
$('lbClose').addEventListener('click', () => closeLightbox());
$('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lbBody' || e.target.id === 'lightbox') closeLightbox(); });
window.addEventListener('popstate', () => {
  if (!$('lightbox').hidden) closeLightbox(true);
  else closeDetails(true);
});

// ------------------------------------------------------------------ composer

const DRAFT_KEY = 'webim.drafts';
function loadDraft(id) { return (load(DRAFT_KEY, {}) || {})[id] || ''; }
const saveDraft = debounce((id, text) => {
  const d = load(DRAFT_KEY, {}) || {};
  if (text) d[id] = text; else delete d[id];
  save(DRAFT_KEY, d);
}, 400);

function autosize() {
  const t = $('input');
  t.style.height = 'auto';
  if (t.scrollHeight) t.style.height = Math.min(t.scrollHeight, 168) + 'px';
  $('sendBtn').disabled = !t.value.trim() && !state.tray.length;
}
$('input').addEventListener('input', () => {
  autosize();
  if (state.currentId) saveDraft(state.currentId, $('input').value);
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(isTouch && mobileMQ.matches)) {
    e.preventDefault();
    send();
  }
});
$('sendBtn').addEventListener('click', () => { send(); if (!isTouch) $('input').focus(); });
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

let dragDepth = 0;
$('thread').addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files') || $('composer').hidden) return;
  dragDepth++;
  $('thread').classList.add('dragging');
});
$('thread').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('thread').classList.remove('dragging'); } });
$('thread').addEventListener('dragover', (e) => { if (!$('composer').hidden) e.preventDefault(); });
$('thread').addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('thread').classList.remove('dragging');
  if (!$('composer').hidden && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

function addFiles(files) {
  for (const f of files) {
    if (f.size > 100 * 1024 * 1024) { toast(`${f.name} is larger than 100 MB`); continue; }
    state.tray.push({ file: f, url: URL.createObjectURL(f) });
  }
  renderTray();
  autosize();
}
function renderTray() {
  $('tray').innerHTML = state.tray.map((t, i) => `<div class="chip">
      ${t.file.type.startsWith('image/') ? `<img src="${t.url}" alt="">` : esc(t.file.name)}
      <button class="x" data-i="${i}" aria-label="Remove ${esc(t.file.name)}">${ICON.close}</button></div>`).join('');
}
$('tray').addEventListener('click', (e) => {
  const b = e.target.closest('.x');
  if (!b) return;
  const [t] = state.tray.splice(Number(b.dataset.i), 1);
  if (t) URL.revokeObjectURL(t.url);
  renderTray();
  autosize();
});
function clearTray() { state.tray = []; renderTray(); }

let tempSeq = 1;
async function send() {
  const text = $('input').value.trim();
  const files = state.tray.slice();
  if (!text && !files.length) return;
  if (state.draftTo) return sendNew(text, files);
  const id = state.currentId;
  if (!id) return;
  $('input').value = '';
  state.tray = [];
  renderTray();
  autosize();
  saveDraft(id, '');
  const jobs = files.map((t) => ({ tempId: tempSeq++, file: t.file, url: t.url, time: Date.now(), status: 'sending', convId: id }));
  if (text) jobs.push({ tempId: tempSeq++, text, time: Date.now(), status: 'sending', convId: id });
  state.pending.push(...jobs);
  renderMessages({ animate: true });
  $('scroller').scrollTop = 0;
  for (const j of jobs) await deliver(j);
}

async function deliver(j) {
  try {
    if (j.file) {
      await api(`/api/conversations/${j.convId}/send-file?name=${encodeURIComponent(j.file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: j.file,
      });
    } else {
      await postJSON(`/api/conversations/${j.convId}/send`, { text: j.text });
    }
    j.status = 'sent';
    j.sentAt = Date.now();
  } catch (e) {
    j.status = 'failed';
    if (!(e instanceof AuthError)) toast('Message not sent: ' + e.message);
  }
  if (j.convId === state.currentId) { resolvePending(); renderMessages(); }
}

function retrySend(tempId) {
  const j = state.pending.find((p) => p.tempId === tempId);
  if (!j) return;
  j.status = 'sending';
  j.time = Date.now();
  renderMessages();
  deliver(j);
}

/** Drop optimistic bubbles once the real message shows up in chat.db. */
function resolvePending() {
  if (!state.pending.length) return;
  const mine = state.msgs.filter((m) => m.fromMe && !m.system);
  const used = new Set();
  state.pending = state.pending.filter((p) => {
    if (p.status !== 'sent') return true;
    const match = mine.find((m) => !used.has(m.id) && m.date >= p.time - 15000
      && (p.file ? m.attachments.length > 0 : m.text.trim() === p.text.trim()));
    if (match) { used.add(match.id); state.quietIds.add(match.id); if (p.url) URL.revokeObjectURL(p.url); return false; }
    // Give up waiting after two minutes; the real message will be in the list by then or the send silently failed.
    return Date.now() - p.sentAt < 120000;
  });
}

// ------------------------------------------------------------------ new conversation

async function openNew() {
  closeDetails(true);
  state.currentId = null;
  state.draftTo = null;
  state.msgs = [];
  state.pending = [];
  clearMessages();
  clearTray();
  setThreadVisible(true);
  $('threadHead').hidden = false;
  $('headAvatar').innerHTML = avatar({ handle: 'new' }, 'md');
  $('headTitle').textContent = 'New Message';
  $('composer').classList.remove('sms');
  $('infoBtn').hidden = true;
  $('callBtn').hidden = true;
  $('headSub').textContent = '';
  $('toBar').hidden = false;
  $('composer').hidden = true;
  $('toInput').value = '';
  $('input').value = '';
  $('input').placeholder = 'iMessage';
  renderList();
  $('older').textContent = '';
  setTimeout(() => $('toInput').focus(), 50);
  if (!state.contacts) {
    try { state.contacts = (await api('/api/contacts')).contacts; } catch (e) { state.contacts = []; }
    renderSuggest();
  } else {
    renderSuggest();
  }
}

let suggIndex = 0;
let suggItems = [];
function renderSuggest() {
  const q = $('toInput').value.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const out = [];
  if (q) {
    for (const p of state.contacts || []) {
      const nameHit = p.name.toLowerCase().includes(q);
      for (const h of p.handles) {
        if (nameHit || h.toLowerCase().includes(q) || (digits.length >= 3 && h.replace(/\D/g, '').includes(digits))) out.push({ name: p.name, handle: h });
      }
      if (out.length > 40) break;
    }
    const raw = $('toInput').value.trim();
    if (/^[+\d\s().-]{7,}$/.test(raw) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) out.unshift({ name: null, handle: raw, raw: true });
  } else {
    // Show recent 1:1 conversations as quick picks.
    for (const c of state.convs.filter((c) => !c.isGroup && c.participants.length === 1).slice(0, 12)) {
      out.push({ name: c.participants[0].name, handle: c.participants[0].handle, hasPhoto: c.participants[0].hasPhoto });
    }
  }
  suggItems = out;
  suggIndex = 0;
  $('toSuggest').innerHTML = out.map((s, i) => `<button class="sugg${i === 0 ? ' on' : ''}" data-i="${i}" role="option">
    ${avatar({ handle: s.handle, name: s.name, hasPhoto: s.hasPhoto }, 'md')}
    <span>${s.raw ? `Send to <b>${esc(fmtHandle(s.handle))}</b>` : esc(s.name || fmtHandle(s.handle))}${!s.raw && s.name ? `<small>${esc(fmtHandle(s.handle))}</small>` : ''}</span>
  </button>`).join('');
}
$('toInput').addEventListener('input', renderSuggest);
$('toInput').addEventListener('keydown', (e) => {
  const els = $('toSuggest').querySelectorAll('.sugg');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!els.length) return;
    suggIndex = (suggIndex + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length;
    els.forEach((el, i) => el.classList.toggle('on', i === suggIndex));
    els[suggIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (suggItems[suggIndex]) pickRecipient(suggItems[suggIndex]);
    else if ($('toInput').value.trim()) pickRecipient({ handle: $('toInput').value.trim(), name: null });
  }
});
$('toSuggest').addEventListener('click', (e) => {
  const b = e.target.closest('.sugg');
  if (b) pickRecipient(suggItems[Number(b.dataset.i)]);
});

async function pickRecipient(s) {
  $('toSuggest').innerHTML = '';
  try {
    const r = await api('/api/lookup?h=' + encodeURIComponent(s.handle));
    if (r.convId) { location.replace('#/c/' + r.convId); return; }
  } catch (e) { return; }
  state.draftTo = s;
  $('toBar').hidden = true;
  $('composer').hidden = false;
  $('headAvatar').innerHTML = avatar({ handle: s.handle, name: s.name }, 'md');
  $('headTitle').textContent = s.name || fmtHandle(s.handle);
  $('headSub').textContent = s.name ? fmtHandle(s.handle) : 'New conversation';
  $('older').textContent = 'Send a message to start the conversation';
  autosize();
  $('input').focus();
}

async function sendNew(text, files) {
  const to = state.draftTo.handle;
  $('sendBtn').disabled = true;
  try {
    let convId = null;
    if (text) convId = (await postJSON('/api/new', { to, text })).convId;
    for (const t of files) {
      const r = await api(`/api/new?to=${encodeURIComponent(to)}&name=${encodeURIComponent(t.file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: t.file,
      });
      convId = convId || r.convId;
    }
    $('input').value = '';
    clearTray();
    state.draftTo = null;
    await loadConversations();
    if (convId) location.replace('#/c/' + convId);
    else { toast('Sent. The conversation will appear shortly.'); location.replace('#'); }
  } catch (e) {
    if (!(e instanceof AuthError)) toast('Could not send: ' + e.message, 5000);
  } finally {
    autosize();
  }
}

$('newBtn').addEventListener('click', () => { location.hash = '#/new'; });
$('backBtn').addEventListener('click', goBack);

// ------------------------------------------------------------------ contact details

const DICON = {
  message: '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.5 1.4 4.7 3.7 6.2-.2 1.3-.9 2.6-2 3.6 2.1 0 4-.8 5.3-1.9.9.2 2 .3 3 .3 5.5 0 10-3.6 10-8.1S17.5 3 12 3z"/></svg>',
  call: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M15 8.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1.5l5.3 3.4c.7.4 1.7-.1 1.7-.9V6c0-.8-1-1.3-1.7-.9L15 8.5z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v.5l8 5 8-5V7H4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M8 3h9a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
};

const det = { convId: null, data: null, person: null, allPhotos: false, allLinks: false, allFiles: false };

async function openDetails(personHandle) {
  const id = state.currentId;
  if (!id) return;
  const panel = $('details');
  panel.classList.remove('closing');
  clearTimeout(panel._closeT);
  if (panel.hidden) {
    panel.hidden = false;
    $('thread').classList.add('details-open');
    if (mobileMQ.matches) history.pushState({ details: true }, '');
  }
  det.person = personHandle || null;
  det.allPhotos = det.allLinks = det.allFiles = false;
  if (det.convId !== id) { det.convId = id; det.data = null; }
  if (det.data) renderDetails();
  else $('detBody').innerHTML = '<div class="det-loading">Loading…</div>';
  try {
    const data = await api(`/api/conversations/${id}/details`);
    if (det.convId !== id || panel.hidden) return;
    det.data = data;
    renderDetails();
  } catch (e) {
    if (!det.data) $('detBody').innerHTML = '<div class="det-loading">Could not load details.</div>';
  }
}

function closeDetails(fromPop) {
  const panel = $('details');
  if (panel.hidden || panel.classList.contains('closing')) return;
  $('thread').classList.remove('details-open');
  if (speed()) {
    panel.classList.add('closing');
    panel._closeT = setTimeout(() => { panel.hidden = true; panel.classList.remove('closing'); }, 300 * speed());
  } else {
    panel.hidden = true;
  }
  if (!fromPop && history.state && history.state.details) history.back();
}

function detRow(label, valueHtml) {
  return `<div class="det-row"><span class="grow"><small>${esc(label)}</small><span class="v">${valueHtml}</span></span></div>`;
}

function renderDetails() {
  const d = det.data;
  if (!d) return;
  const c = state.convById.get(det.convId) || { id: det.convId, participants: d.people, title: d.name || '' };
  const group = d.isGroup || d.people.length > 1;
  const person = det.person ? d.people.find((p) => p.handle === det.person) : (group ? null : d.people[0]);
  $('detBack').hidden = !(group && person);
  let h = person ? personDetailsHtml(person, group) : groupDetailsHtml(d, c);
  if (!person || !group) h += sharedHtml(d);
  const body = $('detBody');
  const keepScroll = body.dataset.view === (person ? person.handle : 'group') ? body.scrollTop : 0;
  const view = person ? person.handle : 'group';
  const changed = body.dataset.view !== view || !body.childElementCount || body.querySelector('.det-loading');
  body.innerHTML = h;
  body.dataset.view = view;
  if (changed) flashClass(body, 'enter', 600);
  body.scrollTop = keepScroll;
}

function personDetailsHtml(p, inGroup) {
  const card = p.card || {};
  const name = p.name || fmtHandle(p.handle);
  const isEmail = p.handle.includes('@');
  const sub = [card.jobTitle, card.organization].filter(Boolean).join(' · ')
    || (card.nickname ? `“${card.nickname}”` : '') || (p.name ? '' : 'Not in Contacts');
  const phones = (card.phones && card.phones.length) ? card.phones : (isEmail ? [] : [{ label: 'phone', value: p.handle }]);
  const emails = (card.emails && card.emails.length) ? card.emails : (isEmail ? [{ label: 'email', value: p.handle }] : []);
  const mail = emails[0] ? emails[0].value : null;
  const action = (icon, label, href) => (href
    ? `<a class="det-action" href="${esc(href)}">${DICON[icon]}${label}</a>`
    : `<span class="det-action" aria-disabled="true">${DICON[icon]}${label}</span>`);

  let h = `<div class="det-hero">${avatar(p, 'lg')}<h2 class="det-name">${esc(name)}</h2>${sub ? `<div class="det-sub">${esc(sub)}</div>` : ''}</div>`;
  h += '<div class="det-actions">';
  h += inGroup
    ? `<button class="det-action" data-act="message" data-h="${esc(p.handle)}" data-n="${esc(p.name || '')}">${DICON.message}message</button>`
    : `<button class="det-action" data-act="copy" data-v="${esc(p.handle)}">${DICON.copy}copy</button>`;
  h += `<button class="det-action" data-act="call" data-h="${esc(p.handle)}" data-n="${esc(name)}">${DICON.call}call</button>`;
  h += `<button class="det-action" data-act="video" data-h="${esc(p.handle)}" data-n="${esc(name)}">${DICON.video}video</button>`;
  h += action('mail', 'mail', mail && 'mailto:' + mail);
  h += '</div>';

  const rows = [];
  for (const ph of phones) {
    rows.push(`<a class="det-row" href="tel:${esc(ph.value.replace(/[^\d+]/g, ''))}"><span class="grow"><small>${esc(ph.label)}</small><span class="v link">${esc(fmtHandle(ph.value))}</span></span></a>`);
  }
  for (const em of emails) {
    rows.push(`<a class="det-row" href="mailto:${esc(em.value)}"><span class="grow"><small>${esc(em.label)}</small><span class="v link">${esc(em.value)}</span></span></a>`);
  }
  if (rows.length) h += `<div class="det-card">${rows.join('')}</div>`;

  const more = [];
  if (card.birthday) more.push(detRow('birthday', esc(card.birthday)));
  for (const a of card.addresses || []) {
    more.push(`<a class="det-row" target="_blank" rel="noopener noreferrer" href="https://maps.apple.com/?q=${encodeURIComponent(a.lines.join(', '))}"><span class="grow"><small>${esc(a.label)}</small><span class="v link">${a.lines.map(esc).join('<br>')}</span></span></a>`);
  }
  for (const u of card.urls || []) {
    const href = /^https?:/i.test(u.value) ? u.value : 'https://' + u.value;
    more.push(`<a class="det-row" target="_blank" rel="noopener noreferrer" href="${esc(href)}"><span class="grow"><small>${esc(u.label)}</small><span class="v link">${esc(u.value)}</span></span></a>`);
  }
  if (card.note) more.push(detRow('notes', `<span class="note">${esc(card.note)}</span>`));
  if (more.length) h += `<div class="det-card">${more.join('')}</div>`;
  return h;
}

function groupDetailsHtml(d, c) {
  let h = `<div class="det-hero">${convAvatar(c, 'lg')}<h2 class="det-name">${esc(c.title || convTitle(c))}</h2><div class="det-sub">${d.people.length} people</div></div>`;
  h += `<div class="det-head"><h3>Members</h3></div><div class="det-card">`;
  for (const p of d.people) {
    const sub = p.name ? fmtHandle(p.handle) : (p.card && p.card.organization) || '';
    h += `<button class="det-row" data-person="${esc(p.handle)}">${avatar(p, 'sm')}<span class="grow"><span class="v">${esc(p.name || fmtHandle(p.handle))}</span>${sub ? `<small style="text-transform:none">${esc(sub)}</small>` : ''}</span>${CHEV}</button>`;
  }
  return h + '</div>';
}

function sharedHtml(d) {
  let h = '';
  if (d.photos.length) {
    const shown = det.allPhotos ? d.photos : d.photos.slice(0, 9);
    h += `<div class="det-head"><h3>Photos</h3>${d.photos.length > 9 ? `<button data-more="photos">${det.allPhotos ? 'Show Less' : 'See All'}</button>` : `<span>${d.photoCount}</span>`}</div>`;
    h += '<div class="det-grid">' + shown.map((m) => (m.kind === 'video'
      ? `<button data-media="${m.id}" data-kind="video" aria-label="Video"><video src="/api/attachments/${m.id}#t=0.1" preload="metadata" muted playsinline></video><span class="play">${DICON.play}</span></button>`
      : `<button data-media="${m.id}" data-kind="image" aria-label="Photo"><img src="/api/attachments/${m.id}?v=thumb" alt="" loading="lazy"></button>`)).join('') + '</div>';
    if (det.allPhotos && d.photoCount > d.photos.length) h += `<p class="det-foot">Showing the latest ${d.photos.length} of ${d.photoCount}</p>`;
  }
  if (d.links.length) {
    const shown = det.allLinks ? d.links : d.links.slice(0, 4);
    h += `<div class="det-head"><h3>Links</h3>${d.links.length > 4 ? `<button data-more="links">${det.allLinks ? 'Show Less' : 'See All'}</button>` : ''}</div><div class="det-card">`;
    h += shown.map((l) => `<a class="det-row" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span class="link-ico">${esc((l.host || '?')[0])}</span><span class="grow"><span class="v ell">${esc(l.host)}</span><small class="ell" style="text-transform:none">${esc(l.url)}</small></span></a>`).join('');
    h += '</div>';
  }
  if (d.files.length) {
    const shown = det.allFiles ? d.files : d.files.slice(0, 4);
    h += `<div class="det-head"><h3>Documents</h3>${d.files.length > 4 ? `<button data-more="files">${det.allFiles ? 'Show Less' : 'See All'}</button>` : ''}</div><div class="det-card">`;
    h += shown.map((f) => `<a class="det-row" href="/api/attachments/${f.id}?v=download" download><span class="file-ico">${ICON.file}</span><span class="grow"><span class="v ell">${esc(f.name)}</span><small style="text-transform:none">${esc(fmtSize(f.size))} · ${esc(fmtListDate(f.date))}</small></span></a>`).join('');
    h += '</div>';
  }
  const svc = d.services.map((s) => (/sms|rcs/i.test(s) ? 'Text Message' : s === 'iMessage' ? 'iMessage' : s)).filter((v, i, a) => a.indexOf(v) === i).join(' & ');
  const since = d.since ? new Date(d.since).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  h += `<p class="det-foot">${d.messageCount.toLocaleString()} messages${since ? ` since ${esc(since)}` : ''}${svc ? `<br>${esc(svc)}` : ''}</p>`;
  return h;
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch (e) {
    // navigator.clipboard needs https; fall back for plain-http LAN use.
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied ' + fmtHandle(t));
}

async function messagePerson(handle, name) {
  try {
    const r = await api('/api/lookup?h=' + encodeURIComponent(handle));
    closeDetails();
    if (r.convId) { location.hash = '#/c/' + r.convId; return; }
    location.hash = '#/new';
    setTimeout(() => pickRecipient({ handle, name: name || null }), 60);
  } catch (e) { /* api() reports */ }
}

$('detBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-person], [data-media], [data-act], [data-more]');
  if (!t) return;
  if (t.dataset.person) { det.person = t.dataset.person; renderDetails(); $('detBody').scrollTop = 0; }
  else if (t.dataset.media) openLightbox(t.dataset.media, t.dataset.kind);
  else if (t.dataset.act === 'copy') copyText(t.dataset.v);
  else if (t.dataset.act === 'message') messagePerson(t.dataset.h, t.dataset.n);
  else if (t.dataset.act === 'call') chooseCall(t, t.dataset.h, t.dataset.n);
  else if (t.dataset.act === 'video') startCall(t.dataset.h, t.dataset.n, 'video');
  else if (t.dataset.more) {
    const k = { photos: 'allPhotos', links: 'allLinks', files: 'allFiles' }[t.dataset.more];
    det[k] = !det[k];
    renderDetails();
  }
});
$('detBack').addEventListener('click', () => { det.person = null; renderDetails(); });
$('detClose').addEventListener('click', () => closeDetails());
const toggleDetails = () => ($('details').hidden ? openDetails() : closeDetails());
$('infoBtn').addEventListener('click', toggleDetails);
$('headMain').addEventListener('click', () => { if (state.currentId) toggleDetails(); });

// ------------------------------------------------------------------ settings menu

function applyAnim() {
  const v = speed();
  document.documentElement.style.setProperty('--speed', v);
  if (v) delete document.documentElement.dataset.anim;
  else document.documentElement.dataset.anim = 'off';
  for (const b of $('animSeg').children) b.classList.toggle('on', b.dataset.anim === settings.anim);
}
$('animSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.anim = b.dataset.anim;
  save('webim.anim', settings.anim);
  applyAnim();
  flashClass($('menu'), 'demo', 400);
});

function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  for (const b of $('themeSeg').children) b.classList.toggle('on', b.dataset.theme === t);
}
function syncMenu() {
  $('soundToggle').checked = settings.sound;
  $('notifyToggle').checked = settings.notify && 'Notification' in window && Notification.permission === 'granted';
  const note = $('notifyNote');
  if (!window.isSecureContext) {
    note.hidden = false;
    note.textContent = 'Browsers only allow notifications on https or localhost pages. The tab title still shows unread counts.';
  } else note.hidden = true;
}
$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('menu');
  if (!m.hidden) { m.hidden = true; return; }
  syncMenu();
  const r = $('menuBtn').getBoundingClientRect();
  m.style.top = r.bottom + 4 + 'px';
  m.style.left = Math.max(8, r.right - 270) + 'px';
  m.hidden = false;
});
document.addEventListener('click', (e) => { if (!$('menu').hidden && !e.target.closest('#menu')) $('menu').hidden = true; });
$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.theme = b.dataset.theme;
  try { if (b.dataset.theme === 'system') localStorage.removeItem('webim.theme'); else localStorage.setItem('webim.theme', b.dataset.theme); } catch (err) { /* ignore */ }
  if (document.startViewTransition && speed()) document.startViewTransition(applyTheme);
  else applyTheme();
});
$('soundToggle').addEventListener('change', (e) => { settings.sound = e.target.checked; save('webim.sound', settings.sound); if (settings.sound) ping(); });
$('notifyToggle').addEventListener('change', async (e) => {
  if (e.target.checked) {
    if (!('Notification' in window) || !window.isSecureContext) { e.target.checked = false; toast('Notifications need an https connection.'); return; }
    const p = await Notification.requestPermission();
    settings.notify = p === 'granted';
    e.target.checked = settings.notify;
  } else settings.notify = false;
  save('webim.notify', settings.notify);
});
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.hash = '';
  location.reload();
});

// ------------------------------------------------------------------ keyboard + viewport

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('lightbox').hidden) closeLightbox();
    else if (!$('details').hidden) closeDetails();
    else if (!$('menu').hidden) $('menu').hidden = true;
    else if (mobileMQ.matches && location.hash) goBack();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); }
});

// Track the visual viewport so the composer stays above the on-screen keyboard (iOS Safari).
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--app-h', vv.height + 'px');
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  fit();
}

new ResizeObserver(() => {
  $('thread').style.setProperty('--composer-h', $('composer').offsetHeight + 'px');
}).observe($('composer'));

applyTheme();
applyAnim();
start();
