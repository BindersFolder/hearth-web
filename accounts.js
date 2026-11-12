/* Hearth accounts: sign-in, welcome steps, settings and per-user data, backed by
   Supabase through plain fetch (no library). Loaded before app.js, which calls
   window.HearthAccounts. Not used at all in kiosk mode.

   Privacy rules kept here (the database enforces separation; this must not undo it):
   - Per-user data lives in memory only. Nothing here touches the Cache API, and the
     service worker ignores other origins, so Supabase responses are never cached.
   - On sign-out or user switch, memory is wiped BEFORE anything re-renders, and late
     responses for the previous user are dropped (see `epoch`).
   - Everything is rendered with el()/textContent; links are fixed https constants. */
'use strict';
(() => {
  const SUPABASE_URL = 'https://osrjculjbhhwntehigvr.supabase.co';
  // Publishable key: public by design. Row-level security decides what it can reach.
  const SUPABASE_KEY = 'sb_publishable_Zbi_PYchYGTO6Z55ZATZ8g_vuD0XlcE';
  // Package-email inbox: <local>+<token>@<domain>. Empty = feature not switched on yet.
  const HEARTH_INBOX_LOCAL = 'hearthproject05';
  const HEARTH_INBOX_DOMAIN = 'gmail.com';

  const SESSION_STORE = 'hearth.session.v1';
  const MIN_PASS = 10;
  const DAY = 864e5;
  // Named columns on purpose: the database refuses select=* on connections.
  const CONN_COLS = 'id,user_id,kind,provider,label,forward_token,status,status_note,last_ok,created_at';
  const DOC_NAMES = ['highlights', 'packages', 'media', 'alerts'];
  const MUSIC = [
    ['apple', 'Apple Music / Apple Podcasts', 'https://music.apple.com'],
    ['spotify', 'Spotify', 'https://open.spotify.com'],
    ['youtube_music', 'YouTube Music', 'https://music.youtube.com'],
    ['amazon_music', 'Amazon Music', 'https://music.amazon.com'],
    ['pandora', 'Pandora', 'https://www.pandora.com'],
    ['tidal', 'Tidal', 'https://listen.tidal.com'],
    ['deezer', 'Deezer', 'https://www.deezer.com'],
    ['iheartradio', 'iHeartRadio', 'https://www.iheart.com'],
    ['siriusxm', 'SiriusXM', 'https://www.siriusxm.com/player'],
    ['audible', 'Audible', 'https://www.audible.com/library/titles'],
  ];
  // A richer panel for one service can be registered here later (Spotify is planned):
  // MUSIC_PANELS.spotify = (service) => Node. Anything not listed gets the launcher.
  const MUSIC_PANELS = {};
  const STEPS = ['Your calendar', 'Your packages', 'Your music', 'All set'];
  const inboxOn = () => !!(HEARTH_INBOX_LOCAL && HEARTH_INBOX_DOMAIN);

  let hooks = null;        // { el, uid, personalFrom, onChange } from app.js
  let el = null;
  let uid = null;
  let session = null;      // { access_token, refresh_token, expires_at, user: { id, email } }
  let epoch = 0;           // bumps on every sign-in / sign-out / user switch
  let user = blankUser();  // everything known about the signed-in person (memory only)
  let ui = blankUi();
  let refreshing = null;
  let refreshTimer = null;
  let pending = false;     // a data render was held back while someone was typing
  const kept = new Map();  // built cards, reused while their inputs are unchanged

  function blankUser() {
    return { loaded: false, verified: false, error: '', profile: null, settings: null, connections: [], events: [], packages: [], docs: {}, personal: null, inflight: null };
  }
  function blankUi() {
    return { authMode: 'signin', authOpen: false, email: '', notice: '', step: 0, done: [false, false, false], stepNote: '', settingsOpen: false, addCalOpen: false, accountNote: '', resumed: false };
  }
  function wipeMemory() {
    user = blankUser();
    ui = blankUi();
    kept.clear();
    pending = false;
  }

  /* ---------- Session ---------- */
  const nowSec = () => Math.floor(Date.now() / 1000);
  function validSession(s) {
    return !!(s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string' && Number.isFinite(s.expires_at)
      && s.user && typeof s.user.id === 'string' && /^[0-9a-f-]{36}$/i.test(s.user.id));
  }
  function readSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_STORE) || 'null');
      return validSession(s) ? s : null;
    } catch (_) { return null; }
  }
  function storeSession() {
    try {
      if (session) localStorage.setItem(SESSION_STORE, JSON.stringify(session));
      else localStorage.removeItem(SESSION_STORE);
    } catch (_) { /* memory only */ }
  }
  function sessionFrom(d) {
    if (!d || !d.user) return null;
    const s = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Number.isFinite(d.expires_at) ? d.expires_at : nowSec() + (Number(d.expires_in) || 3600),
      user: { id: d.user.id, email: typeof d.user.email === 'string' ? d.user.email : '' },
    };
    return validSession(s) ? s : null;
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session) return;
    const ms = Math.max(5, session.expires_at - nowSec() - 300) * 1000;
    refreshTimer = setTimeout(() => { refresh().catch(() => { /* retried on the next request */ }); }, ms);
  }
  function startSession(s) {
    epoch++;
    wipeMemory();
    session = s;
    storeSession();
    scheduleRefresh();
    changed('user');
    return loadUser().then(() => {
      const h = needsWelcome() ? document.querySelector('.acct-welcome h3') : null;
      if (h) { h.focus({ preventScroll: true }); h.scrollIntoView({ block: 'center' }); }
    });
  }
  // Clears the session and every per-user value, then re-renders. No network.
  function signOutLocal(notice) {
    clearTimeout(refreshTimer);
    epoch++;
    session = null;
    storeSession();
    wipeMemory();
    ui.notice = notice || '';
    changed('user');
  }
  function signOut() {
    const token = session && session.access_token;
    signOutLocal('');
    if (token) http('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => { /* already cleared here */ });
  }

  /* ---------- HTTP ---------- */
  function apiError(status, data) {
    const d = data && typeof data === 'object' ? data : {};
    const e = new Error(String(d.msg || d.message || d.error_description || d.error || `HTTP ${status}`));
    e.status = status;
    e.code = String(d.error_code || d.code || '');
    return e;
  }
  async function http(path, opts) {
    const o = opts || {};
    const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + (o.token || SUPABASE_KEY) };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.prefer) headers.Prefer = o.prefer;
    let res;
    try {
      res = await fetch(SUPABASE_URL + path, {
        method: o.method || 'GET', headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      });
    } catch (_) { throw apiError(0, { msg: 'offline' }); }
    let data = null;
    try { const text = await res.text(); data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) throw apiError(res.status, data);
    return data;
  }
  function refresh() {
    if (refreshing) return refreshing;
    if (!session) return Promise.reject(apiError(401, { msg: 'signed out' }));
    const mine = epoch;
    refreshing = (async () => {
      // Another tab may already have swapped the refresh token: use its result.
      const stored = readSession();
      if (stored && stored.user.id === session.user.id && stored.refresh_token !== session.refresh_token && stored.expires_at - nowSec() > 60) {
        session = stored;
        scheduleRefresh();
        return session.access_token;
      }
      try {
        const s = sessionFrom(await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } }));
        if (mine !== epoch) throw apiError(401, { msg: 'signed out' });
        if (!s || s.user.id !== session.user.id) throw apiError(401, { msg: 'bad session' });
        session = s;
        storeSession();
        scheduleRefresh();
        return session.access_token;
      } catch (e) {
        // Refused (not just offline or rate-limited): the session is over. Sign out cleanly.
        if (mine === epoch && [400, 401, 403].includes(e.status)) signOutLocal('Your sign-in ended. Please sign in again.');
        throw e;
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function authed(path, opts) {
    if (!session) throw apiError(401, { msg: 'signed out' });
    const mine = epoch;
    let token = session.expires_at - nowSec() < 60 ? await refresh() : session.access_token;
    try { return await http(path, Object.assign({}, opts, { token })); }
    catch (e) {
      // An expired or rejected token: 401 from the data API, 403 from the auth API.
      const stale = e.status === 401 || (e.status === 403 && path.startsWith('/auth/'));
      if (!stale || mine !== epoch) throw e;
      token = await refresh();
      return http(path, Object.assign({}, opts, { token }));
    }
  }

  /* ---------- Per-user data ---------- */
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  function loadUser() {
    if (!session) return Promise.resolve();
    if (user.inflight) return user.inflight;
    const holder = user;
    const p = runLoad().finally(() => { if (holder.inflight === p) holder.inflight = null; });
    user.inflight = p;
    return p;
  }
  // After a change: wait for any load already running, then load again.
  const reload = () => (user.inflight ? user.inflight.then(loadUser) : loadUser());

  async function runLoad() {
    const mine = epoch;
    const id = session.user.id;
    const own = (rows, key) => (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && r[key || 'user_id'] === id);
    const t0 = startOfToday().getTime();
    const from = encodeURIComponent(new Date(t0 - DAY).toISOString());
    const to = encodeURIComponent(new Date(t0 + 9 * DAY).toISOString());
    try {
      if (!user.verified) {
        const u = await authed('/auth/v1/user');
        if (mine !== epoch) return;
        if (!u || u.id !== id) { signOutLocal('Please sign in again.'); return; }
        user.verified = true;
        if (typeof u.email === 'string' && u.email && u.email !== session.user.email) { session.user.email = u.email; storeSession(); }
      }
      const [profiles, settings, connections, events, packages, docs] = await Promise.all([
        authed(`/rest/v1/profiles?select=id,display_name,onboarding_done&id=eq.${id}`),
        authed(`/rest/v1/settings?select=user_id,music_service&user_id=eq.${id}`),
        authed(`/rest/v1/connections?select=${CONN_COLS}&user_id=eq.${id}&order=created_at`),
        authed(`/rest/v1/events?select=user_id,connection_id,uid,title,starts_at,ends_at,all_day,location&user_id=eq.${id}&starts_at=gte.${from}&starts_at=lt.${to}&order=starts_at&limit=200`),
        authed(`/rest/v1/packages?select=id,user_id,title,carrier,tracking,status,eta,delivered,updated_at&user_id=eq.${id}&delivered=is.false&order=eta.asc.nullslast&limit=100`),
        authed(`/rest/v1/user_docs?select=user_id,name,doc&user_id=eq.${id}&name=in.(${DOC_NAMES.join(',')})`),
      ]);
      if (mine !== epoch) return;   // signed out or switched while loading: drop it
      user.profile = own(profiles, 'id')[0] || null;
      user.settings = own(settings)[0] || null;
      user.connections = own(connections);
      user.events = own(events);
      user.packages = own(packages).filter((p) => p.delivered === false);
      user.docs = {};
      for (const row of own(docs)) if (DOC_NAMES.includes(row.name)) user.docs[row.name] = row.doc;
      user.loaded = true;
      user.error = '';
      resumeWelcome();
    } catch (e) {
      if (mine !== epoch || !session) return;
      user.error = e.status === 0 ? 'offline' : 'error';
    }
    user.personal = null;
    changed('data');
  }

  // Same shape as the legacy private tier (personalFrom in app.js), built only from
  // this user's rows: owner docs first, then calendar events and package rows.
  function personal() {
    if (!session || !user.loaded) return null;
    if (user.personal) return user.personal;
    const d = user.docs;
    const base = hooks.personalFrom({ highlights: Array.isArray(d.highlights) ? d.highlights : [], media: httpsMedia(d.media), packages: d.packages, alerts: d.alerts });
    const docPk = base.packages;
    user.personal = {
      highlights: base.highlights.concat(eventHighlights()),
      media: base.media,
      packages: { items: (docPk && Array.isArray(docPk.items) ? docPk.items : []).concat(user.packages.map(packageItem)), mail: docPk ? docPk.mail : null },
      alerts: base.alerts,
    };
    return user.personal;
  }
  function httpsMedia(media) {
    if (!media || typeof media !== 'object' || Array.isArray(media)) return null;
    const ok = (ep) => { try { return new URL(String(ep && ep.url)).protocol === 'https:'; } catch (_) { return false; } };
    const out = {};
    for (const [k, v] of Object.entries(media)) out[k] = Array.isArray(v) ? v.filter(ok) : ok(v) ? v : null;
    return out;
  }
  function dayWord(d) {
    const t0 = startOfToday();
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / DAY);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function eventHighlights() {
    const t0 = startOfToday();
    const end = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 8);
    const out = [];
    for (const ev of user.events) {
      const at = new Date(ev.starts_at);
      if (Number.isNaN(at.getTime())) continue;
      // All-day events are a calendar date (kept as UTC midnight), not a moment in time.
      const when = ev.all_day === true ? new Date(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) : at;
      if (when < t0 || when >= end) continue;
      const time = ev.all_day === true ? 'All day' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const place = typeof ev.location === 'string' ? ev.location.trim() : '';
      out.push({ t: when.getTime(), kind: 'event', title: (typeof ev.title === 'string' && ev.title.trim()) || 'Busy', detail: [dayWord(when), time, place].filter(Boolean).join(' · ') });
    }
    out.sort((a, b) => a.t - b.t);
    return out.map(({ kind, title, detail }) => ({ kind, title, detail }));
  }
  function packageItem(p) {
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const status = text(p.status);
    const out = text(status).toLowerCase() === 'out' || /out for delivery/i.test(status);
    return {
      title: text(p.title) || (text(p.carrier) ? `${text(p.carrier)} package` : 'Package'),
      status: out ? 'out' : '',
      eta: text(p.eta),
      etaText: out ? '' : status,
    };
  }
  const calendars = () => user.connections.filter((c) => c.kind === 'calendar_ics');
  function forwardToken() {
    const c = user.connections.find((x) => x.kind === 'mail_forward');
    return c && typeof c.forward_token === 'string' && /^[a-f0-9]{8,64}$/.test(c.forward_token) ? c.forward_token : '';
  }
  // Only two kinds of note are ever shown: a Gmail code (digits) or nothing.
  function forwardStatus() {
    const c = user.connections.find((x) => x.kind === 'mail_forward');
    if (!c) return '';
    if (c.status === 'ok') return 'Working: Hearth has received your forwarded emails.';
    const code = /^Gmail confirmation code: (\d{6,12})$/.exec(typeof c.status_note === 'string' ? c.status_note : '');
    return code ? `Gmail confirmation code: ${code[1]}` : 'Waiting for your first forwarded email.';
  }
  const musicKey = () => {
    const k = user.settings && user.settings.music_service;
    return MUSIC.some((m) => m[0] === k) ? k : '';
  };
  const needsWelcome = () => !!(session && user.loaded && user.profile && user.profile.onboarding_done === false);

  /* ---------- Rendering plumbing ---------- */
  function editing() {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('.acct-card') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'radio' && a.type !== 'checkbox');
  }
  // why: 'user' (sign-in/out: always render at once), 'ui', or 'data' (held while typing).
  function changed(why, focusSel) {
    if (!hooks) return;
    if (why === 'data' && editing()) { pending = true; return; }
    pending = false;
    const active = document.activeElement;
    hooks.onChange(why);
    const target = focusSel ? document.querySelector(focusSel) : null;
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
    else if (active && active !== document.body && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }
  function keep(name, sig, build) {
    const k = kept.get(name);
    const s = JSON.stringify(sig);
    if (k && k.sig === s) return k.node;
    const node = build();
    kept.set(name, { sig: s, node });
    return node;
  }
  function field(label, control) {
    if (!control.id) control.id = uid('acct');
    return el('label', { class: 'field', for: control.id }, label, control);
  }
  function textBtn(text, onClick, cls) {
    const b = el('button', { type: 'button', class: 'btn-text' + (cls ? ' ' + cls : ''), text });
    b.addEventListener('click', onClick);
    return b;
  }
  function mainBtn(text, onClick) {
    const b = el('button', { type: 'button', class: 'btn', text });
    b.addEventListener('click', onClick);
    return b;
  }
  const errorLine = () => el('p', { class: 'form-error', role: 'alert' });
  const steps = (items) => el('ol', { class: 'acct-steps' }, items.map((t) => el('li', { text: t })));
  function invalid(input, err, msg) {
    err.textContent = msg;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  function passToggle(inputs) {
    const b = el('button', { type: 'button', class: 'btn-text acct-toggle', 'aria-pressed': 'false', text: 'Show passphrase' });
    b.addEventListener('click', () => {
      const show = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(show));
      b.textContent = show ? 'Hide passphrase' : 'Show passphrase';
      for (const i of inputs) i.type = show ? 'text' : 'password';
    });
    return b;
  }
  const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
  function plainError(e) {
    if (e.status === 0) return 'Couldn’t reach Hearth. Check your connection and try again.';
    if (e.status === 429) return 'Too many tries. Wait a minute, then try again.';
    return 'Something went wrong. Please try again.';
  }

  /* ---------- Sign in / create account / forgot ---------- */
  function setAuthMode(mode, email) {
    ui.authMode = mode;
    ui.notice = '';
    if (typeof email === 'string') ui.email = email.trim().slice(0, 254);
    changed('ui', '.acct-auth h3');
  }
  function authCard(opts) {
    const mode = ui.authMode;
    const card = el('div', { class: 'card lock-card acct-card acct-auth' });
    const err = errorLine();
    const email = el('input', { type: 'email', name: 'email', autocomplete: mode === 'signup' ? 'email' : 'username', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: true, value: ui.email });
    const notice = ui.notice ? el('p', { class: 'acct-note', role: 'status', text: ui.notice }) : null;
    const submit = el('button', { type: 'submit', class: 'btn' });
    const form = el('form', { novalidate: true });
    const run = (label, busyLabel, work) => {
      submit.textContent = label;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
        const mail = email.value.trim();
        if (!validEmail(mail)) { invalid(email, err, 'Enter your email address.'); return; }
        submit.disabled = true; submit.textContent = busyLabel;
        try { await work(mail); }
        catch (e2) { err.textContent = e2.friendly || plainError(e2); }
        if (submit.isConnected) { submit.disabled = false; submit.textContent = label; }
      });
    };
    const friendly = (msg) => { const e = new Error(msg); e.friendly = msg; return e; };

    if (mode === 'signup') {
      const name = el('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: '60', required: true });
      const pass = el('input', { type: 'password', name: 'new-password', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false', required: true, minlength: String(MIN_PASS) });
      const again = el('input', { type: 'password', name: 'confirm-password', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false', required: true });
      card.append(el('h3', { tabindex: '-1', text: 'Create your account' }),
        el('p', { class: 'muted small', text: 'Hearth is invite-only. Use the email address Jeszie added for you.' }));
      form.append(field('Your name', name), field('Email', email),
        field(`Passphrase (at least ${MIN_PASS} characters)`, pass), field('Passphrase again', again),
        passToggle([pass, again]), err, submit);
      run('Create account', 'Creating…', async (mail) => {
        const display = name.value.trim();
        if (!display) { invalid(name, err, 'Enter your name.'); return; }
        if (pass.value.length < MIN_PASS) { invalid(pass, err, `Use at least ${MIN_PASS} characters for your passphrase.`); return; }
        if (pass.value !== again.value) { invalid(again, err, 'The two passphrases don’t match.'); return; }
        let d;
        try { d = await http('/auth/v1/signup', { method: 'POST', body: { email: mail, password: pass.value, data: { display_name: display } } }); }
        catch (e) {
          if (/not been invited/i.test(e.message)) throw friendly('This email isn’t on Hearth’s guest list yet. Ask Jeszie to add it, then try again.');
          if (/already (registered|exists)/i.test(e.message) || /user_already_exists|email_exists/.test(e.code)) throw friendly('That email already has an account. Sign in instead.');
          if (/weak_password/.test(e.code)) throw friendly(`Pick a longer passphrase (at least ${MIN_PASS} characters).`);
          throw e;
        }
        pass.value = ''; again.value = '';
        const s = sessionFrom(d);
        if (s) { await startSession(s); return; }
        // Email confirmation is on: no session until they tap the link.
        ui.authMode = 'signin'; ui.email = mail; ui.notice = 'Check your email and tap the link, then sign in here.';
        changed('ui', '.acct-auth h3');
      });
      card.append(form, el('div', { class: 'acct-links' }, textBtn('Already have an account? Sign in', () => setAuthMode('signin', email.value))));
    } else if (mode === 'forgot') {
      // No reset emails for now (Hearth has no mail sender set up): the owner resets it by hand.
      card.append(el('h3', { tabindex: '-1', text: 'Forgot passphrase?' }),
        el('p', { class: 'muted small', text: 'Ask Jeszie to reset it for you. You\u2019ll get a new passphrase to sign in with.' }),
        el('div', { class: 'acct-links' }, textBtn('Back to sign in', () => setAuthMode('signin', email.value))));
    } else {
      const pass = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', autocapitalize: 'off', spellcheck: 'false', required: true });
      card.append(el('h3', { tabindex: '-1', text: 'Sign in' }),
        el('p', { class: 'muted small', text: 'Sign in to see your own calendar, packages and music.' }));
      form.append(...[notice, field('Email', email), field('Passphrase', pass), passToggle([pass]), err, submit].filter(Boolean));
      run('Sign in', 'Signing in…', async (mail) => {
        if (!pass.value) { invalid(pass, err, 'Enter your passphrase.'); return; }
        let d;
        try { d = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: mail, password: pass.value } }); }
        catch (e) {
          if (/email_not_confirmed/.test(e.code) || /not confirmed/i.test(e.message)) throw friendly('Check your email and tap the link first, then sign in here.');
          if (e.status === 400 || e.status === 401) { pass.select(); throw friendly('That email and passphrase didn’t match. Try again.'); }
          throw e;
        }
        pass.value = '';
        const s = sessionFrom(d);
        if (!s) throw apiError(500, null);
        await startSession(s);
      });
      card.append(form, el('div', { class: 'acct-links' },
        textBtn('New here? Create your account', () => setAuthMode('signup', email.value)),
        textBtn('Forgot passphrase?', () => setAuthMode('forgot', email.value), 'small')));
      // The older shared passphrase still works until switch-over; kept reachable but secondary.
      if (opts && opts.legacy) {
        const more = el('details', { class: 'acct-more' }, el('summary', { text: 'Have the household passphrase?' }), opts.legacy());
        more.open = !!opts.note;
        card.append(more);
      }
    }
    return card;
  }

  /* ---------- Shared pieces: calendar form, package emails, music ---------- */
  function calendarForm(onSaved) {
    const group = uid('provider');
    const google = el('input', { type: 'radio', name: group, value: 'google', checked: true });
    const icloud = el('input', { type: 'radio', name: group, value: 'icloud' });
    const how = {
      google: steps(['On a computer, open Google Calendar (calendar.google.com).', 'Click the gear at the top, then Settings.', 'On the left, under “Settings for my calendars”, click your calendar.', 'Scroll down to “Secret address in iCal format” and copy it.', 'Paste it below.']),
      icloud: steps(['Open the Calendar app on your iPhone or Mac.', 'Open the sharing options for the calendar you want (on iPhone: Calendars, then the “i” next to it).', 'Turn on “Public Calendar”.', 'Tap “Share Link” and copy the link.', 'Paste it below.']),
    };
    const warn = el('p', { class: 'acct-warn', text: 'Heads up: anyone who has an iCloud public link can see the event details on that calendar. Only share a calendar you’re comfortable with.' });
    const sync = () => {
      how.google.hidden = !google.checked;
      how.icloud.hidden = !icloud.checked;
      warn.hidden = !icloud.checked;
    };
    google.addEventListener('change', sync);
    icloud.addEventListener('change', sync);
    sync();
    const url = el('input', { type: 'url', name: 'calendar-link', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true, maxlength: '2000' });
    const label = el('input', { type: 'text', name: 'calendar-name', autocomplete: 'off', maxlength: '60' });
    const err = errorLine();
    const submit = el('button', { type: 'submit', class: 'btn', text: 'Save calendar' });
    const form = el('form', { novalidate: true },
      el('fieldset', { class: 'acct-choice' }, el('legend', { text: 'Which calendar do you use?' }),
        el('label', { class: 'check' }, google, 'Google Calendar'), el('label', { class: 'check' }, icloud, 'iCloud Calendar')),
      how.google, how.icloud, warn,
      field('Paste your calendar link', url), field('Name for this calendar (optional)', label),
      el('p', { class: 'muted small', text: 'Hearth only reads this link. Events appear within about 15 minutes.' }),
      err, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      url.removeAttribute('aria-invalid');
      const link = url.value.trim();
      if (!link) { invalid(url, err, 'Paste your calendar link first.'); return; }
      const provider = icloud.checked ? 'icloud' : 'google';
      submit.disabled = true; submit.textContent = 'Saving…';
      try {
        await authed('/rest/v1/rpc/add_calendar', { method: 'POST', body: { p_url: link, p_label: label.value.trim() || (provider === 'icloud' ? 'iCloud Calendar' : 'Google Calendar'), p_provider: provider } });
        url.value = ''; label.value = '';
        await reload();
        onSaved();
      } catch (e2) {
        // A refused link comes back with the database's own plain-language reason.
        if (e2.status === 400 && e2.message && !/^HTTP /.test(e2.message)) invalid(url, err, e2.message);
        else err.textContent = plainError(e2);
      }
      if (submit.isConnected) { submit.disabled = false; submit.textContent = 'Save calendar'; }
    });
    return form;
  }

  function packagesBlock(inSettings, onDone) {
    const wrap = el('div', { class: 'acct-block' });
    if (!inboxOn()) {
      wrap.append(el('p', { class: 'muted', text: inSettings ? 'Package emails aren’t switched on yet.' : 'Package emails aren’t switched on yet. You can turn this on later in Settings.' }));
      return wrap;
    }
    const token = forwardToken();
    if (!token) {
      const err = errorLine();
      const btn = mainBtn('Get my forwarding address', async () => {
        btn.disabled = true; err.textContent = '';
        try {
          await authed('/rest/v1/rpc/enable_mail_forward', { method: 'POST', body: {} });
          await reload();
          onDone();
        } catch (e) { btn.disabled = false; err.textContent = plainError(e); }
      });
      wrap.append(err, btn);
      return wrap;
    }
    const address = `${HEARTH_INBOX_LOCAL}+${token}@${HEARTH_INBOX_DOMAIN}`;
    const copied = el('span', { class: 'acct-note', role: 'status' });
    const copy = textBtn('Copy', async () => {
      try { await navigator.clipboard.writeText(address); copied.textContent = 'Copied.'; }
      catch (_) { copied.textContent = 'Press and hold the address to copy it.'; }
    });
    wrap.append(
      el('p', { class: 'muted small', text: 'Your forwarding address. It is yours alone; don’t share it.' }),
      el('div', { class: 'acct-address' }, el('code', { text: address }), copy), copied,
      el('p', { class: 'acct-note', role: 'status', text: forwardStatus() }),
      el('h4', { text: 'Gmail' }),
      steps(['On a computer, open Gmail, click the gear, then “See all settings”.', 'Open “Forwarding and POP/IMAP”, click “Add a forwarding address” and paste your address.', 'Gmail asks for a confirmation code. It shows up on this screen within about 10 minutes. Type it into Gmail.', 'Open “Filters and Blocked Addresses” and click “Create a new filter”.', 'In “Has the words”, type: shipped OR tracking OR “out for delivery”. Click “Create filter”.', 'Tick “Forward it to”, choose your Hearth address, and save.']),
      el('h4', { text: 'iCloud Mail' }),
      steps(['On a computer, open icloud.com/mail, click the gear, then Settings.', 'Open “Rules” and click “Add Rule”.', 'Set it to: if the subject contains “shipped” (add more rules for “tracking” and “delivery”).', 'Choose “Forward to” and paste your Hearth address. Save.']));
    return wrap;
  }

  function musicPicker(onSaved) {
    const select = el('select', { name: 'music' }, el('option', { value: '', text: 'None' }), MUSIC.map(([k, name]) => el('option', { value: k, text: name })));
    select.value = musicKey();
    const status = el('p', { class: 'acct-note', role: 'status' });
    const err = errorLine();
    select.addEventListener('change', async () => {
      const mine = epoch;
      const choice = MUSIC.some((m) => m[0] === select.value) ? select.value : '';
      err.textContent = ''; status.textContent = 'Saving…';
      try {
        const id = session.user.id;
        const body = { music_service: choice || null, updated_at: new Date().toISOString() };
        let rows = await authed(`/rest/v1/settings?user_id=eq.${id}`, { method: 'PATCH', body, prefer: 'return=representation' });
        if (!Array.isArray(rows) || !rows.length) rows = await authed('/rest/v1/settings', { method: 'POST', body: Object.assign({ user_id: id }, body), prefer: 'return=representation' });
        if (mine !== epoch) return;
        user.settings = { user_id: id, music_service: choice || null };
        status.textContent = 'Saved.';
        onSaved();
      } catch (e) {
        if (mine !== epoch) return;
        status.textContent = '';
        err.textContent = plainError(e);
        select.value = musicKey();
      }
    });
    return el('div', { class: 'acct-block' }, field('Music service', select), status, err);
  }

  /* ---------- Welcome steps ---------- */
  // Reopening the app mid-setup: pick up at the first step that isn't done, once per sign-in.
  function resumeWelcome() {
    if (ui.resumed) return;
    ui.resumed = true;
    if (!needsWelcome() || ui.step !== 0) return;
    const have = [calendars().length > 0, !!forwardToken(), !!musicKey()];
    while (ui.step < have.length && have[ui.step]) { ui.done[ui.step] = true; ui.step += 1; }
  }
  function goStep(i) {
    ui.step = Math.min(Math.max(i, 0), STEPS.length - 1);
    ui.stepNote = '';
    changed('ui', '.acct-welcome h3');
  }
  function stepDone(i, note) {
    ui.done[i] = true;
    ui.stepNote = note;
    changed('ui', '.acct-welcome .acct-next');
  }
  function welcomeCard() {
    const i = ui.step;
    const card = el('div', { class: 'card lock-card acct-card acct-welcome' });
    card.append(el('p', { class: 'acct-step', text: `Step ${i + 1} of ${STEPS.length}` }), el('h3', { tabindex: '-1', text: STEPS[i] }));
    const err = errorLine();
    const nav = el('div', { class: 'acct-nav' });
    nav.append(i > 0 ? textBtn('Back', () => goStep(i - 1)) : el('span'));
    if (ui.stepNote) card.append(el('p', { class: 'acct-note', role: 'status', text: ui.stepNote }));

    if (i === 0) {
      const name = user.profile && user.profile.display_name;
      card.append(el('p', { class: 'muted', text: `Welcome${name ? ', ' + name : ''}. Let’s set up your Hearth. Every step is optional.` }));
      if (!ui.done[0]) card.append(el('p', { class: 'muted small', text: 'Add your calendar so today’s events show up here.' }), calendarForm(() => stepDone(0, 'Calendar added. Events appear within about 15 minutes.')));
    } else if (i === 1) {
      card.append(el('p', { class: 'muted', text: 'Hearth can show deliveries that are on the way. It reads the shipping emails you forward to it, and nothing else in your inbox.' }),
        packagesBlock(false, () => stepDone(1, 'Package emails are on. Set up forwarding with the steps below.')));
    } else if (i === 2) {
      card.append(el('p', { class: 'muted', text: 'Pick the app you listen with and Hearth adds a button to open it. Choose None to leave it off.' }),
        musicPicker(() => stepDone(2, 'Saved.')));
    } else {
      const cals = calendars();
      const music = MUSIC.find((m) => m[0] === musicKey());
      card.append(el('p', { class: 'muted', text: 'Here’s what you set up. You can change any of it later in Settings.' }),
        el('ul', { class: 'acct-summary' },
          el('li', { text: cals.length ? `Calendar: connected (${cals.map((c) => c.label || 'Calendar').join(', ')})` : 'Calendar: skipped' }),
          el('li', { text: forwardToken() ? 'Package emails: on' : inboxOn() ? 'Package emails: skipped' : 'Package emails: not available yet' }),
          el('li', { text: music ? `Music: ${music[1]}` : 'Music: none chosen' })));
    }

    if (i < STEPS.length - 1) {
      nav.append(ui.done[i] ? Object.assign(mainBtn('Next', () => goStep(i + 1)), { className: 'btn acct-next' }) : textBtn('Skip', () => goStep(i + 1)));
    } else {
      const finish = mainBtn('Finish', async () => {
        const mine = epoch;
        finish.disabled = true; err.textContent = '';
        try {
          await authed(`/rest/v1/profiles?id=eq.${session.user.id}`, { method: 'PATCH', body: { onboarding_done: true }, prefer: 'return=representation' });
          if (mine !== epoch) return;
          user.profile.onboarding_done = true;
          changed('ui');
          window.scrollTo(0, 0);
        } catch (e) { if (mine === epoch) { finish.disabled = false; err.textContent = plainError(e); } }
      });
      nav.append(finish);
    }
    card.append(err, nav);
    return card;
  }

  /* ---------- Signed-in cards: music launcher, account + settings ---------- */
  function musicCard(key) {
    const m = MUSIC.find((x) => x[0] === key);
    if (MUSIC_PANELS[key]) return MUSIC_PANELS[key](m);
    return el('div', { class: 'card acct-music', 'data-service': key },
      el('div', { class: 'hl-title', text: m[1] }),
      el('a', { class: 'btn', href: m[2], target: '_blank', rel: 'noopener' }, `Open ${m[1]}`, el('span', { class: 'visually-hidden', text: ' (opens in a new tab)' })));
  }
  function calendarRow(c) {
    const status = c.status === 'ok' ? 'Working' : c.status === 'error' ? 'Not working' + (c.status_note ? `: ${c.status_note}` : '') : 'Waiting for the first check (about 15 minutes)';
    const name = c.label || 'Calendar';
    const err = errorLine();
    const remove = textBtn('Remove', async () => {
      if (!/^[0-9a-f-]{36}$/i.test(String(c.id)) || !window.confirm(`Remove “${name}”? Its events will disappear from Hearth.`)) return;
      remove.disabled = true; err.textContent = '';
      try {
        await authed(`/rest/v1/connections?id=eq.${c.id}&user_id=eq.${session.user.id}`, { method: 'DELETE' });
        ui.accountNote = 'Calendar removed.';
        await reload();
      } catch (e) { remove.disabled = false; err.textContent = plainError(e); }
    });
    remove.setAttribute('aria-label', `Remove ${name}`);
    return el('li', { class: 'acct-row' }, el('div', { class: 'exp-main' }, el('div', { class: 'hl-title', text: name }), el('div', { class: 'hl-detail', text: status }), err), remove);
  }
  function accountCard(full) {
    const card = el('div', { class: 'card lock-card acct-card acct-account' });
    const name = user.profile && user.profile.display_name;
    card.append(el('div', { class: 'hl-title acct-email', text: name || session.user.email || 'Signed in' }));
    if (name && session.user.email) card.append(el('div', { class: 'hl-detail acct-email', text: session.user.email }));
    if (full) {
      const cals = calendars();
      const add = el('details', { class: 'acct-more' }, el('summary', { text: 'Add a calendar' }),
        calendarForm(() => { ui.addCalOpen = false; ui.accountNote = 'Calendar added. Events appear within about 15 minutes.'; changed('ui', '.acct-account .acct-note'); }));
      add.open = ui.addCalOpen;
      add.addEventListener('toggle', () => { ui.addCalOpen = add.open; });
      const settings = el('details', { class: 'acct-more acct-settings' }, el('summary', { text: 'Settings' }),
        ui.accountNote ? el('p', { class: 'acct-note', role: 'status', tabindex: '-1', text: ui.accountNote }) : null,
        el('h4', { text: 'Calendars' }),
        cals.length ? el('ul', { class: 'acct-list' }, cals.map(calendarRow)) : el('p', { class: 'muted small', text: 'No calendars yet.' }),
        add,
        el('h4', { text: 'Package emails' }), packagesBlock(true, () => changed('ui')),
        el('h4', { text: 'Music' }), musicPicker(() => changed('ui')));
      settings.open = ui.settingsOpen;
      settings.addEventListener('toggle', () => { ui.settingsOpen = settings.open; });
      card.append(settings);
    }
    card.append(el('div', { class: 'acct-nav' }, el('span'), textBtn('Sign out', signOut)));
    return card;
  }

  /* ---------- Interface for app.js ---------- */
  window.HearthAccounts = {
    init(h) {
      hooks = h; el = h.el; uid = h.uid;
      session = readSession();
      scheduleRefresh();
      // Sign-out or a different sign-in in another tab: follow it, wiping first.
      window.addEventListener('storage', (e) => {
        if (e.key !== SESSION_STORE && e.key !== null) return;
        const s = readSession();
        if (!s) { if (session) signOutLocal(''); return; }
        if (session && s.user.id === session.user.id) { session = s; scheduleRefresh(); return; }
        clearTimeout(refreshTimer);
        epoch++; wipeMemory(); session = s; scheduleRefresh();
        changed('user');
        loadUser();
      });
      document.addEventListener('focusout', () => {
        if (pending) setTimeout(() => { if (pending && !editing()) changed('data'); }, 0);
      });
    },
    signedIn: () => !!session,
    personal,
    // What to say in place of personal items while there is nothing to show yet.
    loadNote: () => (user.error === 'offline' ? 'Couldn’t load your items. Check your connection.' : user.error ? 'Couldn’t load your items. Tap refresh to try again.' : 'Loading your items…'),
    load: () => loadUser().catch(() => {}),
    editing,
    defer() { pending = true; },
    authOpen: () => ui.authOpen,
    openAuth() { ui.authOpen = true; changed('ui', '.acct-auth h3'); },
    // Signed out: the one sign-in card. opts.legacy builds the old passphrase card.
    authNodes(opts) {
      if (session) return [];
      return [keep('auth', [ui.authMode, ui.notice, ui.email, !!(opts && opts.legacy), (opts && opts.note) || ''], () => authCard(opts))];
    },
    // First sign-in: the welcome steps, until Finish.
    welcomeNodes() {
      if (!needsWelcome()) return [];
      return [keep('welcome', [ui.step, ui.done, ui.stepNote, calendars().length, forwardToken()], welcomeCard)];
    },
    // Signed in: music launcher (if chosen) and the Account card.
    accountNodes() {
      if (!session) return [];
      const out = [];
      const key = user.loaded ? musicKey() : '';
      if (key) out.push(el('h3', { class: 'section-label', text: 'Music' }), keep('music', key, () => musicCard(key)));
      const full = user.loaded && !needsWelcome();
      out.push(el('h3', { class: 'section-label', text: 'Account' }),
        keep('account', [full, session.user.email, user.profile && user.profile.display_name, calendars(), forwardToken(), ui.accountNote], () => accountCard(full)));
      return out;
    },
  };
})();
