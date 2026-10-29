/* Hearth web app. Vanilla JS, no dependencies, no third-party requests.
   All feed text is inserted with textContent; innerHTML is used only for the
   constant SVG icon strings below. */
'use strict';
(() => {
  const FEED_URL = 'data/feed.json';
  const PRIVATE_URL = 'data/private.json';
  const FRIENDS_URL = 'data/friends.json';
  const PERSONAL_STORE = 'hearth.highlightsKey.v1';
  const FRIENDS_STORE = 'hearth.friendsKey.v1';
  const PBKDF2_ITERATIONS = 200000;
  const STALE_MS = 3 * 60 * 60 * 1000;
  const WIDE = window.matchMedia('(min-width: 900px)');
  const TABS = ['today', 'markets', 'weather', 'news'];
  // ?kiosk: always-on wall screen (no mouse): one screen, clock, self-refreshing.
  const KIOSK = new URLSearchParams(location.search).has('kiosk');
  if (KIOSK) document.documentElement.classList.add('kiosk');

  const state = {
    feed: null,
    priv: null,            // data/private.json (personal tier blob)
    friends: null,         // data/friends.json (friends tier blob)
    personal: null,        // decrypted {highlights, media}, memory only
    key: null,             // personal CryptoKey for the current salt, memory only
    keySalt: null,
    friendsMedia: null,    // decrypted media, memory only
    friendsKey: null,
    friendsSalt: null,
    friendsSecret: null,   // from #f=KEY, held only until the first decrypt attempt
    lockNote: '',
    lastError: null,
    loading: false,
    tab: 'today',
    open: new Set(),       // expanded item ids, kept across re-renders
    marketsOpen: false,    // wide-screen "All markets" toggle
  };

  /* ---------- Icons (constant markup only) ---------- */
  const CLOUD = 'M6.5 18a4 4 0 0 1-.4-7.98A6 6 0 0 1 17.6 8.6 4.75 4.75 0 0 1 17.5 18z';
  const WX = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6" fill="#ffc861"/><g stroke="#ffc861" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.55 1.55M17.15 17.15l1.55 1.55M5.3 18.7l1.55-1.55M17.15 6.85l1.55-1.55"/></g></svg>',
    clearNight: '<svg viewBox="0 0 24 24"><path d="M14.5 3.2a8.8 8.8 0 1 0 6.3 13.9A7.2 7.2 0 0 1 14.5 3.2z" fill="#e9e4ff"/><path d="M19 4.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" fill="#e9e4ff"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="' + CLOUD + '" fill="#cdd5ea"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><g transform="translate(0 -3)"><path d="' + CLOUD + '" fill="#b7c1da"/></g><g stroke="#73bfff" stroke-width="1.9" stroke-linecap="round"><path d="M8.2 17.6l-1 3M12.2 17.6l-1 3M16.2 17.6l-1 3"/></g></svg>',
    snow: '<svg viewBox="0 0 24 24"><g transform="translate(0 -3)"><path d="' + CLOUD + '" fill="#cdd5ea"/></g><g fill="#ffffff"><circle cx="7.5" cy="18.5" r="1.25"/><circle cx="12" cy="20.5" r="1.25"/><circle cx="16.5" cy="18.5" r="1.25"/></g></svg>',
    storm: '<svg viewBox="0 0 24 24"><g transform="translate(0 -3)"><path d="' + CLOUD + '" fill="#8f9bb8"/></g><path d="M12.8 13.5L9.6 18.4h2.6l-1.2 4.1 4-5.4h-2.7l1.3-3.6z" fill="#ffd34d"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><g transform="translate(0 -2.5)"><path d="' + CLOUD + '" fill="#aab3c9"/></g><g stroke="#d6dbe8" stroke-width="1.8" stroke-linecap="round"><path d="M4 18.5h16M6.5 21.5h11"/></g></svg>',
  };
  const UI = {
    chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M12 3.5L2.8 19.5h18.4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/></svg>',
    play: '<svg class="play" viewBox="0 0 48 34" aria-hidden="true" focusable="false"><rect width="48" height="34" rx="9" fill="#ff1f1f"/><path d="M19 10l13 7-13 7z" fill="#fff"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  };
  const KIND = {
    weather: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + CLOUD + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    package: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    event: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="5.5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bill: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    news: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 9h8M8 12.5h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    other: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>',
  };

  /* ---------- Small helpers ---------- */
  let uidCounter = 0;
  const uid = (p) => `${p}-${++uidCounter}`;

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false || kid === '') continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function svg(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  }

  const CONDITIONS = new Set(Object.keys(WX));
  function wxIcon(condition, label, size) {
    const key = CONDITIONS.has(condition) ? condition : 'cloud';
    const wrap = el('span', { class: 'wx' + (size ? ' wx-' + size : '') });
    const s = svg(WX[key]);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    wrap.append(s);
    if (label) wrap.append(el('span', { class: 'visually-hidden', text: label }));
    return wrap;
  }

  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

  const nfCache = new Map();
  function fmt(v, digits) {
    const d = Math.min(Math.max(digits | 0, 0), 6);
    if (!nfCache.has(d)) nfCache.set(d, new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
    return nfCache.get(d).format(v);
  }
  const deg = (v) => (num(v) === null ? '--' : `${Math.round(num(v))}°`);

  function parseDate(s) {
    if (typeof s !== 'string' || !s) return null;
    // Plain dates ("2026-10-27") are local calendar days, not UTC midnight.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const timeText = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function dateTimeText(d) {
    const now = new Date();
    if (sameDay(d, now)) return timeText(d);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (sameDay(d, tomorrow)) return 'Tomorrow ' + timeText(d);
    return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function relTime(d) {
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return 'just now';
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    return rtf.format(Math.round(sec / 86400), 'day');
  }
  const firstSentence = (s) => {
    const t = str(s);
    const m = /^(.+?[.!?])(\s|$)/.exec(t);
    return m ? m[1] : t;
  };

  /* ---------- Expanders ---------- */
  function expander(id, opts) {
    // opts: header (Node[]), detail (() => Node[]), className
    const open = state.open.has(id);
    const detailId = uid('detail');
    const btn = el('button', { type: 'button', class: 'exp-btn', 'aria-expanded': String(open), 'aria-controls': detailId },
      opts.header, svg(UI.chevron));
    const detail = el('div', { class: 'exp-detail', id: detailId });
    detail.hidden = !open;
    let built = false;
    const build = () => { if (!built) { detail.append(...opts.detail()); built = true; } };
    if (open) build();
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('aria-expanded') !== 'true';
      if (next) { build(); state.open.add(id); } else state.open.delete(id);
      btn.setAttribute('aria-expanded', String(next));
      detail.hidden = !next;
    });
    const wrap = el('div', { class: 'exp' + (opts.className ? ' ' + opts.className : ''), 'data-exp-id': id }, btn, detail);
    return wrap;
  }

  /* ---------- Tabs ---------- */
  const tabButtons = () => Array.from(document.querySelectorAll('[role="tab"]'));

  function setTab(name, focus) {
    if (!TABS.includes(name)) name = 'today';
    state.tab = name;
    for (const b of tabButtons()) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const t of TABS) document.getElementById('panel-' + t).classList.toggle('active', t === name);
    const hash = name === 'today' ? ' ' : '#' + name;
    try { history.replaceState(null, '', hash === ' ' ? location.pathname + location.search : hash); } catch (_) { /* ignore */ }
  }

  function syncLayoutRoles() {
    // On wide screens all four sections show at once, so they are plain regions.
    for (const t of TABS) {
      const p = document.getElementById('panel-' + t);
      if (WIDE.matches) { p.setAttribute('role', 'region'); }
      else { p.setAttribute('role', 'tabpanel'); }
    }
  }

  function initTabs() {
    for (const b of tabButtons()) {
      b.addEventListener('click', () => { setTab(b.dataset.tab); window.scrollTo(0, 0); });
      b.addEventListener('keydown', (e) => {
        const i = TABS.indexOf(b.dataset.tab);
        let n = null;
        if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = TABS.length - 1;
        if (n !== null) { e.preventDefault(); setTab(TABS[n], true); }
      });
    }
    const fromHash = location.hash.replace('#', '');
    setTab(TABS.includes(fromHash) ? fromHash : 'today');
    syncLayoutRoles();
    WIDE.addEventListener('change', () => { syncLayoutRoles(); renderMarkets(); });
  }

  /* ---------- Crypto (mirrors scripts/publish.py) ---------- */
  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  const cryptoReady = () => !!(window.crypto && crypto.subtle && window.isSecureContext);

  async function deriveRawKey(secret, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, base, 256);
    return new Uint8Array(bits);
  }
  const importAesKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);

  async function decryptBlob(key, blob) {
    // WebCrypto expects ciphertext || 16-byte tag, which is what AESGCM.encrypt produces.
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv), tagLength: 128 }, key, b64ToBytes(blob.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  const isEncrypted = (p) => !!(p && !p.disabled && typeof p.salt === 'string' && typeof p.iv === 'string' && typeof p.ciphertext === 'string');

  // Payload shapes, current and older.
  function personalFrom(data) {
    if (Array.isArray(data)) return { highlights: data, media: null };   // oldest: bare highlights array
    const o = obj(data) || {};
    return { highlights: arr(o.highlights), media: obj(o.media) };       // media here = pre-friends blob
  }
  function friendsFrom(data) {
    const o = obj(data);
    if (!o) return null;
    if ('media' in o) return obj(o.media);
    return o.breakingPoints ? o : null;                                  // bare media object
  }

  // Stored key material: {salt, key} where key is the PBKDF2 output (never the secret).
  function readStore(name) {
    try {
      const v = JSON.parse(localStorage.getItem(name) || 'null');
      return v && typeof v.salt === 'string' && typeof v.key === 'string' ? v : null;
    } catch (_) { return null; }
  }
  function writeStore(name, salt, raw) {
    try { localStorage.setItem(name, JSON.stringify({ salt, key: bytesToB64(raw) })); } catch (_) { /* ignore */ }
  }
  function clearStore(name) { try { localStorage.removeItem(name); } catch (_) { /* ignore */ } }

  /* Personal tier: typed passphrase. */
  async function autoUnlockPersonal() {
    const blob = state.priv;
    if (!isEncrypted(blob) || !cryptoReady()) { state.personal = null; return; }
    if (state.key && state.keySalt === blob.salt) {
      try { state.personal = personalFrom(await decryptBlob(state.key, blob)); return; }
      catch (_) { state.key = null; state.keySalt = null; }
    }
    state.personal = null;
    const stored = readStore(PERSONAL_STORE);
    if (!stored) return;
    if (stored.salt !== blob.salt) {
      clearStore(PERSONAL_STORE);
      state.lockNote = 'The saved key no longer matches. Enter the passphrase again.';
      return;
    }
    try {
      const key = await importAesKey(b64ToBytes(stored.key));
      state.personal = personalFrom(await decryptBlob(key, blob));
      state.key = key; state.keySalt = blob.salt;
    } catch (_) {
      clearStore(PERSONAL_STORE);
      state.lockNote = 'The saved key no longer works. Enter the passphrase again.';
    }
  }

  async function unlockWithPassphrase(passphrase, remember) {
    const blob = state.priv;
    const raw = await deriveRawKey(passphrase, b64ToBytes(blob.salt));
    const key = await importAesKey(raw);
    const data = personalFrom(await decryptBlob(key, blob)); // throws on wrong passphrase
    state.key = key; state.keySalt = blob.salt; state.personal = data; state.lockNote = '';
    if (remember) writeStore(PERSONAL_STORE, blob.salt, raw);
    raw.fill(0);
  }

  function lockPersonal() {
    // Personal tier only; the friends key stays.
    clearStore(PERSONAL_STORE);
    state.key = null; state.keySalt = null; state.personal = null; state.lockNote = '';
    renderToday();
    const target = document.querySelector('.lock-card input[type="password"]');
    if (target) target.focus({ preventScroll: true });
  }

  /* Friends tier: key arrives once as #f=KEY, then lives in localStorage. No UI. */
  function takeFriendsSecretFromUrl() {
    const m = /^#f=(.+)$/.exec(location.hash);
    if (!m) return false;
    let secret = m[1];
    try { secret = decodeURIComponent(secret); } catch (_) { /* use as-is */ }
    state.friendsSecret = secret;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* ignore */ }
    return true;
  }

  async function unlockFriends() {
    const blob = state.friends;
    state.friendsMedia = null;
    if (!isEncrypted(blob) || !cryptoReady()) return;
    if (state.friendsSecret) {
      const secret = state.friendsSecret;
      state.friendsSecret = null;
      try {
        const raw = await deriveRawKey(secret, b64ToBytes(blob.salt));
        const key = await importAesKey(raw);
        state.friendsMedia = friendsFrom(await decryptBlob(key, blob));
        writeStore(FRIENDS_STORE, blob.salt, raw);
        state.friendsKey = key; state.friendsSalt = blob.salt;
        raw.fill(0);
        return;
      } catch (_) { /* wrong link key: fall back to any saved key */ }
    }
    if (state.friendsKey && state.friendsSalt === blob.salt) {
      try { state.friendsMedia = friendsFrom(await decryptBlob(state.friendsKey, blob)); return; }
      catch (_) { state.friendsKey = null; state.friendsSalt = null; }
    }
    const stored = readStore(FRIENDS_STORE);
    if (!stored || stored.salt !== blob.salt) return; // kept; only clearing storage removes it
    try {
      const key = await importAesKey(b64ToBytes(stored.key));
      state.friendsMedia = friendsFrom(await decryptBlob(key, blob));
      state.friendsKey = key; state.friendsSalt = blob.salt;
    } catch (_) { /* leave it */ }
  }

  const currentMedia = () => state.friendsMedia || (state.personal && state.personal.media) || null;

  /* ---------- Today ---------- */
  function renderToday() {
    const body = document.getElementById('today-body');
    const feed = state.feed;
    const w = obj(feed && feed.weather);
    const now = new Date();
    const kids = [el('h3', { class: 'today-date', text: now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) })];

    if (w) {
      const daily0 = obj(arr(w.daily)[0]) || {};
      const hi = num(w.high) !== null ? w.high : daily0.high;
      const lo = num(w.low) !== null ? w.low : daily0.low;
      const line = firstSentence(daily0.summary || w.summary);
      const card = el('div', { class: 'card today-weather' },
        wxIcon(str(w.condition), '', 'md'),
        el('div', null,
          el('span', { class: 'temp', text: deg(w.temp) }),
          el('div', { class: 'cond', text: str(w.conditionText) }),
          (num(hi) !== null || num(lo) !== null) ? el('div', { class: 'muted small tabular', text: `H ${deg(hi)}  L ${deg(lo)}` }) : null),
        line ? el('p', { class: 'line', text: line }) : null);
      const alerts = arr(w.alerts).map(obj).filter(Boolean);
      if (alerts.length) {
        const a = alerts[0];
        const extra = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : '';
        const banner = el('button', { type: 'button', class: 'alert-banner' + (isSevere(a) ? ' severe' : '') },
          svg(UI.alert), el('span', { text: (str(a.title) || 'Weather alert') + extra }));
        banner.addEventListener('click', () => {
          state.open.add('alert:0');
          renderWeather();
          setTab('weather');
          const target = document.querySelector('[data-exp-id="alert:0"]');
          if (target) { target.scrollIntoView({ block: 'start' }); target.querySelector('button').focus({ preventScroll: true }); }
        });
        card.append(banner);
      }
      kids.push(card);
    }

    kids.push(...watchCard(currentMedia()));
    kids.push(...renderHighlights());
    body.replaceChildren(...kids);
  }

  // Media link: only from a decrypted blob. Without a key nothing renders, not even a placeholder.
  function watchCard(media) {
    const bp = obj(media && media.breakingPoints);
    const url = bp && safeUrl(bp.url);
    if (!url) return [];
    const when = parseDate(bp.publishedAt);
    const live = str(bp.kind).toLowerCase() === 'live';
    const link = el('a', { class: 'watch-card', href: url.href, target: '_blank', rel: 'noopener' },
      svg(UI.play),
      el('span', { class: 'watch-main' },
        el('span', { class: 'watch-caption' }, 'Breaking Points', live ? el('span', { class: 'live-pill', text: 'LIVE' }) : null),
        el('span', { class: 'watch-title', text: str(bp.title) || 'New episode' }),
        when ? el('span', { class: 'watch-time', text: relTime(when), 'data-when': when.toISOString(), 'data-base': '' }) : null,
        el('span', { class: 'visually-hidden', text: ' (opens YouTube)' })));
    return [el('h3', { class: 'section-label', text: 'Watch' }), link];
  }

  function highlightItem(h, id) {
    const kind = str(h.kind).toLowerCase();
    const icon = el('span', { class: 'hl-icon' }, svg(KIND[kind] || KIND.other));
    const main = el('div', { class: 'exp-main' },
      el('div', { class: 'hl-title', text: str(h.title) || 'Untitled' }),
      str(h.detail) ? el('div', { class: 'hl-detail', text: str(h.detail) }) : null);
    if (str(h.body)) {
      return expander(`hl:${id}:${str(h.title)}`, {
        header: [icon, main],
        detail: () => [el('p', { class: 'hl-body', text: str(h.body) })],
      });
    }
    return el('div', { class: 'card hl-item', 'data-hl': id }, icon, main);
  }

  function renderHighlights() {
    const publicItems = arr(state.feed && state.feed.highlights).map(obj).filter(Boolean);
    const hasPersonal = isEncrypted(state.priv);
    const unlocked = !!state.personal;
    if (!publicItems.length && !hasPersonal) return [];

    // Older private blobs may repeat items that are now public; skip exact repeats.
    const seen = new Set(publicItems.map((h) => `${str(h.kind)}|${str(h.title)}`));
    const personalItems = unlocked
      ? state.personal.highlights.map(obj).filter((h) => h && !seen.has(`${str(h.kind)}|${str(h.title)}`))
      : [];

    const out = [el('h3', { class: 'section-label', text: 'Highlights' })];
    const list = el('div', { class: 'list' });
    publicItems.forEach((h, i) => list.append(highlightItem(h, 'pub' + i)));
    personalItems.forEach((h, i) => list.append(highlightItem(h, 'me' + i)));
    if (unlocked && !list.childNodes.length) list.append(el('p', { class: 'empty', text: 'Nothing flagged for today.' }));
    if (list.childNodes.length) out.push(list);

    if (unlocked) {
      const lockBtn = el('button', { type: 'button', class: 'btn-text', 'aria-label': 'Lock my items', text: 'Lock' });
      lockBtn.addEventListener('click', lockPersonal);
      out.push(el('div', { class: 'hl-footer' }, lockBtn));
    } else if (hasPersonal) {
      out.push(lockCard());
    }
    return out;
  }

  function lockCard() {
    const card = el('div', { class: 'card lock-card' });
    card.append(el('h3', null, svg(UI.lock), 'Unlock my items'));
    if (!cryptoReady()) {
      card.append(el('p', { class: 'muted', text: 'Unlocking needs a secure (https) connection.' }));
      return card;
    }
    const inputId = uid('pass');
    const errId = uid('err');
    const input = el('input', { id: inputId, type: 'password', name: 'passphrase', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', required: true, 'aria-describedby': errId });
    const remember = el('input', { type: 'checkbox', name: 'remember' });
    const err = el('p', { class: 'form-error', id: errId, role: 'alert' });
    const submit = el('button', { type: 'submit', class: 'btn', text: 'Unlock' });
    const form = el('form', { novalidate: true },
      // Hidden username helps password managers file the passphrase under "Hearth".
      el('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'Hearth', hidden: true, 'aria-hidden': 'true', tabindex: '-1' }),
      el('label', { class: 'field', for: inputId }, 'Passphrase', input),
      el('label', { class: 'check' }, remember, 'Remember on this device'),
      err, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = input.value;
      if (!pass) { err.textContent = 'Enter the passphrase.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      submit.disabled = true; submit.textContent = 'Unlocking…'; err.textContent = '';
      try {
        await unlockWithPassphrase(pass, remember.checked);
        input.value = '';
        renderToday();
      } catch (_) {
        submit.disabled = false; submit.textContent = 'Unlock';
        err.textContent = 'That passphrase didn’t work. Try again.';
        input.setAttribute('aria-invalid', 'true');
        input.select();
        input.focus();
      }
    });
    card.append(el('p', { class: 'muted small', text: state.lockNote || 'Enter your passphrase to show your personal items. Decryption happens on this device.' }), form);
    return card;
  }

  /* ---------- Markets ---------- */
  const isFearGreed = (t) => str(t.symbol).toUpperCase() === 'FEAR_GREED';
  function displaySymbol(t) {
    const s = str(t.symbol);
    if (isFearGreed(t)) return 'Fear & Greed';
    return s.replace(/-USD$/i, '');
  }
  function caption(t) {
    const n = str(t.name);
    return n && n.toLowerCase() !== displaySymbol(t).toLowerCase() ? n : '';
  }
  function digitsFor(t, v) {
    if (isFearGreed(t)) return 0;
    const d = num(t.decimals);
    if (d !== null) return Math.min(Math.max(Math.round(d), 0), 6);
    return Math.abs(v) >= 1000 ? 0 : 2;
  }
  const fmtFor = (t, v) => (num(v) === null ? '--' : fmt(num(v), digitsFor(t, num(v))));
  function priceNode(t, cls) {
    const p = num(t.price);
    const unit = str(t.unit);
    return el('span', { class: 'price' + (cls ? ' ' + cls : '') }, p === null ? '--' : fmt(p, digitsFor(t, p)), unit ? el('span', { class: 'unit', text: unit }) : null);
  }
  function changeChip(t) {
    const c = num(t.changePct);
    if (c === null) return null;
    const dir = c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
    const sign = c > 0 ? '+' : c < 0 ? '−' : '';
    return el('span', { class: 'chip ' + dir, text: `${sign}${fmt(Math.abs(c), 2)}%` });
  }
  const FG_BANDS = [
    [0, 25, '#e05050', 'Extreme fear'],
    [25, 45, '#f28c38', 'Fear'],
    [45, 55, '#d9cc66', 'Neutral'],
    [55, 75, '#8ccc66', 'Greed'],
    [75, 100, '#40b86b', 'Extreme greed'],
  ];
  const fgBand = (v) => Math.max(0, FG_BANDS.findIndex(([a, b]) => v >= a && (v < b || b === 100)));
  function fgChip(t) {
    const v = num(t.price);
    if (v === null) return null;
    const i = fgBand(v);
    return el('span', { class: 'small fg-' + i, text: str(t.note) || FG_BANDS[i][3] });
  }
  const rsiRead = (r) => (r < 30 ? 'Oversold' : r > 70 ? 'Overbought' : 'Neutral');

  function gauge(v) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 200 112');
    s.setAttribute('class', 'gauge');
    s.setAttribute('aria-hidden', 'true');
    const pt = (val, r) => {
      const a = Math.PI * (1 - val / 100);
      return [100 + r * Math.cos(a), 100 - r * Math.sin(a)];
    };
    for (const [a, b, color] of FG_BANDS) {
      const [x1, y1] = pt(a + 0.8, 80);
      const [x2, y2] = pt(b - 0.8, 80);
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M${x1.toFixed(2)} ${y1.toFixed(2)} A80 80 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', '16');
      s.append(p);
    }
    const clamped = Math.min(100, Math.max(0, v));
    const [nx, ny] = pt(clamped, 64);
    const needle = document.createElementNS(NS, 'line');
    needle.setAttribute('x1', '100'); needle.setAttribute('y1', '100');
    needle.setAttribute('x2', nx.toFixed(2)); needle.setAttribute('y2', ny.toFixed(2));
    needle.setAttribute('stroke', '#ffffff'); needle.setAttribute('stroke-width', '4'); needle.setAttribute('stroke-linecap', 'round');
    const hub = document.createElementNS(NS, 'circle');
    hub.setAttribute('cx', '100'); hub.setAttribute('cy', '100'); hub.setAttribute('r', '7'); hub.setAttribute('fill', '#ffffff');
    s.append(needle, hub);
    return s;
  }

  function tickerDetail(t) {
    const out = [];
    if (isFearGreed(t) && num(t.price) !== null) {
      const v = num(t.price);
      const i = fgBand(v);
      out.push(el('div', { class: 'gauge-wrap' }, gauge(v),
        el('div', null,
          el('div', { class: 'gauge-value fg-' + i, text: fmt(v, 0) }),
          el('div', { class: 'fg-' + i, text: FG_BANDS[i][3] }),
          el('div', { class: 'faint small', text: '0 = extreme fear, 100 = extreme greed' }))));
    }
    const stats = [];
    if (num(t.prevClose) !== null) stats.push(['Prev close', fmtFor(t, t.prevClose)]);
    const rsi = num(t.rsi);
    if (stats.length || rsi !== null) {
      const dl = el('dl', { class: 'stat-grid' });
      for (const [k, v] of stats) dl.append(el('div', { class: 'stat' }, el('dt', { text: k }), el('dd', { class: 'tabular', text: v })));
      if (rsi !== null) {
        const read = rsiRead(rsi);
        dl.append(el('div', { class: 'stat' }, el('dt', { text: 'RSI (14)' }),
          el('dd', { class: 'tabular' }, fmt(rsi, 1), ' ', el('span', { class: 'rsi-read' + (read === 'Neutral' ? '' : ' hot'), text: read }))));
      }
      out.push(dl);
    }
    const lo = num(t.low52), hi = num(t.high52), p = num(t.price);
    if (lo !== null && hi !== null && hi > lo) {
      const marker = el('span', { class: 'range-marker' });
      if (p !== null) marker.style.left = (Math.min(1, Math.max(0, (p - lo) / (hi - lo))) * 100).toFixed(1) + '%';
      else marker.hidden = true;
      const pctTxt = p !== null ? `52-week range, current ${fmtFor(t, p)}` : '52-week range';
      out.push(el('div', null,
        el('div', { class: 'range-label', text: '52-week range' }),
        el('div', { class: 'range-bar', role: 'img', 'aria-label': `${pctTxt}, low ${fmtFor(t, lo)}, high ${fmtFor(t, hi)}` }, marker),
        el('div', { class: 'range-ends tabular' }, el('span', { text: fmtFor(t, lo) }), el('span', { text: fmtFor(t, hi) }))));
    }
    if (str(t.note) && !isFearGreed(t)) out.push(el('p', { class: 'note', text: str(t.note) }));
    if (!out.length) out.push(el('p', { class: 'faint', text: 'No more detail for this one.' }));
    return out;
  }

  function marquee(tickers) {
    const wrap = el('div', { class: 'marquee', role: 'region', 'aria-label': 'Market ticker' });
    const track = el('div', { class: 'marquee-track' });
    const copy = (hidden) => {
      const ul = el('ul', { class: 'marquee-copy', 'aria-hidden': hidden ? 'true' : null });
      for (const t of tickers) {
        ul.append(el('li', { class: 'marquee-item' },
          el('span', { class: 'sym', text: displaySymbol(t) }),
          priceNode(t),
          isFearGreed(t) ? fgChip(t) : changeChip(t)));
      }
      return ul;
    };
    track.append(copy(false), copy(true));
    track.style.setProperty('--marquee-duration', Math.max(30, tickers.length * 4) + 's');
    // Pause while a finger is down (hover covers mouse).
    let resume = null;
    const pause = () => { clearTimeout(resume); wrap.classList.add('paused'); };
    const unpause = () => { clearTimeout(resume); resume = setTimeout(() => wrap.classList.remove('paused'), 1500); };
    wrap.addEventListener('pointerdown', pause);
    wrap.addEventListener('pointerup', unpause);
    wrap.addEventListener('pointercancel', unpause);
    wrap.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') unpause(); });
    wrap.append(track);
    return wrap;
  }

  function renderMarkets() {
    const body = document.getElementById('markets-body');
    const tickers = arr(state.feed && state.feed.ticker).map(obj).filter((t) => t && str(t.symbol));
    if (!tickers.length) { body.replaceChildren(el('p', { class: 'empty', text: state.feed ? 'No market data.' : 'Loading…' })); return; }

    const groups = new Map();
    for (const t of tickers) {
      const g = str(t.group) || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const groupsId = 'market-groups';
    const container = el('div', { class: 'market-groups' + (WIDE.matches && !state.marketsOpen ? ' collapsed' : ''), id: groupsId });
    for (const [name, list] of groups) {
      const ul = el('ul', { class: 'list' });
      for (const t of list) {
        const right = el('span', { class: 'row-right' }, priceNode(t), isFearGreed(t) ? fgChip(t) : changeChip(t));
        const header = [
          el('span', { class: 'exp-main' },
            el('span', { class: 'row-sym', text: displaySymbol(t) }),
            caption(t) ? el('span', { class: 'row-name', text: caption(t) }) : null),
          right,
        ];
        ul.append(el('li', null, expander('mkt:' + str(t.symbol), { header, detail: () => tickerDetail(t) })));
      }
      container.append(el('section', { class: 'group', 'aria-label': name }, el('h3', { class: 'group-title', text: name }), ul));
    }

    const toggle = el('button', { type: 'button', class: 'markets-toggle', 'aria-expanded': String(state.marketsOpen), 'aria-controls': groupsId },
      el('span', { text: state.marketsOpen ? 'Hide market details' : 'All markets' }), svg(UI.chevron));
    toggle.addEventListener('click', () => {
      state.marketsOpen = !state.marketsOpen;
      toggle.setAttribute('aria-expanded', String(state.marketsOpen));
      toggle.firstChild.textContent = state.marketsOpen ? 'Hide market details' : 'All markets';
      container.classList.toggle('collapsed', !state.marketsOpen);
    });

    body.replaceChildren(marquee(tickers), WIDE.matches ? toggle : '', container);
  }

  /* ---------- Weather ---------- */
  function isSevere(a) {
    if (a.emergency === true) return true;
    const s = (str(a.severity) + ' ' + str(a.title)).toLowerCase();
    return ['warning', 'severe', 'extreme', 'emergency'].some((k) => s.includes(k));
  }

  function nwsBlocks(raw) {
    return str(raw).replace(/\r\n/g, '\n').split(/\n[ \t]*\n/)
      .map((p) => p.split('\n').map((s) => s.trim()).join(' ').trim())
      .filter(Boolean)
      .map((text) => {
        if (text.startsWith('*')) {
          const rest = text.replace(/^[*\s]+/, '');
          const i = rest.indexOf('...');
          if (i > 0 && i <= 40) return { label: rest.slice(0, i).trim().toUpperCase(), text: rest.slice(i + 3).trim() };
          return { label: null, text: rest };
        }
        if (text.startsWith('...')) return { label: null, text: text.replace(/^\.+|\.+$/g, '').trim(), headline: true };
        return { label: null, text };
      });
  }

  function alertDetail(a) {
    const out = [];
    const starts = parseDate(a.starts), ends = parseDate(a.ends);
    const kv = el('div', { class: 'kv small' });
    if (starts || ends) kv.append(el('span', null, el('b', { text: 'When ' }), [starts ? dateTimeText(starts) : '', ends ? ` – ${dateTimeText(ends)}` : ''].join('')));
    if (str(a.source)) kv.append(el('span', null, el('b', { text: 'From ' }), str(a.source)));
    if (kv.childNodes.length) out.push(kv);
    const areas = arr(a.areas).map(str).filter(Boolean);
    if (areas.length) out.push(el('p', { class: 'small muted' }, el('b', { text: 'Where ' }), areas.join(', ')));
    if (str(a.event)) out.push(el('p', { class: 'small' }, el('b', { text: 'Storm ' }), str(a.event)));
    if (str(a.background)) out.push(el('p', { class: 'alert-bg', text: str(a.background) }));
    for (const b of nwsBlocks(a.body)) {
      out.push(el('div', { class: 'nws-block' + (b.headline ? ' headline' : '') },
        b.label ? el('span', { class: 'lbl', text: b.label }) : null, b.text));
    }
    if (!out.length) out.push(el('p', { class: 'faint', text: 'No details from the weather service.' }));
    return out;
  }

  function dayLabel(d, i) {
    if (!d) return i === 0 ? 'Today' : '';
    const now = new Date();
    if (sameDay(d, now)) return 'Today';
    return d.toLocaleDateString([], { weekday: 'short' });
  }

  function renderWeather() {
    const body = document.getElementById('weather-body');
    const w = obj(state.feed && state.feed.weather);
    if (!w) { body.replaceChildren(el('p', { class: 'empty', text: state.feed ? 'No weather data.' : 'Loading…' })); return; }
    const kids = [];
    const daily = arr(w.daily).map(obj).filter(Boolean);
    const d0 = daily[0] || {};
    const hi = num(w.high) !== null ? w.high : d0.high;
    const lo = num(w.low) !== null ? w.low : d0.low;

    const facts = el('div', { class: 'facts' });
    if (num(hi) !== null || num(lo) !== null) facts.append(el('span', null, 'H ', el('b', { text: deg(hi) }), '  L ', el('b', { text: deg(lo) })));
    if (num(w.humidity) !== null) facts.append(el('span', null, 'Humidity ', el('b', { text: `${Math.round(num(w.humidity))}%` })));
    if (num(w.wind) !== null) facts.append(el('span', null, 'Wind ', el('b', { text: `${Math.round(num(w.wind))} mph` })));
    kids.push(el('div', { class: 'card wx-now' },
      str(w.location) ? el('div', { class: 'loc', text: str(w.location) }) : null,
      el('div', { class: 'temp', text: deg(w.temp) }),
      wxIcon(str(w.condition), str(w.conditionText), 'lg'),
      str(w.conditionText) ? el('div', { class: 'cond', text: str(w.conditionText) }) : null,
      facts.childNodes.length ? facts : null,
      str(w.summary) ? el('p', { class: 'summary', text: str(w.summary) }) : null));

    const alerts = arr(w.alerts).map(obj).filter(Boolean);
    if (alerts.length) {
      kids.push(el('h3', { class: 'section-label', text: alerts.length > 1 ? 'Alerts' : 'Alert' }));
      const list = el('div', { class: 'list' });
      alerts.forEach((a, i) => {
        list.append(expander('alert:' + i, {
          className: 'alert' + (isSevere(a) ? ' severe' : ''),
          header: [el('span', { class: 'exp-main' },
            str(a.severity) ? el('span', { class: 'sev', text: str(a.severity) }) : null,
            el('div', { class: 'alert-title', text: str(a.title) || 'Weather alert' }),
            str(a.detail) ? el('div', { class: 'alert-detail', text: str(a.detail) }) : null)],
          detail: () => alertDetail(a),
        }));
      });
      kids.push(list);
    }

    const hourly = arr(w.hourly).map(obj).filter(Boolean).slice(0, 24);
    if (hourly.length) {
      kids.push(el('h3', { class: 'section-label', text: 'Next 24 hours' }));
      const ul = el('ul', { class: 'hourly', 'aria-label': 'Hourly forecast', tabindex: '0' });
      const now = Date.now();
      hourly.forEach((h, i) => {
        const t = parseDate(h.time);
        const isNow = i === 0 && t && now - t.getTime() < 3600e3 && now >= t.getTime() - 60e3;
        const label = isNow ? 'Now' : t ? t.toLocaleTimeString([], { hour: 'numeric' }) : '';
        const pp = num(h.precipPct);
        ul.append(el('li', { class: 'hour' },
          el('span', { class: 'h', text: label }),
          wxIcon(str(h.condition), str(h.conditionText)),
          el('span', { class: 'temp', text: deg(h.temp) }),
          pp !== null && pp > 0 ? el('span', { class: 'pp', text: `${Math.round(pp)}%` }, el('span', { class: 'visually-hidden', text: ' chance of precipitation' }))
            : el('span', { class: 'pp-none', 'aria-hidden': 'true', text: '0%' })));
      });
      kids.push(ul);
    }

    if (daily.length) {
      kids.push(el('h3', { class: 'section-label', text: `${daily.length}-day forecast` }));
      const list = el('div', { class: 'list' });
      daily.forEach((d, i) => {
        const date = parseDate(d.date);
        const pp = num(d.precipPct);
        const night = obj(d.night);
        list.append(expander('day:' + (str(d.date) || i), {
          header: [
            el('span', { class: 'day-label', text: dayLabel(date, i) }),
            wxIcon(str(d.condition), ''),
            el('span', { class: 'day-cond' }, str(d.conditionText), pp !== null && pp > 0 ? el('span', { class: 'pp', text: ` ${Math.round(pp)}%` }) : null),
            el('span', { class: 'day-temps tabular' }, el('b', { text: deg(d.high) }), el('span', { class: 'lo', text: deg(d.low !== undefined ? d.low : night && night.low) })),
          ],
          detail: () => {
            const out = [];
            if (str(d.summary)) out.push(el('p', { text: str(d.summary) }));
            const kv = el('div', { class: 'kv small' });
            if (str(d.windText)) kv.append(el('span', null, 'Wind ', el('b', { text: str(d.windText) })));
            if (pp !== null) kv.append(el('span', null, 'Precip ', el('b', { text: `${Math.round(pp)}%` })));
            if (kv.childNodes.length) out.push(kv);
            if (night) {
              const npp = num(night.precipPct);
              out.push(el('div', { class: 'night' },
                wxIcon(str(night.condition) || 'clearNight', ''),
                el('div', null,
                  el('div', { class: 'n-title' }, 'Night', str(night.conditionText) ? ` · ${str(night.conditionText)}` : ''),
                  el('div', { class: 'muted small tabular' }, num(night.low) !== null ? `Low ${deg(night.low)}` : '', npp !== null && npp > 0 ? `  ·  Precip ${Math.round(npp)}%` : '')),
                str(night.summary) ? el('p', { class: 'n-summary', text: str(night.summary) }) : null));
            }
            if (!out.length) out.push(el('p', { class: 'faint', text: 'No more detail.' }));
            return out;
          },
        }));
      });
      kids.push(list);
    }
    body.replaceChildren(...kids);
  }

  /* ---------- News ---------- */
  function safeUrl(u) {
    try {
      const url = new URL(str(u));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch (_) { return null; }
  }

  function renderNews() {
    const body = document.getElementById('news-body');
    const items = arr(state.feed && state.feed.news).map(obj).filter((n) => n && str(n.title));
    if (!items.length) { body.replaceChildren(el('p', { class: 'empty', text: state.feed ? 'No stories right now.' : 'Loading…' })); return; }
    const list = el('div', { class: 'list' });
    items.forEach((n) => {
      const when = parseDate(n.publishedAt);
      const metaBase = [str(n.source), str(n.topic)].filter(Boolean).join(' · ');
      const meta = [metaBase, when ? relTime(when) : ''].filter(Boolean).join(' · ');
      list.append(expander('news:' + str(n.title), {
        header: [el('span', { class: 'exp-main' },
          el('span', { class: 'news-title', text: str(n.title) }),
          meta ? el('span', { class: 'news-meta', text: meta, 'data-base': metaBase, 'data-when': when ? when.toISOString() : null }) : null)],
        detail: () => {
          const out = [];
          const text = str(n.body) || str(n.summary);
          if (text) out.push(el('p', { class: 'news-body', text }));
          const rooms = num(n.newsrooms);
          if (rooms !== null && rooms > 0) out.push(el('p', { class: 'newsrooms', text: `Reported by ${fmt(rooms, 0)} newsroom${rooms === 1 ? '' : 's'}` }));
          const links = arr(n.sources).map(safeUrl).filter(Boolean);
          if (links.length) {
            out.push(el('div', { class: 'links' }, links.map((u) => el('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer' }, u.hostname.replace(/^www\./, ''), el('span', { class: 'visually-hidden', text: ' (opens in new tab)' })))));
          }
          if (!out.length) out.push(el('p', { class: 'faint', text: 'No more detail.' }));
          return out;
        },
      }));
    });
    body.replaceChildren(list);
  }

  function refreshRelativeTimes() {
    for (const m of document.querySelectorAll('[data-when]')) {
      const d = parseDate(m.getAttribute('data-when'));
      if (d) m.textContent = [m.getAttribute('data-base'), relTime(d)].filter(Boolean).join(' · ');
    }
  }

  /* ---------- Status ---------- */
  function renderStatus() {
    const status = document.getElementById('status');
    const header = document.getElementById('header-date');
    const now = new Date();
    header.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      + (KIOSK ? ' · ' + now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
    const kids = [];
    const updated = parseDate(state.feed && state.feed.updatedAt);
    if (updated) {
      kids.push(`Updated ${dateTimeText(updated)}`);
      if (Date.now() - updated.getTime() > STALE_MS) {
        kids.push(el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'stale', text: 'stale' }));
      }
    } else if (!state.feed && !state.loading) {
      kids.push('Couldn’t load data. Check your connection and tap refresh.');
    }
    if (state.lastError && state.feed) kids.push(' · Couldn’t refresh, showing the saved copy');
    status.replaceChildren(...kids);
  }

  function renderAll() {
    renderToday();
    renderMarkets();
    renderWeather();
    renderNews();
    renderStatus();
  }

  /* ---------- Loading ---------- */
  async function getJSON(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById('refresh');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    const [feed, priv, friends] = await Promise.allSettled([getJSON(FEED_URL), getJSON(PRIVATE_URL), getJSON(FRIENDS_URL)]);
    if (feed.status === 'fulfilled' && obj(feed.value)) { state.feed = feed.value; state.lastError = null; }
    else state.lastError = feed.reason || new Error('bad feed');
    // A failed fetch keeps the previous blob (and whatever it decrypted to).
    if (priv.status === 'fulfilled' && obj(priv.value)) {
      state.priv = priv.value;
      try { await autoUnlockPersonal(); } catch (_) { state.personal = null; }
    }
    if (friends.status === 'fulfilled' && obj(friends.value)) {
      state.friends = friends.value;
      try { await unlockFriends(); } catch (_) { state.friendsMedia = null; }
    }
    state.loading = false;
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    renderAll();
  }

  // The refresh button reloads everything: fresh app files (drops the cached
  // shell, checks for a new service worker) and fresh data. Saved keys stay.
  async function reloadEverything() {
    const btn = document.getElementById('refresh');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== 'hearth-data').map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch (_) { /* reload anyway */ }
    location.reload();
  }

  function init() {
    takeFriendsSecretFromUrl(); // before initTabs reads the hash
    initTabs();
    window.addEventListener('hashchange', () => {
      if (!takeFriendsSecretFromUrl()) return;
      if (state.friends && !state.loading) unlockFriends().then(renderToday);
      else load();
    });
    renderAll();
    document.getElementById('refresh').addEventListener('click', reloadEverything);
    load();
    // Keep relative times and the stale marker honest; refetch when returning to the app.
    setInterval(() => { renderStatus(); refreshRelativeTimes(); }, KIOSK ? 15e3 : 60e3);
    // Open and visible (a desktop tab, the wall screen): refetch every 15 minutes.
    setInterval(() => { if (!document.hidden) load(); }, 15 * 60e3);
    if (KIOSK) {
      // Reload the whole page around 4 AM so the wall screen picks up app updates.
      const at4 = new Date(); at4.setHours(28, 0, 0, 0);
      setTimeout(() => location.reload(), at4 - Date.now());
    }
    let hiddenAt = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (Date.now() - hiddenAt > 5 * 60e3) load();
    });
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
