'use strict';
// iMassage client. Talks to server.py on 127.0.0.1 (JSON API + one SSE stream, /api/events).
// Runs in the Electron shell (window.imassage is the preload bridge) or any browser.
// Message content is untrusted: DOM is built with textContent only, never innerHTML.

const $ = sel => document.querySelector(sel);
const shell = window.imassage || null;
if (shell) document.body.classList.add('desktop');

const els = {
  app: $('#app'), sidebar: $('#sidebar'), search: $('#search'), compose: $('#compose'), banner: $('#banner'),
  sideScroll: $('#side-scroll'), pins: $('#pins'), chatlist: $('#chatlist'), junk: $('#junk-toggle'), splitter: $('#splitter'),
  main: $('#main'), back: $('#back'), who: $('#who'), newTitle: $('#new-title'),
  toRow: $('#to-row'), toChips: $('#to-chips'), toInput: $('#to-input'), svcPick: $('#svc-pick'), suggest: $('#suggest'),
  messages: $('#messages'), thread: $('#thread'), replyBanner: $('#reply-banner'), tray: $('#tray'), attach: $('#attach'), field: $('#field'),
  input: $('#input'), emoji: $('#emoji'), send: $('#send'), empty: $('#empty'), details: $('#details'), drop: $('#drop'),
  lightbox: $('#lightbox'), lbStage: $('#lightbox .lb-stage'), lbPrev: $('#lightbox .lb-prev'), lbNext: $('#lightbox .lb-next'),
  lbName: $('#lightbox .lb-name'), lbSave: $('#lightbox .lb-save'), lbClose: $('#lightbox .lb-close'),
  menu: $('#menu'), toast: $('#toast'), file: $('#file'),
  findBtn: $('#find-btn'), find: $('#find'), findInput: $('#find-input'), findCount: $('#find-count'),
  findPrev: $('#find-prev'), findNext: $('#find-next'), findDone: $('#find-done'),
};

const S = {
  chats: new Map(),        // id -> chat (from /api/chats, kept current by events)
  current: null,           // chat id, 'new' while composing, or null
  threads: new Map(),      // chat id -> thread (see newThread)
  pending: [],             // optimistic outgoing messages
  lookups: new Map(),      // guid -> message, for reply previews outside the loaded page
  status: { connected: false },
  contactsSeen: -1,
  contacts: null,
  maxRowid: 0,             // highest message ROWID seen; anything above it is genuinely new
  showJunk: false,
  drafts: new Map(),
  tray: [],
  newTo: null, newSvc: 'iMessage', awaiting: null,
  hits: null,
  stick: true,
  seenSent: new Map(),
  booted: false,
  pins: [],
  settings: { sounds: true },
  details: false,
  media: new Map(),
  sideNodes: new Map(),    // sidebar row/tile cache: key -> {sig, node}
  lb: null,
  badge: -1,
  replyTo: null,
  editing: null,           // { m, chat, before } while the composer is editing a sent message
  find: null,              // { q, hits (newest first), i } for find-in-conversation
  scheduled: [],           // send-later queue held by the server
  chatLimit: 300,          // grows as the sidebar is scrolled to the end
};

const DAY = 86400000;
const I = {
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.6" r="4.4"/><path d="M3.6 22c.5-4.8 4-7.9 8.4-7.9s7.9 3.1 8.4 7.9z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21.2s-8.3-5-9.9-10.2C1 7.4 3.3 4 6.9 4c2.2 0 3.7 1.2 5.1 3 1.4-1.8 2.9-3 5.1-3 3.6 0 5.9 3.4 4.8 7-1.6 5.2-9.9 10.2-9.9 10.2z"/></svg>',
  thumb: '<svg viewBox="0 0 24 24"><path d="M2.5 10.5h4v10h-4zM8.5 20.5h9.1a2.2 2.2 0 0 0 2.15-1.75l1.3-6.3A2.2 2.2 0 0 0 18.9 9.8H14.2l.8-3.9a2 2 0 0 0-3.6-1.5L8.5 9.6z"/></svg>',
};
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

// ---------------------------------------------------------------- helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function svgIcon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;  // static markup from I only
  return t.content.firstChild;
}

// Make `parent`'s children exactly `nodes`, touching only what changed (moving a node would
// restart its animations and reload nothing, but there's no need to move unchanged ones at all).
function reconcile(parent, nodes) {
  let cur = parent.firstChild;
  for (const n of nodes) {
    if (n === cur) { cur = cur.nextSibling; continue; }
    parent.insertBefore(n, cur);
  }
  while (cur) { const next = cur.nextSibling; parent.removeChild(cur); cur = next; }
}

function cached(map, key, sig, make) {
  let e = map.get(key);
  if (!e || e.sig !== sig) { e = { sig, node: make() }; map.set(key, e); }
  return e.node;
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-iMassage': '1' } };
  if (opts.body !== undefined) {
    init.method = opts.method || 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("The iMassage server isn't running.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

let toastTimer;
function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.className = isErr ? 'err' : '';
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isErr ? 9000 : 3000);
}

function store(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage off */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

const isGreen = svc => svc === 'SMS' || svc === 'RCS';
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fullTime = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function listTime(t) {
  const today = startOfDay(Date.now());
  if (t >= today) return clock(t);
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return new Date(t).toLocaleDateString([], { weekday: 'long' });
  return new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

function sepParts(t) {
  const today = startOfDay(Date.now());
  let day;
  if (t >= today) day = 'Today';
  else if (t >= today - DAY) day = 'Yesterday';
  else if (t >= today - 6 * DAY) day = new Date(t).toLocaleDateString([], { weekday: 'long' });
  else {
    const sameYear = new Date(t).getFullYear() === new Date().getFullYear();
    day = new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  }
  return [day, clock(t)];
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtDur(s) {
  if (!isFinite(s)) return '';
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function handleKey(x) {
  if (!x) return '';
  if (x.includes('@')) return x.trim().toLowerCase();
  const d = x.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

function initials(name) {
  if (!name || name.includes('@') || /^[\d\s()+\-.]+$/.test(name)) return null;
  const parts = name.trim().split(/\s+/).filter(p => /\p{L}/u.test(p[0]));
  if (!parts.length) return null;
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function isJumbo(s) {
  if (!s || s.length > 24 || /^[\d#*\s]+$/.test(s)) return false;
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(s)) return false;
  const n = segmenter ? [...segmenter.segment(s.replace(/\s/g, ''))].length : 1;
  return n >= 1 && n <= 3;
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]}])/gi;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const href = /^www\./i.test(m[1]) ? 'https://' + m[1] : m[1];
    out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[1]));
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast("Couldn't copy", true));
}

// ---------------------------------------------------------------- avatars

// deterministic per-contact monogram color (white text reads on every pair)
const AV_COLORS = [
  ['#ff7a93', '#ff4d6d'], ['#ff9f45', '#ff7a1a'], ['#f0b32e', '#e8971a'],
  ['#4fd06a', '#23b048'], ['#3fcbe0', '#1ba6cc'], ['#5aa8ff', '#1f7bff'],
  ['#8f8fff', '#5f5fff'], ['#bd8bff', '#9148ff'], ['#ff8ad6', '#ff4db8'],
];
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AV_COLORS[Math.abs(h) % AV_COLORS.length];
}

function fillInitials(el, person) {
  const ini = initials(person && person.name);
  if (ini) {
    el.textContent = ini;
    const [a, b] = avatarColor(person && (person.id || person.handle || person.name));
    el.style.setProperty('--av-a', a);
    el.style.setProperty('--av-b', b);
  } else {
    el.replaceChildren(svgIcon(I.person));   // unknown / number-only stays neutral gray
  }
}

function personAvatar(person, size = 40) {
  const el = h('div', { class: 'avatar', style: `--sz:${size}px` });
  if (person && person.photo) {
    const img = h('img', { src: person.photo, alt: '', draggable: 'false' });
    img.addEventListener('error', () => { img.remove(); fillInitials(el, person); });
    el.append(img);
  } else {
    fillInitials(el, person);
  }
  return el;
}

function chatAvatar(c, size = 40, ring) {
  if (!c.group || c.members.length < 2) return personAvatar(c.members[0] || { name: c.name }, size);
  const three = c.members.length > 2 && size >= 56;
  const pz = Math.round(size * (three ? 0.56 : 0.64));
  const el = h('div', { class: 'cluster', style: `--sz:${size}px${ring ? `;--ring:${ring}` : ''}` });
  for (const m of c.members.slice(0, three ? 3 : 2)) el.append(personAvatar(m, pz));
  return el;
}

// ---------------------------------------------------------------- text for previews and system rows

function attachmentLabel(m) {
  const list = m.attachments || [];
  const a = list[0];
  if (!a) return '';
  const mime = a.mime || '';
  if (m.audio || mime.startsWith('audio/')) return 'Audio Message';
  if (a.sticker) return 'Sticker';
  const kind = mime.startsWith('image/') ? 'Image' : mime.startsWith('video/') ? 'Video' : null;
  if (list.length > 1) return `${list.length} ${kind ? kind + 's' : 'Attachments'}`;
  return kind || `Attachment: ${a.name}`;
}

function systemText(m) {
  const who = m.fromMe ? 'You' : (m.sender || 'Someone');
  const other = m.otherName || 'someone';
  if (m.unsent) return `${who} unsent a message.`;
  switch (m.itemType) {
    case 1: return m.groupAction === 1 ? `${who} removed ${other} from the conversation.` : `${who} added ${other} to the conversation.`;
    case 2: return m.groupTitle ? `${who} named the conversation “${m.groupTitle}”.` : `${who} removed the conversation name.`;
    case 3:
      if (m.groupAction === 1) return `${who} changed the group photo.`;
      if (m.groupAction >= 2) return `${who} removed the group photo.`;
      return `${who} left the conversation.`;
    case 4: return `${who} shared a location.`;
    default: return m.text || '';
  }
}

function visibleText(m) {
  let t = m.text || '';
  if (m.link && m.link.url) t = t.split(m.link.url).join('').trim();
  return t;
}

function previewText(m, c) {
  if (!m) return '';
  let t;
  if (m.unsent || m.itemType) t = systemText(m);
  else if (m.link && !visibleText(m)) t = m.link.title || m.link.url;
  else if (m.text) t = m.text;
  else if (m.attachments && m.attachments.length) t = attachmentLabel(m);
  else if (m.balloon) t = 'App message';
  else t = '';
  if (c && c.group && !m.fromMe && !m.itemType && !m.unsent && m.senderFirst && t) t = `${m.senderFirst}: ${t}`;
  return t;
}

const shortName = c => (!c.group && c.members[0] && c.members[0].first) || c.name;

// ---------------------------------------------------------------- sidebar

function sortedChats() {
  return [...S.chats.values()].sort((a, b) => b.lastDate - a.lastDate);
}

function matchChat(c, q) {
  return c.name.toLowerCase().includes(q) ||
    c.members.some(m => m.name.toLowerCase().includes(q) || m.handle.toLowerCase().includes(q));
}

function chatRow(c) {
  const sel = c.id === S.current;
  const unread = !sel && c.unread.length > 0;
  const draft = !sel && S.drafts.get(c.id);
  const preview = previewText(c.last, c);
  const time = c.lastDate ? listTime(c.lastDate) : '';
  const sig = JSON.stringify([c.name, preview, draft, time, sel, unread, c.members.map(m => m.photo)]);
  return cached(S.sideNodes, 'c' + c.id, sig, () => h('div', {
    class: 'chat' + (sel ? ' sel' : '') + (unread ? ' unread' : ''),
    role: 'option', 'aria-selected': String(sel), dataset: { id: c.id },
    onclick: () => openChat(c.id),
    oncontextmenu: e => { e.preventDefault(); chatMenu(c.id, e.clientX, e.clientY); },
  },
  h('div', { class: 'av' }, chatAvatar(c, 46)),
  h('div', { class: 'name' }, c.name),
  h('div', { class: 'time' }, time),
  h('div', { class: 'preview' }, draft ? [h('span', { class: 'draft' }, 'Draft: '), draft.replace(/\s+/g, ' ')] : preview)));
}

function pinTile(c) {
  const sel = c.id === S.current;
  const unread = !sel && c.unread.length > 0;
  const peek = unread && c.last && !c.last.fromMe ? previewText(c.last) : '';
  const sig = JSON.stringify([shortName(c), sel, unread, peek, c.members.map(m => m.photo)]);
  return cached(S.sideNodes, 'p' + c.id, sig, () => h('div', {
    class: 'pin' + (sel ? ' sel' : '') + (unread ? ' unread' : ''), title: c.name, dataset: { id: c.id },
    onclick: () => openChat(c.id),
    oncontextmenu: e => { e.preventDefault(); chatMenu(c.id, e.clientX, e.clientY); },
  },
  peek ? h('div', { class: 'peek' }, peek) : null,
  chatAvatar(c, 58, sel ? 'var(--accent)' : 'var(--side)'),
  h('div', { class: 'pin-name' }, shortName(c))));
}

function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [text];
  const start = Math.max(0, i - 40);
  return [(start > 0 ? '…' : '') + text.slice(start, i), h('mark', null, text.slice(i, i + q.length)), text.slice(i + q.length, i + q.length + 120)];
}

function hitRow(m) {
  const c = S.chats.get(m.chat);
  const who = m.fromMe ? 'You' : (m.senderFirst || m.sender || '');
  return h('div', { class: 'chat hit', onclick: () => openChat(m.chat, { focusGuid: m.guid }) },
    h('div', { class: 'av' }, c ? chatAvatar(c, 46) : personAvatar({ name: m.sender }, 46)),
    h('div', { class: 'name' }, c ? c.name : (m.sender || 'Conversation')),
    h('div', { class: 'time' }, listTime(m.date)),
    h('div', { class: 'preview' }, who ? `${who}: ` : '', snippet(m.text || '', S.hits.q)));
}

function renderSidebar() {
  const q = els.search.value.trim().toLowerCase();
  const all = sortedChats();
  const junk = all.filter(c => c.filtered === 2);
  const pinned = S.showJunk || q ? [] : S.pins.map(id => S.chats.get(id)).filter(c => c && c.filtered !== 2);
  const pinnedIds = new Set(pinned.map(c => c.id));
  const list = S.showJunk ? junk : all.filter(c => c.filtered !== 2 && !pinnedIds.has(c.id));
  const shown = q ? list.filter(c => matchChat(c, q)) : list;

  reconcile(els.pins, pinned.map(pinTile));
  els.pins.hidden = !pinned.length;

  const nodes = [];
  if (S.current === 'new' && !q) {
    nodes.push(h('div', { class: 'chat sel' },
      h('div', { class: 'av' }, personAvatar(S.newTo ? { name: S.newTo.name } : null, 46)),
      h('div', { class: 'name' }, S.newTo ? (S.newTo.name || S.newTo.label) : 'New Message'),
      h('div', { class: 'time' }, ''), h('div', { class: 'preview' }, '')));
  }
  if (q) nodes.push(h('div', { class: 'section-label' }, 'Conversations'));
  for (const c of shown) nodes.push(chatRow(c));
  if (!shown.length && !pinned.length) {
    let note;
    if (q) note = 'No matching conversations';
    else if (S.chats.size) note = S.showJunk ? 'No junk' : 'No conversations';
    else note = S.status.connected ? 'Loading conversations…' : 'Waiting for your Mac…';
    nodes.push(h('div', { class: 'list-note' }, note));
  }
  if (q && S.hits && S.hits.q.toLowerCase() === q) {
    nodes.push(h('div', { class: 'section-label' }, 'Messages'));
    const hits = S.hits.hits.filter(m => m.text);
    if (!hits.length) nodes.push(h('div', { class: 'list-note' }, 'No messages found'));
    for (const m of hits) nodes.push(hitRow(m));
  }
  reconcile(els.chatlist, nodes);
  els.junk.hidden = !junk.length && !S.showJunk;
  els.junk.textContent = S.showJunk ? '← All Conversations' : `Junk (${junk.length})`;
  updateBadge();
}

function updateBadge() {
  let n = 0;
  for (const c of S.chats.values()) if (c.filtered !== 2 && c.id !== S.current && c.unread.length) n += c.unread.length;
  document.title = n ? `(${n}) iMassage` : 'iMassage';
  if (n === S.badge) return;
  S.badge = n;
  if (shell) shell.badge(n, n ? badgeImage(n) : null);
}

function badgeImage(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#ff3b30';
  g.beginPath(); g.arc(16, 16, 15.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `bold ${n > 9 ? 15 : 19}px Segoe UI, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(n > 99 ? '99+' : String(n), 16, 17);
  return c.toDataURL('image/png');
}

let chatsBusy = null;
async function refreshChats() {
  if (chatsBusy) { chatsBusy.again = true; return; }
  chatsBusy = { again: false };
  try {
    const list = await api(`/api/chats?limit=${S.chatLimit}`);
    S.chats = new Map(list.map(c => [c.id, c]));
    S.pins = list.filter(c => c.pin != null).sort((a, b) => a.pin - b.pin).map(c => c.id);
    for (const c of list) if (c.last) S.maxRowid = Math.max(S.maxRowid, c.last.id);
    if (typeof S.current === 'number' && viewing(S.current) && S.chats.has(S.current)) S.chats.get(S.current).unread = [];
    renderSidebar();
    renderHeader();
    if (S.details) renderDetails();
    resolveNewChat();
    if (!S.booted) {
      S.booted = true;
      const last = Number(recall('lastChat'));
      if (S.current == null && last && S.chats.has(last) && window.innerWidth > 720) openChat(last);
    }
  } catch (e) {
    if (!S.chats.size) renderSidebar();
  }
  const again = chatsBusy.again;
  chatsBusy = null;
  if (again) refreshChats();
}

// ---------------------------------------------------------------- menus, pins

function showMenu(x, y, items) {
  els.menu.replaceChildren(...items.filter(Boolean).map(it => it === '-' ? h('hr')
    : h('button', { role: 'menuitem', onclick: () => { hideMenu(); it.run(); } }, it.label)));
  els.menu.hidden = false;
  const r = els.menu.getBoundingClientRect();
  els.menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  els.menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
}
function hideMenu() { els.menu.hidden = true; }

function chatMenu(id, x, y) {
  const c = S.chats.get(id);
  if (!c) return;
  const pinned = S.pins.includes(id);
  showMenu(x, y, [
    { label: pinned ? 'Unpin' : 'Pin', run: () => togglePin(id) },
    c.unread.length ? { label: 'Mark as Read', run: () => markSeen(id, true) } : null,
    '-',
    { label: 'Show Details', run: async () => { await openChat(id); openDetails(); } },
    { label: c.group ? 'Copy Addresses' : 'Copy Address', run: () => copyText(c.members.map(m => m.handle).join(', ')) },
  ]);
}

function togglePin(id) {
  const i = S.pins.indexOf(id);
  if (i >= 0) S.pins.splice(i, 1);
  else if (S.pins.length >= 12) { toast('You can pin up to 12 conversations.'); return; }
  else S.pins.push(id);
  for (const c of S.chats.values()) c.pin = S.pins.includes(c.id) ? S.pins.indexOf(c.id) : null;
  renderSidebar();
  if (S.details) renderDetails();
  api('/api/pins', { body: { pins: S.pins } }).catch(e => toast(e.message, true));
}

// ---------------------------------------------------------------- conversation

function newThread() {
  return { msgs: [], byId: new Map(), byGuid: new Map(), rx: new Map(), nodes: new Map(), more: true,
    loading: false, loaded: false, queue: [], older: h('div', { class: 'older' }) };
}

function viewing(id) {
  return S.current === id && document.visibilityState === 'visible' && document.hasFocus();
}

function saveDraft() {
  if (S.current == null || S.editing) return;
  const v = els.input.value;
  if (v.trim()) S.drafts.set(S.current, v); else S.drafts.delete(S.current);
  persistDrafts();
}

function persistDrafts() {
  store('drafts', JSON.stringify([...S.drafts].filter(([id]) => typeof id === 'number')));
}

try { S.drafts = new Map(JSON.parse(recall('drafts') || '[]')); } catch { /* start clean */ }

function restoreDraft() {
  els.input.value = S.drafts.get(S.current) || '';
  autosize();
  updateSendState();
}

async function openChat(id, opts = {}) {
  if (S.current !== id) {
    if (S.editing) cancelEdit();
    saveDraft();
    S.current = id;
    restoreDraft();
    S.replyTo = null;
    renderReplyBanner();
    closeFind();
    if (S.details) closeDetails();
  }
  S.newTo = null;
  hideMenu();
  closeTapbackPicker();
  els.app.classList.add('in-chat');
  els.empty.hidden = true;
  els.suggest.hidden = true;
  store('lastChat', String(id));
  renderHeader();
  renderSidebar();
  let t = S.threads.get(id);
  if (!t) S.threads.set(id, t = newThread());
  S.stick = true;
  renderThread('bottom');
  if (!t.loaded) await loadPage(id, true);
  if (opts.focusGuid) await revealMessage(id, opts.focusGuid);
  markSeen(id);
  if (S.current === id && !opts.focusGuid) els.input.focus();
}

async function loadPage(id, initial) {
  const t = S.threads.get(id);
  if (!t || t.loading || (!initial && !t.more)) return;
  t.loading = true;
  if (S.current === id && !initial) renderThread('keep');
  const before = initial ? null : (t.msgs[0] && t.msgs[0].id);
  try {
    const r = await api(`/api/chats/${id}/messages?limit=60` + (before ? `&before=${before}` : ''));
    if (initial) { t.msgs = []; t.byId.clear(); t.byGuid.clear(); t.rx.clear(); t.nodes.clear(); }
    const fresh = r.messages.filter(m => !t.byId.has(m.id));
    for (const m of fresh) { t.byId.set(m.id, m); t.byGuid.set(m.guid, m); }
    t.msgs = initial ? fresh : fresh.concat(t.msgs);
    for (const x of r.reactions) applyReaction(t, x, false);
    t.more = r.more;
    t.loaded = true;
  } catch (e) {
    toast(e.message, true);
  } finally {
    t.loading = false;
  }
  for (const m of t.queue.splice(0)) upsert(t, m, true);
  if (S.current === id) renderThread(initial ? 'bottom' : 'keep');
  fetchReplyOriginals(t);
}

function upsert(t, m, isNew) {
  if (m.reaction) {
    if (isNew) applyReaction(t, m, !!m._fresh);
    return;
  }
  const old = t.byId.get(m.id);
  if (old) {
    if (old._fresh) m._fresh = true;
    t.msgs[t.msgs.indexOf(old)] = m;
  } else if (isNew || (t.msgs.length && m.date >= t.msgs[0].date)) {
    t.msgs.push(m);
    t.msgs.sort((a, b) => a.date - b.date || a.id - b.id);
  } else {
    return;
  }
  t.byId.set(m.id, m);
  t.byGuid.set(m.guid, m);
}

function applyReaction(t, m, fresh) {
  const r = m.reaction;
  if (!r || !r.target) return;
  const who = m.fromMe ? 'me' : (m.handle || '?');
  let map = t.rx.get(r.target);
  if (!map) t.rx.set(r.target, map = new Map());
  if (r.remove) map.delete(who);
  else map.set(who, { kind: r.kind, emoji: r.emoji, mine: m.fromMe, fresh, name: m.fromMe ? 'You' : (m.senderFirst || m.sender || 'Someone') });
}

async function fetchReplyOriginals(t) {
  const want = [...new Set(t.msgs.filter(m => m.replyTo).map(m => m.replyTo))]
    .filter(g => !S.lookups.has(g) && !t.byGuid.has(g));
  if (!want.length) return;
  try {
    const found = await api('/api/lookup?guids=' + encodeURIComponent(want.slice(0, 50).join(',')));
    for (const m of found) S.lookups.set(m.guid, m);
    for (const g of want) if (!S.lookups.has(g)) S.lookups.set(g, null);
    if (S.threads.get(S.current) === t) renderThread('auto');
  } catch { /* previews just say "Reply" */ }
}

async function revealMessage(id, guid) {
  const t = S.threads.get(id);
  for (let i = 0; i < 40 && t && !t.byGuid.has(guid) && t.more && S.current === id; i++) {
    await loadPage(id, false);
  }
  const row = els.thread.querySelector(`[data-guid="${CSS.escape(guid)}"]`);
  if (!row) { toast('That message is no longer in this conversation.'); return; }
  S.stick = false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

function markSeen(id, force) {
  const c = S.chats.get(id);
  if (!c || (!force && !viewing(id))) return;
  const t = S.threads.get(id);
  const top = Math.max(0, ...c.unread, t && t.msgs.length ? t.msgs[t.msgs.length - 1].id : 0);
  if (c.unread.length) { c.unread = []; renderSidebar(); }
  if (top > (S.seenSent.get(id) || 0)) {
    S.seenSent.set(id, top);
    api(`/api/chats/${id}/seen`, { body: { rowid: top } }).catch(() => {});
  }
}

// ---------------------------------------------------------------- thread rendering

function sameSender(a, b) {
  return !a.itemType && !b.itemType && !a.unsent && !b.unsent && a.fromMe === b.fromMe && (a.fromMe || a.handle === b.handle);
}

function replyRef(guid, t, mine) {
  const orig = t.byGuid.get(guid) || S.lookups.get(guid);
  let label = 'Reply';
  if (orig) {
    const who = orig.fromMe ? 'You' : (orig.senderFirst || orig.sender || '');
    label = (who ? who + ': ' : '') + (previewText(orig) || 'Attachment');
  }
  return h('div', { class: 'reply-ref' + (mine ? ' mine' : ''), title: 'Show the original', onclick: () => revealMessage(S.current, guid) },
    h('div', { class: 'rbubble' }, label), h('div', { class: 'reply-line' }));
}

function fileChip(a) {
  return h('a', { class: 'file', href: `/api/attachment/${a.id}?download=1`, download: a.name, title: 'Save' },
    svgIcon(I.file), h('span', { class: 'fname' }, a.name), h('span', { class: 'size' }, fmtSize(a.size)));
}

function threadImages() {
  const t = S.threads.get(S.current);
  const out = [];
  if (t) for (const m of t.msgs) for (const a of m.attachments || []) {
    if (a.ready && !a.sticker && (a.mime || '').startsWith('image/')) out.push({ id: a.id, name: a.name, mime: a.mime });
  }
  return out;
}

function audioBubble(a) {
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = `/api/attachment/${a.id}`;
  const btn = h('button', { class: 'au-btn', 'aria-label': 'Play' }, svgIcon(I.play));
  const fill = h('div', { class: 'au-fill' });
  const time = h('span', { class: 'au-time' }, '');
  btn.addEventListener('click', e => { e.stopPropagation(); if (audio.paused) audio.play().catch(err => toast(err.message, true)); else audio.pause(); });
  audio.addEventListener('play', () => btn.replaceChildren(svgIcon(I.pause)));
  audio.addEventListener('pause', () => btn.replaceChildren(svgIcon(I.play)));
  audio.addEventListener('ended', () => { fill.style.width = '0'; });
  audio.addEventListener('loadedmetadata', () => { time.textContent = fmtDur(audio.duration); });
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) {
      fill.style.width = `${(100 * audio.currentTime) / audio.duration}%`;
      time.textContent = fmtDur(audio.duration - audio.currentTime);
    }
  });
  return h('div', { class: 'bubble audio' }, btn, h('div', { class: 'au-bar' }, fill), time);
}

function attachmentEl(a, m) {
  const url = `/api/attachment/${a.id}`;
  const mime = a.mime || '';
  if (!a.ready) return h('div', { class: 'file waiting' }, `${a.name} (still downloading on the Mac)`);
  if (mime.startsWith('image/') || /^public\.(heic|heif|jpeg|png|tiff)$/.test(a.uti)) {
    const img = h('img', { class: 'att-img' + (a.sticker ? ' sticker' : ''), src: url, alt: a.name, decoding: 'async' });
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.replaceWith(fileChip(a)));
    if (!a.sticker) {
      img.addEventListener('click', () => {
        const items = threadImages();
        openLightbox(items, Math.max(0, items.findIndex(x => x.id === a.id)));
      });
    }
    return img;
  }
  if (mime.startsWith('video/')) {
    const v = h('video', { class: 'att-video', controls: true, preload: 'metadata', src: url });
    v.addEventListener('error', () => v.replaceWith(fileChip(a)));
    return v;
  }
  if (m.audio || mime.startsWith('audio/') || a.uti === 'com.apple.coreaudio-format') return audioBubble(a);
  return fileChip(a);
}

function linkCard(L) {
  const host = hostOf(L.url);
  const card = h('a', { class: 'link-card' + (L.image ? '' : ' compact'), href: L.url, target: '_blank', rel: 'noopener noreferrer', title: L.url });
  if (L.image) {
    const img = h('img', { class: 'lc-img', src: `/api/attachment/${L.image}`, alt: '', decoding: 'async' });
    if (L.size) img.style.aspectRatio = `${Math.max(L.size[0] / L.size[1], 0.75)}`;
    img.addEventListener('error', () => img.remove());
    card.append(img);
  } else if (L.icon) {
    const ic = h('img', { class: 'lc-icon', src: `/api/attachment/${L.icon}`, alt: '' });
    ic.addEventListener('error', () => ic.remove());
    card.append(ic);
  }
  card.append(h('div', { class: 'lc-meta' }, h('div', { class: 'lc-title' }, L.title || host), h('div', { class: 'lc-site' }, host)));
  return card;
}

function tapbackGlyph(kind, emoji) {
  if (kind === 'love') return svgIcon(I.heart);
  if (kind === 'like') return svgIcon(I.thumb);
  if (kind === 'dislike') { const s = svgIcon(I.thumb); s.style.transform = 'rotate(180deg)'; return s; }
  if (kind === 'laugh') return h('span', { class: 'haha' }, 'HA', h('br'), 'HA');
  if (kind === 'emphasize') return h('span', { class: 'glyph' }, '!!');
  if (kind === 'question') return h('span', { class: 'glyph' }, '?');
  return h('span', null, emoji || '🏷️');
}

function tapbackEl(kind, emoji, mine, fresh, count) {
  const el = h('div', { class: `tb k-${kind}` + (mine ? ' mine' : '') + (fresh ? ' fresh' : '') }, tapbackGlyph(kind, emoji));
  if (count > 1) el.append(h('span', { class: 'tb-n' }, String(count)));
  return el;
}

// Tapbacks that can be sent, in the picker's order (matches the macOS popover left-to-right).
const TAPBACK_PICKER = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];
let tapbar = null;

function closeTapbackPicker() {
  if (tapbar) { tapbar.remove(); tapbar = null; document.removeEventListener('mousedown', tapbarOutside, true); }
}
function tapbarOutside(e) { if (tapbar && !tapbar.contains(e.target)) closeTapbackPicker(); }

function myTapback(m) {
  const t = S.threads.get(S.current);
  const mine = t && t.rx.get(m.guid) && [...t.rx.get(m.guid).values()].find(r => r.mine);
  return mine ? mine.kind : null;
}

function openTapbackPicker(m, row) {
  if (m.itemType || m.unsent) return;
  closeTapbackPicker();
  hideMenu();
  const current = myTapback(m);
  tapbar = h('div', { class: 'tapbar' + (m.fromMe ? ' me' : '') },
    ...TAPBACK_PICKER.map(kind => h('button', {
      class: 'tp' + (current === kind ? ' on' : ''), title: kind,
      onclick: () => { closeTapbackPicker(); react(m, kind); },
    }, tapbackGlyph(kind))));
  document.body.append(tapbar);
  const anchor = (row.querySelector('.bubble, .att-img, .att-video, .file, .link-card') || row.querySelector('.col') || row).getBoundingClientRect();
  const bw = tapbar.offsetWidth, bh = tapbar.offsetHeight;
  let left = m.fromMe ? anchor.right - bw : anchor.left;
  left = Math.max(10, Math.min(left, window.innerWidth - bw - 10));
  let top = anchor.top - bh - 6;
  if (top < 72) top = anchor.bottom + 6;
  tapbar.style.left = `${left}px`;
  tapbar.style.top = `${top}px`;
  requestAnimationFrame(() => tapbar && tapbar.classList.add('in'));
  setTimeout(() => document.addEventListener('mousedown', tapbarOutside, true), 0);
}

async function react(m, kind) {
  const c = S.chats.get(S.current);
  const t = S.threads.get(S.current);
  if (!c || !t) return;
  const remove = myTapback(m) === kind;
  let map = t.rx.get(m.guid);
  if (!map) t.rx.set(m.guid, map = new Map());
  const prev = map.get('me');
  if (remove) map.delete('me');
  else map.set('me', { kind, mine: true, fresh: true, name: 'You' });
  renderThread('auto');
  try {
    await api('/api/react', { body: { chat: c.guid, target: m.guid, kind, remove, text: visibleText(m) } });
  } catch (e) {
    if (prev) map.set('me', prev); else map.delete('me');  // revert the optimistic badge
    renderThread('auto');
    toast(e.message, true);
  }
}

function saveAttachment(a) {
  const link = h('a', { href: `/api/attachment/${a.id}?download=1`, download: a.name, style: 'display:none' });
  document.body.append(link);
  link.click();
  link.remove();
}

function messageMenu(m, row, x, y) {
  const items = [];
  const react = !m.itemType && !m.unsent;
  if (react) items.push({ label: myTapback(m) ? 'Change Tapback…' : 'Tapback…', run: () => openTapbackPicker(m, row) });
  if (react) items.push({ label: 'Reply', run: () => startReply(m) });
  // Apple's windows: edit for 15 minutes, undo for 2; iMessage only.
  const mine = react && m.fromMe && !isGreen(m.service) && !m.error;
  const age = Date.now() - m.date;
  if (mine && visibleText(m) && age < 15 * 60000) items.push({ label: 'Edit', run: () => startEdit(m) });
  if (mine && age < 2 * 60000) items.push({ label: 'Undo Send', run: () => undoSend(m) });
  if (react || m.itemType || m.unsent) items.push('-');
  const text = visibleText(m) || ((m.unsent || m.itemType) ? systemText(m) : '');
  if (text) items.push({ label: 'Copy', run: () => copyText(text) });
  if (m.link) items.push({ label: 'Copy Link', run: () => copyText(m.link.url) });
  const atts = (m.attachments || []).filter(a => a.ready);
  if (atts.length) items.push({ label: atts.length > 1 ? `Save ${atts.length} Attachments` : 'Save Attachment', run: () => atts.forEach(saveAttachment) });
  items.push('-', { label: 'Show in Details', run: () => openDetails() });
  showMenu(x, y, items.filter((it, i, a) => !(it === '-' && (i === 0 || a[i - 1] === '-'))));
}

function startEdit(m) {
  if (S.editing) cancelEdit();
  saveDraft();
  S.replyTo = null;
  S.editing = { m, chat: S.current, before: els.input.value };
  els.input.value = visibleText(m);
  autosize();
  updateSendState();
  renderReplyBanner();
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}

function cancelEdit() {
  const e = S.editing;
  if (!e) return;
  S.editing = null;
  if (S.current === e.chat) { els.input.value = e.before; autosize(); updateSendState(); }
  renderReplyBanner();
}

async function finishEdit(text) {
  const { m, chat } = S.editing;
  const c = S.chats.get(chat);
  const old = m.text;
  cancelEdit();
  if (!c || !text.trim() || text === visibleText(m)) return;
  m.text = text;  // optimistic; the watcher brings the real edit back
  m.edited = true;
  renderThread('auto');
  try {
    await api('/api/edit', { body: { chat: c.guid, target: m.guid, text, old } });
  } catch (e) {
    m.text = old;
    m.edited = false;
    renderThread('auto');
    toast(e.message, true);
  }
}

async function undoSend(m) {
  const c = S.chats.get(S.current);
  if (!c) return;
  m.unsent = true;
  renderThread('auto');
  try {
    await api('/api/unsend', { body: { chat: c.guid, target: m.guid, text: visibleText(m) } });
  } catch (e) {
    m.unsent = false;
    renderThread('auto');
    toast(e.message, true);
  }
}

function startReply(m) {
  if (S.editing) cancelEdit();
  S.replyTo = {
    guid: m.guid, fromMe: m.fromMe,
    who: m.fromMe ? 'You' : (m.senderFirst || m.sender || 'message'),
    text: (visibleText(m) || previewText(m) || 'Attachment').replace(/\s+/g, ' ').slice(0, 160),
  };
  renderReplyBanner();
  els.input.focus();
}

function cancelReply() { S.replyTo = null; renderReplyBanner(); }

function renderReplyBanner() {
  const r = S.replyTo;
  const ed = S.editing;
  els.replyBanner.hidden = !r && !ed;
  els.field.classList.toggle('editing', !!ed);
  if (!r && !ed) { els.replyBanner.replaceChildren(); return; }
  const title = ed ? 'Editing Message' : `Replying to ${r.who}`;
  const prev = ed ? visibleText(ed.m).replace(/\s+/g, ' ') : r.text;
  els.replyBanner.replaceChildren(
    h('div', { class: 'rb-line' }),
    h('div', { class: 'rb-body' }, h('div', { class: 'rb-who' }, title), h('div', { class: 'rb-prev' }, prev)),
    h('button', { class: 'rb-x', title: 'Cancel (Esc)', 'aria-label': ed ? 'Cancel edit' : 'Cancel reply', onclick: ed ? cancelEdit : cancelReply }, '×'));
}

function tapbacks(list) {
  const groups = new Map();
  for (const r of list) {
    const key = r.kind === 'emoji' ? 'e' + r.emoji : r.kind;
    const g = groups.get(key) || { kind: r.kind, emoji: r.emoji, mine: false, fresh: false, names: [] };
    g.mine = g.mine || r.mine;
    g.fresh = g.fresh || r.fresh;
    g.names.push(r.name);
    groups.set(key, g);
    r.fresh = false;
  }
  const wrap = h('div', { class: 'tapbacks', title: list.map(r => `${r.name}: ${r.kind === 'emoji' ? r.emoji : r.kind}`).join('\n') });
  for (const g of [...groups.values()].slice(0, 3)) wrap.append(tapbackEl(g.kind, g.emoji, g.mine, g.fresh, g.names.length));
  return wrap;
}

function replayEffect(m, row) {
  const fx = m.effect;
  if (FX.isScreen(fx)) {
    const r = row && row.querySelector('.col') && row.querySelector('.col').getBoundingClientRect();
    FX.play(fx, { text: m.text, rect: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(r.width, r.height) * 0.8 } : null });
  }
}

function buildRow(m, t, o) {
  const rxMap = t.rx.get(m.guid);
  const rx = rxMap ? [...rxMap.values()] : [];
  const fx = m.effect;
  const cls = ['row', m.fromMe ? 'me' : 'them'];
  if (isGreen(m.service)) cls.push('sms');
  if (o.gap) cls.push('gap');
  if (rx.length) cls.push('has-tb');
  const row = h('div', { class: cls.join(' '), dataset: { guid: m.guid } });
  const native = e => e.target.closest('a, img, video, audio, button');
  row.addEventListener('dblclick', e => {
    if (native(e) || (window.getSelection() + '').length) return;
    e.preventDefault();
    openTapbackPicker(m, row);
  });
  row.addEventListener('contextmenu', e => {
    if (native(e) || (window.getSelection() + '').length) return;  // let the shell handle links, media, selected text
    e.preventDefault();
    messageMenu(m, row, e.clientX, e.clientY);
  });
  if (o.group && !m.fromMe) {
    row.append(o.avatar ? personAvatar({ name: m.sender, photo: m.senderPhoto }, 30) : h('div', { class: 'avatar-spacer' }));
  }
  const col = h('div', { class: 'col', title: fullTime(m.date) });
  if (m.replyTo) col.append(replyRef(m.replyTo, t, m.fromMe));
  for (const a of m.attachments || []) col.append(attachmentEl(a, m));
  const text = visibleText(m);
  let last = null;
  if (text || m.subject) {
    const jumbo = !m.subject && isJumbo(text);
    last = h('div', { class: 'bubble' + (jumbo ? ' jumbo' : '') + (fx === 'invisibleink' ? ' ink' : '') });
    if (m.subject) last.append(h('span', { class: 'subject' }, m.subject));
    if (fx === 'invisibleink') last.append(h('span', { class: 'ink-text' }, ...linkify(text)), h('span', { class: 'dust' }));
    else last.append(...linkify(text));
    col.append(last);
  } else if (!(m.attachments || []).length && !m.link) {
    last = h('div', { class: 'bubble' }, h('i', null, m.balloon ? 'App message: open it on your phone' : 'Unsupported message'));
    col.append(last);
  }
  if (m.link) { col.append(linkCard(m.link)); last = null; }
  if (o.tail && last) last.classList.add('tail');
  if (rx.length) col.append(tapbacks(rx));
  if (m.edited) col.append(h('div', { class: 'edited' }, 'Edited'));
  if (fx && FX.label(fx)) {
    col.append(h('div', { class: 'fx-label' }, `Sent with ${FX.label(fx)}`,
      FX.isScreen(fx) ? h('button', { onclick: e => { e.stopPropagation(); replayEffect(m, row); } }, '↻ Replay') : null));
  }
  if (m.fromMe && m.error) col.append(h('div', { class: 'meta err' }, 'Not Delivered'));
  row.append(col);
  return row;
}

function rowSig(m, t, o) {
  const rx = t.rx.get(m.guid);
  return JSON.stringify([m.text, m.service, m.edited, m.unsent, m.error, m.effect, m.subject,
    (m.attachments || []).map(a => a.id + (a.ready ? 'r' : '')), m.link ? [m.link.url, m.link.image, m.link.title] : 0,
    rx ? [...rx.entries()].map(([k, v]) => k + v.kind + (v.emoji || '') + (v.fresh ? 'f' : '')) : 0,
    o.tail, o.gap, o.group, o.avatar, m.sender, m.senderPhoto,
    m.replyTo ? !!(t.byGuid.get(m.replyTo) || S.lookups.get(m.replyTo)) : 0]);
}

function receipt(m, c) {
  if (m.error) return null;
  let text;
  if (m.service === 'SMS') text = 'Sent as Text Message';
  else if (m.service === 'RCS') text = 'Sent as RCS';
  else if (m.dateRead && !(c && c.group)) text = 'Read ' + (m.dateRead >= startOfDay(Date.now()) ? clock(m.dateRead) : listTime(m.dateRead));
  else if (m.delivered) text = 'Delivered';
  else text = m.sent ? 'Sent' : 'Sending…';
  return h('div', { class: 'receipt' }, text);
}

function pendingRow(p, c) {
  const sig = JSON.stringify([p.failed, p.error]);
  if (p.node && p.sig === sig) return p.node;
  const green = p.service ? isGreen(p.service) : !!(c && isGreen(c.service));
  const col = h('div', { class: 'col' });
  for (const f of p.files) {
    col.append(f.url ? h('img', { class: 'att-img loaded', src: f.url, alt: f.name, style: 'opacity:.6' })
      : h('div', { class: 'file waiting' }, f.name));
  }
  if (p.text) col.append(h('div', { class: 'bubble tail pending' }, ...linkify(p.text)));
  if (p.failed) {
    col.append(h('div', { class: 'meta err' }, `Not Delivered: ${p.error}`),
      h('div', null,
        h('button', { class: 'link-btn', onclick: () => resend(p) }, 'Try Again'),
        h('button', { class: 'link-btn', onclick: () => dropPending(p) }, 'Discard')));
  }
  const row = h('div', { class: `row me gap${green ? ' sms' : ''}${p.sig ? '' : ' anim-send'}` }, col);
  row.addEventListener('animationend', () => row.classList.remove('anim-send'), { once: true });
  p.node = row;
  p.sig = sig;
  return row;
}

function renderThread(mode = 'auto') {
  const id = S.current;
  const box = els.messages;
  const t = S.threads.get(id);
  if (!t) { els.thread.replaceChildren(); return; }
  const c = S.chats.get(id);
  const group = !!(c && c.group);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const fromBottom = box.scrollHeight - box.scrollTop;
  closeTapbackPicker();
  t.older.textContent = t.loading ? 'Loading…' : '';
  const nodes = [t.older];
  const msgs = t.msgs;
  const pend = S.pending.filter(p => p.chat === id);
  let prev = null;
  let screenFx = null;
  let slam = false;
  let lastKind = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const next = msgs[i + 1] || null;
    const newBlock = !prev || m.date - prev.date > 3600000;
    if (newBlock) {
      const [day, time] = sepParts(m.date);
      nodes.push(cached(t.nodes, 'sep' + m.guid, day + time, () => h('div', { class: 'sep' }, h('b', null, day), ' ' + time)));
    }
    if (m.itemType || m.unsent) {
      const text = systemText(m);
      nodes.push(cached(t.nodes, 'sys' + m.guid, text, () => h('div', { class: 'sys', title: fullTime(m.date) }, text)));
      prev = m;
      continue;
    }
    // Mark where a conversation switches between iMessage and text messages, like Messages does.
    const kind = isGreen(m.service) ? (m.service === 'RCS' ? 'RCS Message' : 'Text Message') : 'iMessage';
    if (lastKind && kind !== lastKind) {
      nodes.push(cached(t.nodes, 'svc' + m.guid, kind, () => h('div', { class: 'sys svc' }, kind)));
    }
    lastKind = kind;
    const contPrev = !newBlock && prev && sameSender(prev, m);
    const contNext = next && sameSender(m, next) && next.date - m.date <= 3600000;
    if (group && !m.fromMe && !contPrev) {
      const who = m.sender || 'Unknown';
      nodes.push(cached(t.nodes, 'who' + m.guid, who, () => h('div', { class: 'sender' }, who)));
    }
    const o = { tail: !contNext, gap: !contPrev && !newBlock, group, avatar: !contNext };
    const node = cached(t.nodes, m.guid, rowSig(m, t, o), () => buildRow(m, t, o));
    if (m._fresh) {
      delete m._fresh;
      const fx = m.effect;
      const cls = FX.isBubble(fx) && fx !== 'invisibleink' ? 'fx-' + fx : (m.fromMe ? 'anim-send' : 'anim-recv');
      node.classList.add(cls);
      node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
      if (fx === 'impact') slam = true;
      if (FX.isScreen(fx)) screenFx = { m, node };
    }
    nodes.push(node);
    if (i === msgs.length - 1 && m.fromMe && !pend.length) {
      const r = receipt(m, c);
      if (r) nodes.push(r);
    }
    prev = m;
  }
  for (const p of pend) nodes.push(pendingRow(p, c));
  const sched = c ? S.scheduled.filter(s => s.chat === c.guid) : [];
  for (const s of sched) nodes.push(cached(t.nodes, 'sched' + s.id, JSON.stringify([s.text, s.at, s.error, c.service]), () => scheduledRow(s, c)));
  if (t.loaded && !msgs.length && !pend.length && !sched.length) nodes.push(h('div', { class: 'sys' }, 'No messages yet.'));
  reconcile(els.thread, nodes);
  if (mode === 'bottom' || (mode === 'auto' && (atBottom || S.stick))) {
    box.scrollTop = box.scrollHeight;
    S.stick = true;
  } else if (mode === 'keep') {
    box.scrollTop = box.scrollHeight - fromBottom;
  }
  if (slam) {
    els.thread.classList.remove('shake');
    void els.thread.offsetWidth;
    els.thread.classList.add('shake');
  }
  if (screenFx) setTimeout(() => replayEffect(screenFx.m, screenFx.node), 300);
}

function renderHeader() {
  const isNew = S.current === 'new';
  const c = S.chats.get(S.current);
  els.main.classList.toggle('composing', isNew);
  els.toRow.hidden = !isNew;
  els.newTitle.hidden = !isNew;
  els.who.hidden = isNew || !c;
  els.findBtn.hidden = isNew || !c;
  if (isNew) { renderToRow(); return; }
  if (!c) return;
  const sub = c.service === 'SMS' ? 'Text Message' : c.service === 'RCS' ? 'RCS Message' : '';
  els.who.replaceChildren(chatAvatar(c, 38, 'var(--bg)'),
    h('div', { class: 'who-name' }, h('span', null, c.name), sub ? h('em', { class: 'who-svc' }, sub) : null, svgIcon(I.chevron)));
  els.input.placeholder = c.service === 'SMS' ? 'Text Message • SMS' : c.service === 'RCS' ? 'Text Message • RCS' : 'iMessage';
  els.send.classList.toggle('sms', isGreen(c.service));
  updateSendState();
}

// ---------------------------------------------------------------- details panel

function copyBtn(value) {
  return h('button', { class: 'tool', title: 'Copy', onclick: () => copyText(value) }, svgIcon(I.copy));
}

async function openDetails() {
  if (typeof S.current !== 'number' || !S.chats.has(S.current)) return;
  S.details = true;
  renderDetails();
  els.details.classList.add('open');
  els.main.classList.add('with-details');
  const id = S.current;
  if (!S.media.has(id)) {
    try { S.media.set(id, await api(`/api/chats/${id}/media?limit=90`)); } catch { S.media.set(id, []); }
    if (S.details && S.current === id) renderDetails();
  }
}

function closeDetails() {
  S.details = false;
  els.details.classList.remove('open');
  els.main.classList.remove('with-details');
}

function renderDetails() {
  const c = S.chats.get(S.current);
  if (!c) { closeDetails(); return; }
  const kids = [
    h('button', { class: 'tool d-close', title: 'Close (Esc)', onclick: closeDetails }, svgIcon(I.close)),
    h('div', { class: 'd-hero' }, chatAvatar(c, 84, 'var(--panel)'), h('div', { class: 'd-name' }, c.name),
      h('div', { class: 'd-sub' }, c.group ? `${c.members.length} people · ${c.service}` : c.service)),
  ];
  if (c.group) {
    kids.push(h('div', { class: 'd-card' }, ...c.members.map(m => h('div', { class: 'd-item' }, personAvatar(m, 30),
      h('div', { class: 'grow' }, h('div', { class: 'd-val' }, m.name), m.known ? h('div', { class: 'd-lbl' }, m.label) : null), copyBtn(m.handle)))));
  } else if (c.members[0]) {
    const m = c.members[0];
    kids.push(h('div', { class: 'd-card' }, h('div', { class: 'd-item' },
      h('div', { class: 'grow' }, h('div', { class: 'd-lbl' }, m.handle.includes('@') ? 'email' : 'phone'), h('div', { class: 'd-val' }, m.label)),
      copyBtn(m.handle))));
  }
  const pinned = S.pins.includes(c.id);
  kids.push(h('div', { class: 'd-card' }, h('div', { class: 'd-item' },
    h('button', { class: 'link-btn', onclick: () => togglePin(c.id) }, pinned ? 'Unpin Conversation' : 'Pin Conversation'))));
  const media = S.media.get(c.id);
  kids.push(h('div', { class: 'd-h' }, 'Photos'));
  if (!media) kids.push(h('div', { class: 'list-note' }, 'Loading…'));
  else if (!media.length) kids.push(h('div', { class: 'list-note' }, 'No photos yet'));
  else {
    const items = media.filter(x => x.ready);
    kids.push(h('div', { class: 'd-photos' }, ...items.map((x, i) => {
      const vid = x.mime.startsWith('video/');
      return h('button', { class: vid ? 'vid' : null, title: x.name, onclick: () => openLightbox(items, i) },
        vid ? null : h('img', { src: `/api/attachment/${x.id}?thumb=1`, alt: '', loading: 'lazy', decoding: 'async' }));
    })));
  }
  els.details.replaceChildren(...kids);
}

// ---------------------------------------------------------------- new message

async function startCompose() {
  saveDraft();
  if (S.details) closeDetails();
  S.current = 'new';
  S.newTo = null;
  S.newSvc = 'iMessage';
  restoreDraft();
  els.app.classList.add('in-chat');
  els.empty.hidden = true;
  els.thread.replaceChildren();
  renderHeader();
  renderSidebar();
  els.toInput.value = '';
  els.toInput.focus();
  if (!S.contacts) {
    try { S.contacts = await api('/api/contacts'); } catch (e) { toast(e.message, true); }
  }
  renderSuggest();
}

function renderToRow() {
  const t = S.newTo;
  els.toChips.replaceChildren(...(t ? [h('span', { class: 'chip', title: t.value }, t.name || t.label,
    h('button', { title: 'Remove', 'aria-label': 'Remove recipient', onclick: () => { S.newTo = null; renderHeader(); renderSidebar(); els.toInput.focus(); } }, '×'))] : []));
  els.toInput.hidden = !!t;
  els.svcPick.hidden = !t || t.value.includes('@');
  for (const b of els.svcPick.querySelectorAll('button')) b.classList.toggle('on', b.dataset.svc === S.newSvc);
  els.input.placeholder = S.newSvc === 'SMS' ? 'Text Message • SMS' : 'iMessage';
  els.send.classList.toggle('sms', S.newSvc === 'SMS');
  updateSendState();
}

const looksLikeHandle = q => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) || (/^[\d\s()+\-.]+$/.test(q) && q.replace(/\D/g, '').length >= 7);
const sug = { items: [], active: 0 };

function renderSuggest() {
  const q = els.toInput.value.trim();
  if (S.current !== 'new' || S.newTo || !q) { els.suggest.hidden = true; return; }
  const ql = q.toLowerCase();
  const qd = q.replace(/\D/g, '');
  const items = [];
  const seen = new Set();
  for (const p of S.contacts || []) {
    const byName = p.name.toLowerCase().includes(ql);
    for (const hd of p.handles) {
      const byHandle = hd.value.includes(ql) || (qd.length >= 3 && hd.value.replace(/\D/g, '').includes(qd));
      const key = handleKey(hd.value);
      if ((byName || byHandle) && !seen.has(key)) {
        seen.add(key);
        items.push({ name: p.name, label: hd.label, value: hd.value, photo: p.photo, starts: p.name.toLowerCase().startsWith(ql) });
      }
    }
  }
  items.sort((a, b) => (b.starts - a.starts) || a.name.localeCompare(b.name));
  sug.items = items.slice(0, 12);
  if (looksLikeHandle(q) && !sug.items.some(it => handleKey(it.value) === handleKey(q))) sug.items.push({ name: null, label: q, value: q });
  sug.active = 0;
  drawSuggest();
}

function drawSuggest() {
  els.suggest.replaceChildren(...sug.items.map((it, i) => h('div', {
    class: 'sug' + (i === sug.active ? ' active' : ''), role: 'option',
    onmousedown: e => { e.preventDefault(); pickRecipient(it); },
  }, personAvatar({ name: it.name, photo: it.photo }, 30),
  h('div', null, h('div', { class: 's-name' }, it.name || `Send to ${it.label}`), it.name ? h('div', { class: 's-handle' }, it.label) : null))));
  els.suggest.hidden = !sug.items.length;
}

function findDirectChat(value) {
  const key = handleKey(value);
  return sortedChats().find(c => !c.group && c.members.length === 1 && handleKey(c.members[0].handle) === key);
}

function pickRecipient(it) {
  els.suggest.hidden = true;
  const existing = findDirectChat(it.value);
  if (existing) {
    const text = els.input.value;
    if (text.trim()) S.drafts.set(existing.id, text);
    S.current = null;
    openChat(existing.id);
    return;
  }
  S.newTo = { value: it.value, label: it.label, name: it.name };
  renderHeader();
  renderSidebar();
  els.input.focus();
}

function resolveNewChat() {
  if (!S.awaiting) return;
  const c = findDirectChat(S.awaiting);
  if (!c) return;
  S.awaiting = null;
  for (const p of S.pending) if (p.chat === 'new') p.chat = c.id;
  if (S.current === 'new') { S.current = null; openChat(c.id); }
}

// ---------------------------------------------------------------- sending

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}

function updateSendState() {
  const target = S.current === 'new' ? !!S.newTo : typeof S.current === 'number';
  els.field.classList.toggle('ready', target && !!(els.input.value.trim() || S.tray.length));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name || 'file', data: String(r.result).slice(String(r.result).indexOf(',') + 1) });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function send() {
  let text = els.input.value.replace(/\s+$/, '');
  if (S.editing) { await finishEdit(text); return; }
  if (!text.trim() && !S.tray.length) return;
  // Messages' AppleScript can't thread a reply, so quote the text and send it normally.
  if (S.replyTo && text.trim()) text = `> ${S.replyTo.text}\n${text}`;
  S.replyTo = null;
  renderReplyBanner();
  let target;
  if (S.current === 'new') {
    if (!S.newTo) { toast('Choose who to send to first.'); return; }
    target = { to: S.newTo.value, service: S.newTo.value.includes('@') ? 'iMessage' : S.newSvc };
    S.awaiting = S.newTo.value;
  } else {
    const c = S.chats.get(S.current);
    if (!c) return;
    target = { chat: c.guid };
  }
  const p = {
    chat: S.current, target, text, date: Date.now(), service: target.service,
    fileObjs: S.tray.map(f => f.file), files: S.tray.map(f => ({ name: f.file.name, url: f.url })),
  };
  S.tray = [];
  renderTray();
  els.input.value = '';
  autosize();
  S.drafts.delete(S.current);
  persistDrafts();
  S.pending.push(p);
  updateSendState();
  S.stick = true;
  renderThread('bottom');
  if (S.settings.sounds) Sound.send();
  await deliver(p);
}

async function deliver(p) {
  try {
    const files = await Promise.all(p.fileObjs.map(readFile));
    await api('/api/send', { body: { ...p.target, text: p.text, files } });
    setTimeout(() => settleLate(p), 15000);
    if (p.chat === 'new') refreshChats();
  } catch (e) {
    p.failed = true;
    p.error = e.message;
    toast(e.message, true);
    if (S.current === p.chat) renderThread('auto');
  }
}

function resend(p) {
  p.failed = false;
  p.error = null;
  if (S.current === p.chat) renderThread('bottom');
  deliver(p);
}

function dropPending(p) {
  const i = S.pending.indexOf(p);
  if (i >= 0) S.pending.splice(i, 1);
  for (const f of p.files) if (f.url) URL.revokeObjectURL(f.url);
  if (S.current === p.chat) renderThread('auto');
}

function settleFor(m) {
  const p = S.pending.find(x => x.chat === m.chat && !x.failed &&
    (x.text ? (m.text && m.text.trim() === x.text.trim()) : (m.attachments && m.attachments.length)));
  if (p) dropPending(p);
  return !!p;
}

function settleLate(p) {
  // The real row normally replaces the optimistic one within a second; if it never matched
  // (text normalised by Messages, say), reload the thread so what's shown is what was sent.
  if (!S.pending.includes(p) || p.failed) return;
  dropPending(p);
  const t = S.threads.get(p.chat);
  if (t && S.current === p.chat) loadPage(p.chat, true);
  else if (t) t.loaded = false;
}

function addFiles(list) {
  for (const file of list) {
    if (file.size > 95 * 1024 * 1024) { toast(`${file.name} is over 95 MB.`, true); continue; }
    S.tray.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
  }
  renderTray();
  updateSendState();
  els.input.focus();
}

function renderTray() {
  els.tray.replaceChildren(...S.tray.map((f, i) => h('div', { class: 'tray-item', title: f.file.name },
    f.url ? h('img', { src: f.url, alt: '' }) : f.file.name,
    h('button', {
      title: 'Remove', 'aria-label': 'Remove attachment',
      onclick: () => { S.tray.splice(i, 1); renderTray(); updateSendState(); },
    }, '×'))));
}

// ---------------------------------------------------------------- find in conversation

function openFind() {
  if (typeof S.current !== 'number') return;
  S.find = S.find || { q: '', hits: [], i: -1 };
  els.find.hidden = false;
  els.main.classList.add('finding');
  els.findInput.focus();
  els.findInput.select();
  renderFind();
}

function closeFind(refocus) {
  if (!S.find && els.find.hidden) return;
  S.find = null;
  clearTimeout(findTimer);
  els.find.hidden = true;
  els.main.classList.remove('finding');
  els.findInput.value = '';
  for (const r of els.thread.querySelectorAll('.row.hit')) r.classList.remove('hit');
  if (refocus) els.input.focus();
}

function renderFind() {
  const f = S.find;
  if (!f) return;
  const n = f.hits.length;
  els.findCount.textContent = !f.q || f.q.length < 2 ? '' : f.busy ? 'Searching…'
    : n ? `${f.i + 1} of ${n}${n >= 300 ? '+' : ''}` : 'No results';
  els.findPrev.disabled = !n || f.i >= n - 1;
  els.findNext.disabled = !n || f.i <= 0;
}

let findTimer;
let findSeq = 0;
function runFind() {
  const f = S.find;
  if (!f) return;
  const q = els.findInput.value.trim();
  f.q = q;
  f.hits = [];
  f.i = -1;
  clearTimeout(findTimer);
  if (q.length < 2) { renderFind(); return; }
  f.busy = true;
  renderFind();
  const id = S.current;
  findTimer = setTimeout(async () => {
    const seq = ++findSeq;
    try {
      const hits = await api(`/api/search?chat=${id}&q=${encodeURIComponent(q)}`);
      if (seq !== findSeq || S.find !== f || S.current !== id) return;
      f.hits = hits.filter(m => m.text);
      f.busy = false;
      if (f.hits.length) stepFind(0); else renderFind();
    } catch (e) {
      f.busy = false;
      renderFind();
      toast(e.message, true);
    }
  }, 250);
}

// dir: +1 = older, -1 = newer, 0 = newest
async function stepFind(dir) {
  const f = S.find;
  if (!f || !f.hits.length) return;
  const i = dir === 0 ? 0 : f.i + dir;
  if (i < 0 || i >= f.hits.length) return;
  f.i = i;
  renderFind();
  for (const r of els.thread.querySelectorAll('.row.hit')) r.classList.remove('hit');
  const m = f.hits[i];
  await revealMessage(S.current, m.guid);
  const row = els.thread.querySelector(`[data-guid="${CSS.escape(m.guid)}"]`);
  if (row && S.find === f && f.i === i) row.classList.add('hit');
}

els.findBtn.addEventListener('click', () => (S.find ? closeFind(true) : openFind()));
els.findInput.addEventListener('input', runFind);
els.findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
});
els.findPrev.addEventListener('click', () => stepFind(1));
els.findNext.addEventListener('click', () => stepFind(-1));
els.findDone.addEventListener('click', () => closeFind(true));

// ---------------------------------------------------------------- send later

let when = null;
function closeWhen() { if (when) { when.remove(); when = null; } }

function at(hour, dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function sendLaterMenu(x, y) {
  const c = S.chats.get(S.current);
  if (!c) { toast('Send Later works in an existing conversation.'); return; }
  if (S.editing) return;
  if (S.tray.length) { toast('Send Later is for text messages; remove the attachments first.'); return; }
  if (!els.input.value.trim()) { toast('Type a message first, then right-click Send to schedule it.'); return; }
  const now = new Date();
  const items = [{ label: 'Send in 1 Hour', run: () => schedule(Date.now() + 3600000) }];
  if (now.getHours() < 20) items.push({ label: 'Send Tonight at 9 PM', run: () => schedule(at(21, 0)) });
  items.push({ label: 'Send Tomorrow at 8 AM', run: () => schedule(at(8, 1)) });
  items.push('-', { label: 'Custom Time…', run: () => customWhen() });
  showMenu(x, y, items);
}

function customWhen() {
  closeWhen();
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(Date.now() + 3600000);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const input = h('input', { type: 'datetime-local', value: local, min: local.slice(0, 11) + '00:00' });
  const go = () => {
    const t = new Date(input.value).getTime();
    if (!t || t < Date.now() + 60000) { toast('Pick a time at least a minute from now.'); return; }
    closeWhen();
    schedule(t);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  when = h('div', { class: 'when' },
    h('div', { class: 'when-title' }, 'Send Later'), input,
    h('div', { class: 'when-row' },
      h('button', { class: 'link-btn', onclick: closeWhen }, 'Cancel'),
      h('button', { class: 'when-go', onclick: go }, 'Schedule')));
  els.main.append(when);
  input.focus();
}

async function schedule(t) {
  const c = S.chats.get(S.current);
  const text = els.input.value.replace(/\s+$/, '');
  if (!c || !text.trim()) return;
  try {
    const item = await api('/api/scheduled', { body: { chat: c.guid, chatId: c.id, text, at: t } });
    if (!S.scheduled.some(x => x.id === item.id)) S.scheduled.push(item);
    els.input.value = '';
    autosize();
    S.drafts.delete(c.id);
    persistDrafts();
    updateSendState();
    S.stick = true;
    renderThread('bottom');
    toast(`Scheduled for ${whenText(t)}.`);
  } catch (e) {
    toast(e.message, true);
  }
}

function whenText(t) {
  const day = startOfDay(t);
  const today = startOfDay(Date.now());
  const label = day === today ? 'today' : day === today + DAY ? 'tomorrow'
    : new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${label} at ${clock(t)}`;
}

function scheduledRow(s, c) {
  const green = !!(c && isGreen(c.service));
  return h('div', { class: `row me gap sched${green ? ' sms' : ''}` },
    h('div', { class: 'col' },
      h('div', { class: 'bubble tail' }, ...linkify(s.text)),
      h('div', { class: 'meta' + (s.error ? ' err' : '') },
        s.error ? `Not sent: ${s.error}` : `Scheduled for ${whenText(s.at)}`,
        h('button', { class: 'link-btn', onclick: () => editScheduled(s) }, 'Edit'),
        h('button', { class: 'link-btn', onclick: () => unschedule(s) }, s.error ? 'Discard' : 'Cancel'))));
}

async function unschedule(s) {
  S.scheduled = S.scheduled.filter(x => x.id !== s.id);
  renderThread('auto');
  try { await api(`/api/scheduled/${s.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, true); }
}

async function editScheduled(s) {
  await unschedule(s);
  els.input.value = s.text;
  autosize();
  updateSendState();
  els.input.focus();
}

// ---------------------------------------------------------------- live events

function onStatus(d) {
  const was = S.status.connected;
  S.status = d;
  if (d.mac && d.mac.maxRowid) S.maxRowid = Math.max(S.maxRowid, d.mac.maxRowid);
  renderBanner();
  if (d.connected && !was) {
    refreshChats();
    api('/api/scheduled').then(onScheduled).catch(() => {});
    for (const [id, t] of S.threads) {
      if (id === S.current) loadPage(id, true); else t.loaded = false;
    }
  } else if (d.connected && d.contacts !== S.contactsSeen && S.contactsSeen >= 0) {
    S.contacts = null;
    refreshChats();
  }
  S.contactsSeen = d.contacts || 0;
  if (!d.connected) renderSidebar();
}

function renderBanner() {
  const st = S.status;
  if (st.connected) { els.banner.hidden = true; return; }
  const msg = st.server === false ? "The iMassage server isn't running."
    : `Can't reach your Mac:${st.error || 'connecting…'}`;
  els.banner.replaceChildren(msg, st.server === false ? null
    : h('button', { class: 'link-btn', onclick: () => api('/api/reconnect', { body: {} }).catch(e => toast(e.message, true)) }, 'Retry'));
  els.banner.hidden = false;
}

function notify(m, c) {
  const title = c ? (c.group ? `${m.sender || 'Someone'} in ${c.name}` : c.name) : (m.sender || 'New message');
  const body = previewText(m) || 'New message';
  if (shell) {
    shell.notify({ title, body, chat: m.chat, photo: m.senderPhoto ? new URL(m.senderPhoto, location.href).href : null });
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: `chat-${m.chat}`, renotify: true, icon: m.senderPhoto || 'icon.svg' });
    n.onclick = () => { window.focus(); openChat(m.chat); n.close(); };
  } catch { /* notifications unavailable */ }
}

function onMessages(list) {
  let needChats = false;
  let heard = false;
  const touched = new Set();
  for (const m of list) {
    const isNew = m.id > S.maxRowid;
    if (isNew) { S.maxRowid = m.id; m._fresh = true; }
    const c = S.chats.get(m.chat);
    if (!c) {
      needChats = true;
    } else {
      if (!m.reaction && (!c.last || m.id >= c.last.id)) c.last = m;
      if (isNew) c.lastDate = Math.max(c.lastDate, m.date);
      if (!m.fromMe && !m.reaction && !m.itemType) {
        if (m.read) c.unread = c.unread.filter(x => x !== m.id);
        else if (isNew && !viewing(m.chat) && !c.unread.includes(m.id)) c.unread = [...c.unread, m.id];
      }
      if (isNew && (m.itemType === 1 || m.itemType === 2)) needChats = true;
    }
    if (m.fromMe && isNew && !m.reaction && settleFor(m)) delete m._fresh;
    const t = S.threads.get(m.chat);
    if (t && t.loading) t.queue.push(m);
    else if (t && t.loaded) { upsert(t, m, isNew); touched.add(m.chat); }
    if (isNew && !m.fromMe && !(c && c.filtered === 2)) {
      heard = true;
      if (!(document.hasFocus() && document.visibilityState === 'visible')) {
        notify(m, c);
        if (shell) shell.attention();
      }
    }
  }
  if (heard && S.settings.sounds) Sound.receive();
  if (needChats) refreshChats(); else renderSidebar();
  if (touched.has(S.current)) {
    renderThread('auto');
    markSeen(S.current);
  }
  if (S.details && touched.has(S.current)) S.media.delete(S.current);
}

function onScheduled(items) {
  S.scheduled = items || [];
  if (typeof S.current === 'number') renderThread('auto');
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.type === 'status') onStatus(d);
    else if (d.type === 'messages') onMessages(d.messages);
    else if (d.type === 'scheduled') onScheduled(d.items);
  };
  es.onerror = () => {
    if (S.status.server !== false) onStatus({ connected: false, server: false });
  };
}

// ---------------------------------------------------------------- lightbox

function openLightbox(items, index) {
  if (!items.length) return;
  S.lb = { items, index };
  showLightbox();
  els.lightbox.hidden = false;
}

function showLightbox() {
  const { items, index } = S.lb;
  const it = items[index];
  const url = `/api/attachment/${it.id}`;
  const media = (it.mime || '').startsWith('video/')
    ? h('video', { src: url, controls: true, autoplay: true })
    : h('img', { src: url, alt: it.name || '' });
  els.lbStage.replaceChildren(media);
  els.lbName.textContent = it.name || '';
  els.lbSave.href = `${url}?download=1`;
  els.lbSave.setAttribute('download', it.name || 'attachment');
  els.lbPrev.hidden = index <= 0;
  els.lbNext.hidden = index >= items.length - 1;
}

function stepLightbox(dir) {
  if (!S.lb) return;
  const i = S.lb.index + dir;
  if (i < 0 || i >= S.lb.items.length) return;
  S.lb.index = i;
  showLightbox();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbStage.replaceChildren();
  S.lb = null;
}

// ---------------------------------------------------------------- wiring

let searchTimer;
let searchSeq = 0;
els.search.addEventListener('input', () => {
  const q = els.search.value.trim();
  renderSidebar();
  clearTimeout(searchTimer);
  if (q.length < 2) { S.hits = null; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const hits = await api('/api/search?q=' + encodeURIComponent(q));
      if (seq === searchSeq) { S.hits = { q, hits }; renderSidebar(); }
    } catch { /* keep name matches */ }
  }, 260);
});
els.search.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const first = els.chatlist.querySelector('.chat[data-id]');
    if (first) openChat(Number(first.dataset.id));
  }
});

els.compose.addEventListener('click', startCompose);
els.junk.addEventListener('click', () => { S.showJunk = !S.showJunk; renderSidebar(); });
els.who.addEventListener('click', () => (S.details ? closeDetails() : openDetails()));
els.back.addEventListener('click', () => {
  if (S.editing) cancelEdit();
  saveDraft();
  closeFind();
  S.current = null;
  closeDetails();
  els.app.classList.remove('in-chat');
  els.empty.hidden = false;
  renderSidebar();
});

els.toInput.addEventListener('input', renderSuggest);
els.toInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!sug.items.length) return;
    sug.active = (sug.active + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    drawSuggest();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    const it = sug.items[sug.active];
    if (it) { e.preventDefault(); pickRecipient(it); }
  }
});
els.toInput.addEventListener('blur', () => setTimeout(() => { els.suggest.hidden = true; }, 150));
els.toInput.addEventListener('focus', renderSuggest);
els.svcPick.addEventListener('click', e => {
  const b = e.target.closest('button[data-svc]');
  if (b) { S.newSvc = b.dataset.svc; renderToRow(); }
});

let draftTimer;
els.input.addEventListener('input', () => {
  autosize();
  updateSendState();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);  // survives a restart
});
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
els.input.addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
els.send.addEventListener('click', send);
els.send.addEventListener('contextmenu', e => { e.preventDefault(); sendLaterMenu(e.clientX, e.clientY); });
els.sideScroll.addEventListener('scroll', () => {
  const el = els.sideScroll;
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 400 || chatsBusy || els.search.value.trim()) return;
  if (S.chats.size >= S.chatLimit) { S.chatLimit += 300; refreshChats(); }  // older conversations
});
els.attach.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => { addFiles([...els.file.files]); els.file.value = ''; });
els.emoji.addEventListener('click', () => {
  els.input.focus();
  if (shell) shell.emoji();
  else toast('Press Windows + . for emoji');
});

let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', e => { if (hasFiles(e) && S.current != null) { dragDepth++; els.drop.hidden = false; } });
document.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; els.drop.hidden = true; } });
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  if (S.current != null) addFiles([...e.dataTransfer.files]);
});

// Stay pinned to the newest message until the person scrolls away. Images finishing above or below
// fire scroll events too, so only user input may unpin; reaching the bottom always re-pins.
let userScrollUntil = 0;
const userScrolled = () => { userScrollUntil = Date.now() + 800; };
for (const ev of ['wheel', 'touchmove', 'pointerdown']) els.messages.addEventListener(ev, userScrolled, { passive: true });
els.messages.addEventListener('scroll', () => {
  const box = els.messages;
  closeTapbackPicker();
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 60) S.stick = true;
  else if (Date.now() < userScrollUntil) S.stick = false;
  if (box.scrollTop < 300 && typeof S.current === 'number') {
    const t = S.threads.get(S.current);
    if (t && t.loaded && t.more && !t.loading) loadPage(S.current, false);
  }
});
new ResizeObserver(() => { if (S.stick) els.messages.scrollTop = els.messages.scrollHeight; }).observe(els.thread);

els.lightbox.addEventListener('click', e => { if (e.target === els.lightbox || e.target === els.lbStage) closeLightbox(); });
els.lbClose.addEventListener('click', closeLightbox);
els.lbPrev.addEventListener('click', () => stepLightbox(-1));
els.lbNext.addEventListener('click', () => stepLightbox(1));
document.addEventListener('mousedown', e => { if (!els.menu.hidden && !els.menu.contains(e.target)) hideMenu(); });
window.addEventListener('blur', () => { hideMenu(); closeTapbackPicker(); document.body.classList.add('no-focus'); });
window.addEventListener('focus', () => {
  document.body.classList.remove('no-focus');
  if (typeof S.current === 'number') markSeen(S.current);
  renderSidebar();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && typeof S.current === 'number') markSeen(S.current);
});

// Sidebar width: drag the divider.
{
  const saved = Number(recall('sideWidth'));
  if (saved) els.sidebar.style.setProperty('--side-w', `${saved}px`);
  els.splitter.addEventListener('pointerdown', e => {
    e.preventDefault();
    els.splitter.setPointerCapture(e.pointerId);
    const move = ev => {
      const w = Math.max(250, Math.min(460, ev.clientX));
      els.sidebar.style.setProperty('--side-w', `${w}px`);
    };
    const up = ev => {
      els.splitter.removeEventListener('pointermove', move);
      store('sideWidth', String(Math.max(250, Math.min(460, ev.clientX))));
    };
    els.splitter.addEventListener('pointermove', move);
    els.splitter.addEventListener('pointerup', up, { once: true });
  });
}

function stepChat(dir) {
  const ids = [...document.querySelectorAll('#pins .pin[data-id], #chatlist .chat[data-id]')].map(el => Number(el.dataset.id));
  if (!ids.length) return;
  const i = ids.indexOf(S.current);
  const next = ids[Math.min(ids.length - 1, Math.max(0, (i < 0 ? -1 : i) + dir))];
  if (next != null) {
    openChat(next);
    const el = document.querySelector(`[data-id="${next}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest && e.target.closest('input, textarea');
  if (!els.lightbox.hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
    return;
  }
  if (mod && k === 'n') { e.preventDefault(); startCompose(); }
  else if (e.altKey && k === 'n') { e.preventDefault(); startCompose(); }
  else if (mod && k === 'f' && !e.shiftKey && typeof S.current === 'number' && S.chats.has(S.current)) { e.preventDefault(); openFind(); }
  else if (mod && k === 'f') { e.preventDefault(); els.search.focus(); els.search.select(); }
  else if (S.find && e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (mod && k === 'i') { e.preventDefault(); S.details ? closeDetails() : openDetails(); }
  else if ((mod && e.key === 'Tab') || (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) {
    e.preventDefault();
    stepChat(e.key === 'ArrowUp' || e.shiftKey ? -1 : 1);
  } else if (mod && /^[1-9]$/.test(e.key)) {
    const id = S.pins[Number(e.key) - 1];
    if (id != null) { e.preventDefault(); openChat(id); }
  } else if (e.key === 'Escape') {
    if (tapbar) closeTapbackPicker();
    else if (!els.menu.hidden) hideMenu();
    else if (when) closeWhen();
    else if (S.find) closeFind(true);
    else if (S.editing) cancelEdit();
    else if (S.replyTo) cancelReply();
    else if (S.details) closeDetails();
    else if (document.activeElement === els.search && els.search.value) { els.search.value = ''; S.hits = null; renderSidebar(); }
    else if (S.current === 'new') {
      S.current = null;
      els.empty.hidden = false;
      els.app.classList.remove('in-chat');
      renderSidebar();
    }
  } else if (!typing && !mod && !e.altKey && e.key.length === 1 && typeof S.current === 'number') {
    els.input.focus();  // start typing anywhere, like Messages
  } else if (!typing && ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    userScrolled();
  }
});

setInterval(() => { if (!S.current || typeof S.current === 'number') renderSidebar(); }, 60000);  // keep "Yesterday" honest

if (shell) {
  shell.on('open-chat', id => openChat(Number(id)));
  shell.on('compose', () => startCompose());
  shell.on('settings', s => Object.assign(S.settings, s));
  shell.settings().then(s => Object.assign(S.settings, s)).catch(() => {});
} else {
  S.settings.sounds = recall('sounds') !== 'off';
  document.addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }, { once: true });
}

renderSidebar();
connectEvents();
