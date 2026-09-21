/* Bangkok Hotel Ledger — app logic.
   Plain browser JS, no build step. Works from file://, GitHub Pages and as a
   claude.ai artifact (where a shared document store replaces localStorage). */
(() => {
'use strict';

/* ---------------- utilities ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 9);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const DAY = 86400000;
const dateAdd = (iso, d) => { const dt = new Date(iso + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + d); return dt.toISOString().slice(0, 10); };
const fmtDate = (iso, o = { month: 'short', day: 'numeric' }) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtUSD = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtTHB = (n) => '฿' + Math.round(n).toLocaleString('en-US');
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)} h ago`;
  const d = h / 24; if (d < 45) return `${Math.round(d)} d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
const norm = (s) => String(s || '').toLowerCase().replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
let toastTimer;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600); }
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------------- data & state ---------------- */
const DATA = window.BKK_HOTELS || { hotels: [], trip: {} };
const PHOTOS = window.BKK_PHOTOS || {};
const BASEMAP = window.BKK_BASEMAP || null;
const AREAS = ['Riverside', 'Silom / Sathorn', 'Lumphini / Wireless Road', 'Siam / Ratchaprasong', 'Sukhumvit', 'Other'];
const SEG_COLORS = ['var(--accent)', 'var(--fhr)', 'var(--thc)', 'var(--good)', 'var(--bad)', 'var(--ink-3)'];
const LS_KEY = 'bkk-ledger-v1';
const LS_UI = 'bkk-ledger-ui';

const DEFAULT_SETTINGS = {
  checkin: DATA.trip?.checkin || '2027-05-01',
  checkout: DATA.trip?.checkout || '2027-05-06',
  adults: DATA.trip?.adults || 2,
  currency: 'USD',
  thbPerUsd: 34,
  credits: [
    { id: 'c1', label: 'Card A · Jul–Dec 2026', amount: 300, from: '2026-07-01', to: '2026-12-31' },
    { id: 'c2', label: 'Card B · Jul–Dec 2026', amount: 300, from: '2026-07-01', to: '2026-12-31' },
    { id: 'c3', label: 'Card A · Jan–Jun 2027', amount: 300, from: '2027-01-01', to: '2027-06-30' },
    { id: 'c4', label: 'Card B · Jan–Jun 2027', amount: 300, from: '2027-01-01', to: '2027-06-30' },
  ],
};
const state = { settings: clone(DEFAULT_SETTINGS), prices: {}, hotels: {}, custom: {}, plan: { segments: null, booked: {} } };
const ui = { tab: 'hotels', view: 'side', selected: null, hover: null, program: { FHR: true, THC: true }, starred: false, showHidden: false, area: '', sort: 'price', tiles: false, previewRows: null };
try { Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI) || '{}')); } catch (e) { /* ignore */ }
ui.selected = null; ui.hover = null; ui.previewRows = null;
const saveUI = debounce(() => { try { localStorage.setItem(LS_UI, JSON.stringify({ tab: ui.tab, view: ui.view, program: ui.program, starred: ui.starred, showHidden: ui.showHidden, area: ui.area, sort: ui.sort, tiles: ui.tiles })); } catch (e) { /* ignore */ } }, 200);

function applyState(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.settings) state.settings = { ...clone(DEFAULT_SETTINGS), ...obj.settings, credits: Array.isArray(obj.settings.credits) && obj.settings.credits.length ? obj.settings.credits : clone(DEFAULT_SETTINGS.credits) };
  if (obj.prices) state.prices = obj.prices;
  if (obj.hotels) state.hotels = obj.hotels;
  if (obj.custom) state.custom = obj.custom;
  if (obj.plan) state.plan = { segments: obj.plan.segments || null, booked: obj.plan.booked || {} };
}
const S = () => state.settings;
const nights = () => Math.max(1, Math.round((new Date(S().checkout) - new Date(S().checkin)) / DAY));

/* ---------------- storage: localStorage or the artifact's shared store ---------------- */
const store = {
  mode: 'local', db: null, downloads: null, assets: null, queues: {},
  loadLocal() { try { const raw = localStorage.getItem(LS_KEY); if (raw) applyState(JSON.parse(raw)); } catch (e) { /* ignore */ } },
  persistLocal: debounce(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }, 150),
  write(kind, id) {
    if (this.mode !== 'db') { this.persistLocal(); return; }
    let path, data;
    if (kind === 'settings') { path = 'state/settings'; data = state.settings; }
    else if (kind === 'plan') { path = 'state/plan'; data = state.plan; }
    else if (kind === 'prices') { path = 'prices/' + id; data = state.prices[id] ? { entries: state.prices[id] } : null; }
    else if (kind === 'hotels') { path = 'hotels/' + id; data = state.hotels[id] && Object.keys(state.hotels[id]).length ? state.hotels[id] : null; }
    else if (kind === 'custom') { path = 'custom/' + id; data = state.custom[id] || null; }
    else return;
    const ref = this.db.doc(path);
    const op = () => (data == null ? ref.delete() : ref.set(clone(data)));
    this.queues[path] = (this.queues[path] || Promise.resolve()).then(op).catch((e) => {
      console.warn('shared store write failed', path, e);
      toast('Could not save to the shared store' + (e && e.code ? ` (${e.code})` : ''));
    });
  },
  writeAll() {
    this.write('settings'); this.write('plan');
    Object.keys(state.prices).forEach((id) => this.write('prices', id));
    Object.keys(state.hotels).forEach((id) => this.write('hotels', id));
    Object.keys(state.custom).forEach((id) => this.write('custom', id));
  },
  async connect() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    let db = null;
    try { db = await window.claude.use('db'); } catch (e) { db = null; }
    if (!db) return;
    this.db = db; this.mode = 'db';
    try { this.downloads = await window.claude.use('downloads'); } catch (e) { this.downloads = null; }
    try { this.assets = await window.claude.use('assets'); } catch (e) { this.assets = null; }
    let dbEmpty = true;
    try {
      const [s, p, pr, ho, cu] = await Promise.all([db.doc('state/settings').get(), db.doc('state/plan').get(), db.collection('prices').get(), db.collection('hotels').get(), db.collection('custom').get()]);
      dbEmpty = !s.exists && !p.exists && pr.empty && ho.empty && cu.empty;
    } catch (e) { console.warn('initial read failed', e); }
    const localHasData = Object.keys(state.prices).length || Object.keys(state.hotels).length || Object.keys(state.custom).length || (state.plan && state.plan.segments);
    if (dbEmpty && localHasData) {
      this.writeAll();
    } else if (!dbEmpty) {
      // the shared store is the source of truth from here on
      state.prices = {}; state.hotels = {}; state.custom = {};
    }
    const onErr = (e) => console.warn('subscription error', e);
    db.doc('state/settings').onSnapshot((snap) => { if (snap.exists) applyState({ settings: snap.data() }); scheduleRender(); }, onErr);
    db.doc('state/plan').onSnapshot((snap) => { if (snap.exists) applyState({ plan: snap.data() }); scheduleRender(); }, onErr);
    db.collection('prices').onSnapshot((qs) => { const o = {}; qs.docs.forEach((d) => { const v = d.data(); if (v && Array.isArray(v.entries)) o[d.id] = v.entries; }); state.prices = o; scheduleRender(); }, onErr);
    db.collection('hotels').onSnapshot((qs) => { const o = {}; qs.docs.forEach((d) => { o[d.id] = d.data() || {}; }); state.hotels = o; scheduleRender(); }, onErr);
    db.collection('custom').onSnapshot((qs) => { const o = {}; qs.docs.forEach((d) => { o[d.id] = d.data(); }); state.custom = o; scheduleRender(); }, onErr);
    const sync = $('#sync'); sync.classList.add('shared'); $('.t', sync).textContent = 'Shared · synced'; sync.title = 'Prices and plans are stored with this page and shared with everyone who can open it';
    scheduleRender();
  },
  async download(filename, text, mime) {
    if (this.downloads) {
      try { await this.downloads.save({ filename, data: text }); return; } catch (e) { if (e && e.code === 'cancelled') return; }
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
      a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast('Download blocked here; copy from the console instead'); console.log(text); }
  },
};

/* ---------------- hotels & prices ---------------- */
function allHotels() {
  const base = DATA.hotels.map((h) => ({ ...h }));
  const custom = Object.values(state.custom).map((h) => ({ ...h, custom: true }));
  return base.concat(custom).map((h) => ({ ...h, ov: state.hotels[h.id] || {} }));
}
const hotelById = (id) => allHotels().find((h) => h.id === id) || null;
const entries = (id) => (Array.isArray(state.prices[id]) ? state.prices[id] : []);
const latest = (id) => { const a = entries(id); return a.length ? a[a.length - 1] : null; };
const previous = (id) => { const a = entries(id); return a.length > 1 ? a[a.length - 2] : null; };
function money(usd, opts = {}) {
  if (usd == null || isNaN(usd)) return '—';
  return S().currency === 'THB' && !opts.forceUSD ? fmtTHB(usd * S().thbPerUsd) : fmtUSD(usd);
}
function altMoney(usd) { if (usd == null) return ''; return S().currency === 'THB' ? fmtUSD(usd) : fmtTHB(usd * S().thbPerUsd); }
function visibleHotels() {
  const N = nights();
  let list = allHotels().filter((h) => ui.program[h.program] !== false)
    .filter((h) => !ui.area || h.area === ui.area)
    .filter((h) => !ui.starred || h.ov.star)
    .filter((h) => ui.showHidden || !h.ov.hidden);
  const key = {
    price: (h) => { const l = latest(h.id); return l ? l.usd : 1e9; },
    name: (h) => h.name.replace(/^the\s+/i, '').toLowerCase(),
    area: (h) => AREAS.indexOf(h.area) + '|' + h.name,
    program: (h) => (h.program === 'FHR' ? 0 : 1) + '|' + h.name,
    checked: (h) => { const l = latest(h.id); return l ? -l.t : 1e18; },
  }[ui.sort] || ((h) => h.name);
  list.sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  return list.map((h) => ({ ...h, N }));
}
function logPrice(id, { amount, cur, kind, src, note }) {
  const N = nights();
  let usd = Number(amount);
  if (!isFinite(usd) || usd <= 0) return false;
  if (kind === 'total') usd = usd / N;
  if (cur === 'THB') usd = usd / S().thbPerUsd;
  const list = entries(id).slice();
  list.push({ t: Date.now(), usd: Math.round(usd * 100) / 100, cur: cur || 'USD', amt: Number(amount), kind: kind || 'night', src: src || 'manual', note: note || '' });
  while (list.length > 300) list.shift();
  state.prices[id] = list;
  store.write('prices', id);
  return true;
}
function setOverride(id, patch) {
  const cur = { ...(state.hotels[id] || {}) };
  Object.entries(patch).forEach(([k, v]) => { if (v === undefined || v === null || v === '' || v === false) delete cur[k]; else cur[k] = v; });
  if (Object.keys(cur).length) state.hotels[id] = cur; else delete state.hotels[id];
  store.write('hotels', id);
}

/* ---------------- links ---------------- */
function extractAmexId(url) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get('hotel_search[hotel_id]');
    if (id && /^\d+$/.test(id)) return id;
    const m = u.pathname.match(/\/hotels\/(\d+)/) || u.search.match(/hotel_id[^\d]*(\d+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}
function dlLink(id, program) {
  const s = S();
  const base = program === 'FHR' ? 'https://www.amextravel.com/hotel/dl/featured_hotels/availability' : 'https://www.amextravel.com/hotel/dl/hotels/availability';
  const p = new URLSearchParams();
  p.set('hotel_search[hotel_id]', id);
  p.set('hotel_search[start_date]', s.checkin);
  p.set('hotel_search[end_date]', s.checkout);
  p.set('hotel_search[num_rooms]', '1');
  p.set('hotel_search[hotel_search_rooms_attributes][0][number_adults]', String(s.adults));
  if (program === 'FHR') p.set('hotel_search[modifier]', 'FHR'); else p.set('partner_programs', 'thc');
  return base + '?' + p.toString();
}
function amexLink(h) {
  const ov = h.ov || {};
  if (ov.amexUrl) {
    try {
      const u = new URL(ov.amexUrl);
      if (u.searchParams.get('hotel_search[hotel_id]')) {
        const s = S(); const p = u.searchParams;
        p.set('hotel_search[start_date]', s.checkin); p.set('hotel_search[end_date]', s.checkout);
        p.delete('hotel_search[is_dateless]'); p.set('hotel_search[num_rooms]', '1');
        p.set('hotel_search[hotel_search_rooms_attributes][0][number_adults]', String(s.adults));
        ['intlink', 'linknav', 'cmpid', 'tc'].forEach((k) => p.delete(k));
        return { href: u.toString(), dated: true };
      }
    } catch (e) { /* fall through */ }
  }
  const id = ov.amexHotelId || (ov.amexUrl && extractAmexId(ov.amexUrl));
  if (id) return { href: dlLink(id, h.program), dated: true };
  if (ov.amexUrl && /americanexpress\.com|amextravel\.com/.test(ov.amexUrl)) return { href: ov.amexUrl, dated: false };
  return { href: h.amexPage || 'https://www.amextravel.com/featured-hotel-searches', dated: false };
}
const bookingLink = (h) => `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(h.name + ', Bangkok')}&checkin=${S().checkin}&checkout=${S().checkout}&group_adults=${S().adults}&no_rooms=1&group_children=0`;
const mapsLink = (h) => (h.lat != null ? `https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name + ' Bangkok')}`);
const AMEX_SEARCH = 'https://www.amextravel.com/featured-hotel-searches';
const AMEX_BANGKOK = 'https://www.americanexpress.com/en-us/travel/discover/property-results/dt/4/d/Bangkok,Thailand';

/* ---------------- photos ---------------- */
function photoSrc(h) {
  const ov = h.ov || {};
  if (ov.photoAsset) return '/_blob/' + ov.photoAsset;
  if (ov.photoUrl) return ov.photoUrl;
  const p = PHOTOS[h.id];
  return p && p.file ? p.file : null;
}
function photoHTML(h, cls = '') {
  const src = photoSrc(h);
  const hue = [...h.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const initials = h.name.replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const ph = `<div class="ph" style="background:linear-gradient(135deg,hsl(${hue} 32% 46%),hsl(${(hue + 40) % 360} 38% 30%))">${esc(initials)}<small>${esc(h.area)}</small></div>`;
  if (!src) return `<div class="photo ${cls}">${ph}</div>`;
  return `<div class="photo ${cls}">${ph}<img src="${esc(src)}" alt="${esc(h.name)}" loading="lazy" onerror="this.remove()"></div>`;
}
function photoCredit(h) {
  const ov = h.ov || {};
  if (ov.photoAsset || ov.photoUrl) return '';
  const p = PHOTOS[h.id];
  if (!p || !p.file) return '';
  const who = p.artist ? esc(p.artist) : 'Wikimedia Commons';
  const lic = p.license ? ` · ${esc(p.license)}` : '';
  return p.page ? `Photo: <a href="${esc(p.page)}" target="_blank" rel="noopener">${who}</a>${lic}` : `Photo: ${who}${lic}`;
}

/* ---------------- render orchestration ---------------- */
let renderQueued = false, renderPending = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const ae = document.activeElement;
    if (ae && ae.matches('input, textarea, select') && ae.closest('#main')) { renderPending = true; return; }
    renderAll();
  });
}
document.addEventListener('focusout', () => { if (renderPending) { renderPending = false; setTimeout(scheduleRender, 50); } });
function renderAll() {
  renderTrip(); renderTabs(); renderList(); renderMarkers(); renderPlan(); renderCompare();
  if (ui.selected) renderDrawer();
}

/* ---------------- top bar & tabs ---------------- */
function renderTrip() {
  const s = S();
  const inD = fmtDate(s.checkin, { weekday: 'short', month: 'short', day: 'numeric' });
  const outD = fmtDate(s.checkout, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  $('#tripline').innerHTML = `<span class="num">${esc(inD)}</span> → <span class="num">${esc(outD)}</span><span class="sepdot">·</span>${nights()} nights<span class="sepdot">·</span>${s.adults} adults<span class="sepdot">·</span><a href="${AMEX_SEARCH}" target="_blank" rel="noopener">Amex search ↗</a>`;
}
function renderTabs() {
  const isMobile = window.matchMedia('(max-width: 899px)').matches;
  $$('#tabs button').forEach((b) => { const t = b.dataset.tab; b.classList.toggle('on', t === 'map' ? (isMobile && ui.view === 'map') : (ui.tab === t && (!isMobile || ui.view === 'side'))); });
  ['hotels', 'plan', 'prices'].forEach((t) => { $('#tab-' + t).hidden = ui.tab !== t; });
  $('[data-pane="map"]').classList.toggle('on', ui.view === 'map' || !isMobile);
  $('[data-pane="side"]').classList.toggle('on', ui.view === 'side' || !isMobile);
  if (map) setTimeout(() => map.invalidateSize(), 60);
}

/* ---------------- map ---------------- */
let map = null, base = {}, markers = {}, tileLayer = null, labelGroup = null, fitted = false;
const AREA_LABELS = [
  ['Riverside', 13.7205, 100.5085], ['Silom · Sathorn', 13.7215, 100.5330], ['Siam', 13.7475, 100.5325], ['Ratchaprasong', 13.7455, 100.5415],
  ['Lumphini', 13.7315, 100.5415], ['Sukhumvit', 13.7385, 100.5595], ['Thonglor', 13.7290, 100.5800], ['Chinatown', 13.7395, 100.5085],
  ['Old City', 13.7545, 100.4960], ['Thonburi', 13.7275, 100.4925], ['Khlong Toei', 13.7160, 100.5620], ['Ari', 13.7800, 100.5445], ['Ratchada', 13.7660, 100.5720],
];
const POIS = [
  ['Grand Palace', 13.7500, 100.4913], ['Wat Arun', 13.7437, 100.4888], ['Wat Pho', 13.7465, 100.4930], ['ICONSIAM', 13.7263, 100.5100], ['Asiatique', 13.7046, 100.5029],
  ['Siam Paragon', 13.7466, 100.5347], ['CentralWorld', 13.7466, 100.5393], ['Erawan Shrine', 13.7441, 100.5403], ['EmQuartier', 13.7310, 100.5696], ['Terminal 21', 13.7377, 100.5604],
  ['Lumphini Park', 13.7314, 100.5414], ['Benjakitti Park', 13.7274, 100.5570], ['Chatuchak Market', 13.7999, 100.5502], ['Khao San Road', 13.7588, 100.4975], ['Jim Thompson House', 13.7492, 100.5282],
  ['Wat Saket', 13.7539, 100.5065], ['Sathorn Pier', 13.7186, 100.5140], ['River City', 13.7325, 100.5125], ['Queen Sirikit Centre', 13.7237, 100.5601], ['BACC', 13.7466, 100.5305],
];
const ROAD_LABELS = [
  ['Sukhumvit Rd', 13.7370, 100.5610, -26], ['Silom Rd', 13.7268, 100.5290, -30], ['Sathorn Rd', 13.7228, 100.5320, -30], ['Rama IV Rd', 13.7292, 100.5480, -12],
  ['Wireless Rd', 13.7365, 100.5479, -84], ['Ratchadamri Rd', 13.7355, 100.5401, -88], ['Phloen Chit Rd', 13.7437, 100.5445, 0], ['Rama I Rd', 13.7462, 100.5295, 0],
  ['Charoen Krung Rd', 13.7300, 100.5165, -68], ['Phaya Thai Rd', 13.7415, 100.5303, -87], ['Phetchaburi Rd', 13.7505, 100.5480, 0], ['Ratchadaphisek Rd', 13.7460, 100.5660, -80],
];
const RAIL_FALLBACK = [[/sukhumvit/i, '#7CB342'], [/silom/i, '#00897B'], [/gold/i, '#C5A054'], [/blue/i, '#1E4FA3'], [/purple/i, '#7B3F98'], [/yellow/i, '#F9A825'], [/pink/i, '#E91E63'], [/orange/i, '#F57C00'], [/airport|arl/i, '#C62828'], [/red/i, '#B71C1C']];
function railColor(p) {
  if (p.c && /^#?[0-9a-f]{6}$/i.test(p.c)) return p.c.startsWith('#') ? p.c : '#' + p.c;
  if (p.c && /^[a-z]+$/i.test(p.c) && CSS.supports('color', p.c)) return p.c;
  const n = (p.n || '') + ' ' + (p.ref || '');
  for (const [re, c] of RAIL_FALLBACK) if (re.test(n)) return c;
  return cssVar('--ink-3');
}
function stationColor(p) {
  const n = (p.net || '') + ' ' + (p.n || '');
  if (/BTS/i.test(n)) return '#2E7D32';
  if (/MRT/i.test(n)) return '#1E4FA3';
  if (/airport|ARL/i.test(n)) return '#C62828';
  if (/SRT|red/i.test(n)) return '#B71C1C';
  return cssVar('--ink-3');
}
function roadStyle(f, casing) {
  const z = map.getZoom();
  const h = f.properties.h;
  if ((h === 'r' && z <= 12.5) || (h === 's' && z <= 11.5)) return { opacity: 0, weight: 0.1 };
  const baseW = { m: 3.2, t: 3.2, p: 2.6, s: 1.8, r: 1.0 }[h] || 1;
  const scale = z <= 12 ? 0.6 : z < 14 ? 1 : z < 15 ? 1.5 : z < 16 ? 2.2 : 3;
  const w = baseW * scale;
  if (casing) return { color: cssVar('--map-road-casing'), weight: w + 1.6, opacity: 1, lineCap: 'round', lineJoin: 'round' };
  return { color: h === 'r' ? cssVar('--map-road-minor') : cssVar('--map-road'), weight: w, opacity: 1, lineCap: 'round', lineJoin: 'round' };
}
function buildBase() {
  Object.values(base).forEach((l) => { try { map.removeLayer(l); } catch (e) { /* ignore */ } });
  base = {};
  if (!BASEMAP || !BASEMAP.layers) return;
  const Ly = BASEMAP.layers;
  const opts = (pane) => ({ renderer: L.canvas({ pane }), interactive: false });
  base.water = L.geoJSON(Ly.water, { ...opts('water'), style: { color: cssVar('--map-water-line'), weight: 1, fillColor: cssVar('--map-water'), fillOpacity: 1, opacity: 1 } });
  base.waterlines = L.geoJSON(Ly.waterlines, { ...opts('water'), style: (f) => ({ color: cssVar('--map-water'), weight: f.properties.k === 'river' ? 3 : 1.6, opacity: 1 }) });
  base.parks = L.geoJSON(Ly.parks, { ...opts('parks'), style: (f) => ({ stroke: false, fillColor: f.properties.k === 'golf' ? cssVar('--map-golf') : cssVar('--map-park'), fillOpacity: 1 }) });
  const roadRenderer = L.canvas({ pane: 'roads' });
  base.casing = L.geoJSON(Ly.roads, { renderer: roadRenderer, interactive: false, style: (f) => roadStyle(f, true) });
  base.roads = L.geoJSON(Ly.roads, { renderer: roadRenderer, interactive: false, style: (f) => roadStyle(f, false) });
  base.rail = L.geoJSON(Ly.rail, { ...opts('rail'), style: (f) => ({ color: railColor(f.properties), weight: 3, opacity: 0.95 }) });
  base.stations = L.geoJSON(Ly.stations, {
    ...opts('stations'),
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3.5, color: stationColor(f.properties), weight: 2, fillColor: cssVar('--surface'), fillOpacity: 1, interactive: false })
      .bindTooltip(f.properties.n, { permanent: true, direction: 'right', offset: [6, 0], className: 'stn-tip', interactive: false }),
  });
  if (ui.tiles && tileLayer) { base.rail.addTo(map); }
  else { base.water.addTo(map); base.waterlines.addTo(map); base.parks.addTo(map); base.casing.addTo(map); base.roads.addTo(map); base.rail.addTo(map); }
  onZoom();
}
function onZoom() {
  if (!map) return;
  const z = map.getZoom();
  const c = map.getContainer();
  c.classList.toggle('zoom-lo', z < 14);
  if (base.casing) { base.casing.setStyle((f) => roadStyle(f, true)); base.roads.setStyle((f) => roadStyle(f, false)); }
  if (base.stations) { if (z >= 13.5 && !map.hasLayer(base.stations)) base.stations.addTo(map); else if (z < 13.5 && map.hasLayer(base.stations)) map.removeLayer(base.stations); }
}
function buildLabels() {
  if (labelGroup) map.removeLayer(labelGroup);
  labelGroup = L.layerGroup();
  const mk = (cls, html, lat, lng) => L.marker([lat, lng], { icon: L.divIcon({ className: 'lbl ' + cls, html, iconSize: [0, 0], iconAnchor: [0, 0] }), interactive: false, keyboard: false, pane: 'labels' });
  AREA_LABELS.forEach(([n, lat, lng]) => labelGroup.addLayer(mk('area', `<span class="t">${esc(n)}</span>`, lat, lng)));
  POIS.forEach(([n, lat, lng]) => labelGroup.addLayer(mk('poi', `<span class="t">${esc(n)}</span>`, lat, lng)));
  ROAD_LABELS.forEach(([n, lat, lng, rot]) => labelGroup.addLayer(mk('road', `<span class="t" style="transform:translate(-50%,-50%) rotate(${rot}deg)">${esc(n)}</span>`, lat, lng)));
  labelGroup.addTo(map);
}
function probeTiles() {
  const img = new Image();
  img.onload = () => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (ui.tiles ? ' on' : ''); b.id = 'btn-tiles'; b.textContent = 'Street map'; b.title = 'Show OpenStreetMap tiles under the hotels'; b.onclick = () => setTiles(!ui.tiles); $('#map-ui').appendChild(b); if (ui.tiles) setTiles(true); };
  img.onerror = () => { ui.tiles = false; };
  img.src = 'https://tile.openstreetmap.org/12/6389/3818.png?v=' + Date.now();
}
function setTiles(on) {
  ui.tiles = on; saveUI();
  const b = $('#btn-tiles'); if (b) b.classList.toggle('on', on);
  if (on) {
    if (!tileLayer) tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { pane: 'tiles', maxZoom: 19, crossOrigin: true });
    tileLayer.addTo(map);
    ['water', 'waterlines', 'parks', 'casing', 'roads'].forEach((k) => base[k] && map.removeLayer(base[k]));
    if (labelGroup) map.removeLayer(labelGroup);
  } else {
    if (tileLayer) map.removeLayer(tileLayer);
    ['water', 'waterlines', 'parks', 'casing', 'roads'].forEach((k) => base[k] && base[k].addTo(map));
    if (base.rail) { map.removeLayer(base.rail); base.rail.addTo(map); }
    if (labelGroup) labelGroup.addTo(map);
  }
  $('#map-attrib').innerHTML = on ? 'Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' : (BASEMAP ? 'Base map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL)' : '');
}
function initMap() {
  map = L.map('map', { preferCanvas: true, zoomControl: false, attributionControl: false, minZoom: 11, maxZoom: 17, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  ['tiles', 'water', 'parks', 'roads', 'rail', 'stations', 'labels'].forEach((p, i) => { const pane = map.createPane(p); pane.style.zIndex = String(200 + i * 10); pane.style.pointerEvents = 'none'; });
  map.setView([13.7345, 100.5440], window.matchMedia('(max-width: 899px)').matches ? 13 : 14);
  buildBase(); buildLabels();
  map.on('zoomend', onZoom);
  map.on('click', () => { if (ui.selected) closeDrawer(); });
  setTiles(false);
  probeTiles();
  const fit = document.createElement('button'); fit.type = 'button'; fit.className = 'chip'; fit.textContent = 'Fit all'; fit.onclick = () => fitAll(true); $('#map-ui').appendChild(fit);
  $('#map-legend').innerHTML = `<span><span class="sw" style="background:var(--fhr)"></span>FHR</span><span><span class="sw" style="background:var(--thc)"></span>Hotel Collection</span><span><span class="sw" style="background:#7CB342"></span>BTS</span><span><span class="sw" style="background:#1E4FA3"></span>MRT</span>`;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => buildBase());
  new MutationObserver(() => buildBase()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
function fitAll(force) {
  const pts = visibleHotels().filter((h) => h.lat != null).map((h) => [h.lat, h.lng]);
  if (!pts.length) return;
  if (!force && fitted) return;
  fitted = true;
  map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 14.5 });
}
function markerHTML(h) {
  const l = latest(h.id);
  if (!l) return `<div class="pin-dot" title="${esc(h.name)}"></div>`;
  return `<div class="pin-inner"><span class="pd"></span>${esc(money(l.usd))}</div>`;
}
function renderMarkers() {
  if (!map) return;
  const vis = visibleHotels();
  const seen = new Set();
  vis.forEach((h) => {
    if (h.lat == null || h.lng == null) return;
    seen.add(h.id);
    const cls = ['pin', h.program, latest(h.id) ? 'priced' : 'dot', h.ov.star ? 'star' : '', h.ov.hidden ? 'dim' : '', ui.selected === h.id ? 'sel' : '', ui.hover === h.id ? 'hover' : ''].filter(Boolean).join(' ');
    const icon = L.divIcon({ className: cls, html: markerHTML(h), iconSize: [0, 0], iconAnchor: [0, 0] });
    let m = markers[h.id];
    if (!m) {
      m = L.marker([h.lat, h.lng], { icon, riseOnHover: true, keyboard: false, title: h.name });
      m.on('click', () => openHotel(h.id));
      m.on('mouseover', () => setHover(h.id)); m.on('mouseout', () => setHover(null));
      markers[h.id] = m; m.addTo(map);
    } else {
      m.setIcon(icon); m.setLatLng([h.lat, h.lng]);
      if (!map.hasLayer(m)) m.addTo(map);
    }
    m.setZIndexOffset(ui.selected === h.id ? 2000 : ui.hover === h.id ? 1500 : latest(h.id) ? 800 : h.ov.star ? 500 : 0);
  });
  Object.entries(markers).forEach(([id, m]) => { if (!seen.has(id) && map.hasLayer(m)) map.removeLayer(m); });
}
function setHover(id) {
  if (ui.hover === id) return;
  const prev = ui.hover; ui.hover = id;
  [prev, id].forEach((x) => { if (!x) return; const m = markers[x]; if (m && m.getElement()) m.getElement().classList.toggle('hover', x === id); const c = $(`#list [data-id="${x}"]`); if (c) c.classList.toggle('hover', x === id); });
}

/* ---------------- hotel list ---------------- */
function deltaHTML(id) {
  const l = latest(id), p = previous(id);
  if (!l || !p) return '';
  const d = l.usd - p.usd;
  if (Math.abs(d) < 1) return `<span class="delta flat">= unchanged</span>`;
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${money(Math.abs(d))}</span>`;
}
function sparkSVG(list, w = 84, h = 26) {
  const pts = list.slice(-30);
  if (pts.length < 2) return '';
  const ys = pts.map((e) => e.usd); const min = Math.min(...ys), max = Math.max(...ys); const rng = max - min || 1;
  const X = (i) => 3 + (i * (w - 6)) / (pts.length - 1); const Y = (v) => h - 3 - ((v - min) * (h - 6)) / rng;
  const d = pts.map((e, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(e.usd).toFixed(1)}`).join('');
  return `<svg class="sp" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="l" d="${d}"/><circle class="d" cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts[pts.length - 1].usd).toFixed(1)}" r="2.5"/></svg>`;
}
function renderList() {
  const all = allHotels();
  $('#n-fhr').textContent = all.filter((h) => h.program === 'FHR' && !h.ov.hidden).length;
  $('#n-thc').textContent = all.filter((h) => h.program === 'THC' && !h.ov.hidden).length;
  $$('#filters [data-f="program"]').forEach((b) => b.classList.toggle('on', ui.program[b.dataset.v] !== false));
  $('#filters [data-f="starred"]').classList.toggle('on', ui.starred);
  $('#f-hidden').checked = ui.showHidden; $('#f-area').value = ui.area; $('#f-sort').value = ui.sort;
  const vis = visibleHotels();
  $('#cnt-hotels').textContent = vis.length;
  const priced = vis.filter((h) => latest(h.id));
  $('#list-summary').textContent = `${vis.length} hotels · ${priced.length} with a logged price`;
  if (!vis.length) { $('#list').innerHTML = `<div class="empty">Nothing matches these filters.</div>`; return; }
  $('#list').innerHTML = vis.map((h) => {
    const l = latest(h.id); const link = amexLink(h);
    const price = l ? `<span class="price">${money(l.usd)}<small>/night</small></span><span class="sub">${money(l.usd * h.N)} for ${h.N} nights · ${altMoney(l.usd)}</span>` : `<span class="sub">No price logged yet</span>`;
    const checked = l ? `<span class="sub">checked ${ago(l.t)}${l.src === 'paste' ? ' · Amex paste' : ''}</span>` : '';
    return `<article class="hcard${ui.selected === h.id ? ' sel' : ''}${h.ov.hidden ? ' dim' : ''}" data-id="${h.id}">
      ${photoHTML(h)}
      <div class="body">
        <div class="title"><h3><button type="button" data-act="open">${esc(h.name)}</button></h3><button type="button" class="starbtn${h.ov.star ? ' on' : ''}" data-act="star" aria-label="Shortlist" title="Shortlist">★</button></div>
        <div class="meta"><span class="tag ${h.program}">${h.program === 'FHR' ? 'FHR' : 'Hotel Collection'}</span><span>${esc(h.area)}</span>${h.transit ? `<span>· ${esc(h.transit)}</span>` : ''}</div>
        <div class="pricebar"><div class="stack" style="gap:2px">${price}<div class="row" style="gap:8px">${deltaHTML(h.id)}${checked}</div></div><span class="spark">${sparkSVG(entries(h.id))}</span></div>
        <div class="actions">
          <a class="btn sm${link.dated ? ' primary' : ''}" href="${esc(link.href)}" target="_blank" rel="noopener" title="${link.dated ? 'Opens Amex Travel with your dates filled in' : 'Opens the Amex page for this hotel; enter your dates once there'}">Amex${link.dated ? ' · dates set' : ''} <span class="ext">↗</span></a>
          <button type="button" class="btn sm" data-act="quick">Log price</button>
          <span class="quicklog" data-quick hidden><input class="input mono" type="number" min="0" step="1" placeholder="${S().currency === 'THB' ? '฿ / night' : '$ / night'}" aria-label="Price per night"><button type="button" class="btn sm primary" data-act="quick-save">Save</button></span>
        </div>
      </div>
    </article>`;
  }).join('');
}

/* ---------------- drawer ---------------- */
let chartPts = [];
function openHotel(id) {
  ui.selected = id;
  renderDrawer(); renderMarkers();
  $$('#list .hcard').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  const d = $('#drawer'); d.hidden = false; d.scrollTop = 0;
  const h = hotelById(id);
  if (h && map && h.lat != null && !map.getBounds().pad(-0.2).contains([h.lat, h.lng])) map.panTo([h.lat, h.lng]);
}
function closeDrawer() { ui.selected = null; $('#drawer').hidden = true; renderMarkers(); $$('#list .hcard.sel').forEach((c) => c.classList.remove('sel')); }
function benefitsHTML(program) {
  const fhr = ['Daily breakfast for two', '$100 property credit per stay', 'Guaranteed 4 pm late check-out', 'Noon check-in when available', 'Room upgrade when available', 'Complimentary Wi-Fi'];
  const thc = ['$100 property credit on stays of 2+ nights', 'Room upgrade when available', '4 pm late check-out when available', 'Noon check-in when available'];
  return `<div class="benefits">${(program === 'FHR' ? fhr : thc).map((b) => `<div>${b}</div>`).join('')}</div>`;
}
function niceTicks(min, max, n) {
  const span = max - min; const raw = span / n; const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) || mag * 10;
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v); return out;
}
function chartSVG(list) {
  const pts = list.slice(-80);
  if (pts.length < 2) return `<p class="small muted" style="margin:0">Log a second price to see the trend.</p>`;
  const W = 520, H = 170, pl = 46, pr = 14, pt = 14, pb = 28;
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const ys = pts.map((e) => e.usd); let min = Math.min(...ys), max = Math.max(...ys);
  if (max - min < 10) { min -= 10; max += 10; } const span = max - min; min -= span * 0.12; max += span * 0.12;
  const X = (t) => pl + ((t - t0) / (t1 - t0)) * (W - pl - pr); const Y = (v) => pt + ((max - v) / (max - min)) * (H - pt - pb);
  const ticks = niceTicks(min, max, 3);
  chartPts = pts.map((e) => ({ x: X(e.t), y: Y(e.usd), e }));
  const line = chartPts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  const area = `${line}L${chartPts[chartPts.length - 1].x.toFixed(1)},${(H - pb).toFixed(1)}L${chartPts[0].x.toFixed(1)},${(H - pb).toFixed(1)}Z`;
  const fmt = (v) => (S().currency === 'THB' ? Math.round(v * S().thbPerUsd).toLocaleString('en-US') : Math.round(v).toLocaleString('en-US'));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" id="chart" role="img" aria-label="Price history">
    ${ticks.map((v) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`).join('')}
    <path class="area" d="${area}"/><path class="ln" d="${line}"/>
    ${chartPts.map((p, i) => `<circle class="pt${i === chartPts.length - 1 ? ' last' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === chartPts.length - 1 ? 4 : 3}"/>`).join('')}
    <text x="${pl}" y="${H - 8}">${new Date(t0).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>
    <text x="${W - pr}" y="${H - 8}" text-anchor="end">${new Date(t1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>
    <line class="cross" id="cross" y1="${pt}" y2="${H - pb}" x1="-10" x2="-10"/>
  </svg>`;
}
function renderDrawer() {
  const h = hotelById(ui.selected);
  const d = $('#drawer');
  if (!h) { d.hidden = true; return; }
  const N = nights(); const l = latest(h.id); const link = amexLink(h); const list = entries(h.id);
  const credit = photoCredit(h);
  const ov = h.ov;
  d.innerHTML = `
    <div class="hero">${photoHTML(h, 'hero-photo')}<button type="button" class="btn icon close" data-act="close" aria-label="Close">✕</button>${credit ? `<div class="credit">${credit}</div>` : ''}</div>
    <div class="content">
      <div class="stack" style="gap:6px">
        <div class="row"><span class="tag ${h.program}">${h.program === 'FHR' ? 'Fine Hotels + Resorts' : 'The Hotel Collection'}</span><span class="small muted">${esc(h.brand || '')}</span><span class="spacer"></span><button type="button" class="starbtn${ov.star ? ' on' : ''}" data-act="star" title="Shortlist">★</button></div>
        <h2>${esc(h.name)}</h2>
        <div class="small muted">${esc(h.area)}${h.transit ? ` · ${esc(h.transit)}` : ''}${h.address ? `<br>${esc(h.address)}` : ''}</div>
        ${h.notes ? `<p class="small" style="margin:4px 0 0">${esc(h.notes)}</p>` : ''}
      </div>

      <div class="card"><div class="pad stack">
        <div class="bigprice">${l ? `<span class="p">${money(l.usd)}<small>per night</small></span><span class="small muted">${money(l.usd * N)} for ${N} nights · ${altMoney(l.usd)} · checked ${ago(l.t)}</span>${deltaHTML(h.id)}` : `<span class="muted">No price logged yet. Open Amex, read the rate, log it here.</span>`}</div>
        <form class="row" data-form="log">
          <input class="input mono" name="amount" type="number" min="0" step="0.01" placeholder="rate" required aria-label="Price" style="width:120px">
          <select class="input" name="cur" aria-label="Currency"><option${S().currency === 'USD' ? ' selected' : ''}>USD</option><option${S().currency === 'THB' ? ' selected' : ''}>THB</option></select>
          <select class="input" name="kind" aria-label="Per night or total"><option value="night">per night</option><option value="total">total for ${N} nights</option></select>
          <input class="input" name="note" placeholder="note (rate name, room…)" aria-label="Note" style="flex:1;min-width:120px">
          <button class="btn primary" type="submit">Log price</button>
        </form>
        ${list.length ? `<div class="chart-wrap" style="position:relative">${chartSVG(list)}</div>` : ''}
      </div></div>

      <div class="links">
        <a class="btn${link.dated ? ' primary' : ''}" href="${esc(link.href)}" target="_blank" rel="noopener">${link.dated ? 'Amex Travel · dates filled' : 'Amex property page'} <span class="ext">↗</span></a>
        ${h.amexPage && link.dated ? `<a class="btn" href="${esc(h.amexPage)}" target="_blank" rel="noopener">Amex page <span class="ext">↗</span></a>` : ''}
        <a class="btn" href="${bookingLink(h)}" target="_blank" rel="noopener">Booking.com · dates filled <span class="ext">↗</span></a>
        ${h.official ? `<a class="btn" href="${esc(h.official)}" target="_blank" rel="noopener">Hotel site <span class="ext">↗</span></a>` : ''}
        <a class="btn" href="${mapsLink(h)}" target="_blank" rel="noopener">Google Maps <span class="ext">↗</span></a>
      </div>

      ${link.dated ? `<div class="note good">Dates fill in automatically for this hotel on Amex Travel (hotel id ${esc(ov.amexHotelId || extractAmexId(ov.amexUrl) || '')}). <button type="button" class="btn sm quiet" data-act="clear-amex">Reset link</button></div>` : `
      <div class="setup"><strong>One-time setup for a date-filled Amex link</strong>
        <ol><li>Open the <a href="${esc(h.amexPage || AMEX_SEARCH)}" target="_blank" rel="noopener">Amex page</a>, pick 1–6 May 2027 once and press <em>Check availability</em>.</li><li>Copy that page’s address and paste it below. The app keeps Amex’s hotel id and rebuilds the link with your dates from then on.</li></ol>
        <input class="input" style="width:100%;margin-top:8px" data-field="amexUrl" placeholder="https://www.amextravel.com/hotel/…" value="${esc(ov.amexUrl || '')}" aria-label="Amex link for this hotel">
      </div>`}

      <div><div class="eyebrow" style="margin-bottom:6px">${h.program === 'FHR' ? 'FHR benefits' : 'Hotel Collection benefits'}</div>${benefitsHTML(h.program)}</div>

      <div class="row"><button type="button" class="btn" data-act="plan">Use in the plan</button><button type="button" class="btn quiet" data-act="hide">${ov.hidden ? 'Unhide hotel' : 'Hide hotel'}</button>${h.custom ? `<button type="button" class="btn quiet danger" data-act="remove">Remove hotel</button>` : ''}</div>

      <label class="field"><span>Your notes</span><textarea class="input" data-field="note" rows="2" style="min-height:60px;font-family:inherit;font-size:14px" placeholder="Room type to ask for, who liked it, offers seen…">${esc(ov.note || '')}</textarea></label>

      <details><summary class="small">Photo</summary><div class="stack" style="margin-top:8px">
        ${store.assets ? `<label class="btn sm" style="align-self:flex-start">Upload a photo<input type="file" accept="image/*" data-field="photoFile" hidden></label>` : ''}
        <label class="field"><span>Photo URL${store.mode === 'db' ? ' (external images may not load inside this page; uploading works)' : ''}</span><input class="input" data-field="photoUrl" placeholder="https://…jpg" value="${esc(ov.photoUrl || '')}"></label>
        ${ov.photoUrl || ov.photoAsset ? `<button type="button" class="btn sm quiet" data-act="reset-photo" style="align-self:flex-start">Back to the default photo</button>` : ''}
        ${credit ? `<div class="tiny muted">${credit}</div>` : ''}
      </div></details>

      ${list.length ? `<details><summary class="small">Price log (${list.length})</summary><div class="hist" style="margin-top:8px">${list.slice().reverse().map((e, i) => `<div class="line"><span class="num">${money(e.usd)}</span><span class="when">${new Date(e.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><span class="src">${esc(e.src)}${e.kind === 'total' ? ' · total ÷ nights' : ''}${e.cur === 'THB' ? ` · ฿${Math.round(e.amt).toLocaleString('en-US')}` : ''}${e.note ? ' · ' + esc(e.note) : ''}</span><button type="button" class="btn sm quiet del" data-act="del-entry" data-i="${list.length - 1 - i}" aria-label="Delete entry">✕</button></div>`).join('')}</div></details>` : ''}
    </div>`;
}

/* ---------------- plan ---------------- */
function segColor(i) { return SEG_COLORS[i % SEG_COLORS.length]; }
function defaultPlanHotel() { const s = allHotels().filter((h) => h.ov.star && !h.ov.hidden); return s.length ? s[0].id : null; }
function planSegments() {
  const N = nights();
  let segs = state.plan.segments;
  if (!Array.isArray(segs) || !segs.length || segs.reduce((a, s) => a + (Number(s.nights) || 0), 0) !== N) {
    segs = [{ nights: N, hotelId: defaultPlanHotel(), creditId: (S().credits[0] || {}).id || null, rate: '' }];
  }
  return segs;
}
function segRate(seg) {
  if (seg.rate !== '' && seg.rate != null && isFinite(Number(seg.rate))) return Number(seg.rate);
  const l = seg.hotelId ? latest(seg.hotelId) : null;
  return l ? l.usd : null;
}
function computePlan(segs) {
  const credits = S().credits.map((c) => ({ ...c, amount: Number(c.amount) || 0, remaining: Number(c.amount) || 0, used: 0 }));
  let start = S().checkin;
  const rows = segs.map((seg, i) => {
    const h = seg.hotelId ? hotelById(seg.hotelId) : null;
    const rate = segRate(seg);
    const cost = rate != null ? rate * seg.nights : null;
    const eligible = h ? (h.program === 'FHR' || seg.nights >= 2) : false;
    const c = credits.find((x) => x.id === seg.creditId) || null;
    let credit = 0;
    if (c && cost != null && eligible) { credit = Math.min(c.remaining, cost); c.remaining -= credit; c.used += credit; }
    const row = { i, seg, h, rate, cost, eligible, credit, net: cost != null ? cost - credit : null, c, start, end: dateAdd(start, seg.nights), key: `${start}|${seg.hotelId || ''}` };
    start = row.end;
    return row;
  });
  return { rows, credits };
}
function renderCredits() {
  const t = $('#credits');
  t.innerHTML = `<thead><tr><th>Credit</th><th>Amount</th><th>Charge from</th><th>Charge by</th><th></th></tr></thead><tbody>${S().credits.map((c, i) => `<tr data-ci="${i}">
    <td><input class="input" data-ck="label" value="${esc(c.label)}" aria-label="Credit name"></td>
    <td><input class="input mono short" data-ck="amount" type="number" min="0" step="50" value="${esc(c.amount)}" aria-label="Amount"></td>
    <td><input class="input date" data-ck="from" type="date" value="${esc(c.from || '')}" aria-label="Window opens"></td>
    <td><input class="input date" data-ck="to" type="date" value="${esc(c.to || '')}" aria-label="Charge by"></td>
    <td><button type="button" class="btn sm quiet" data-act="del-credit" aria-label="Remove credit">✕</button></td></tr>`).join('')}</tbody>`;
}
function renderPlan() {
  renderCredits();
  const segs = planSegments();
  const { rows, credits } = computePlan(segs);
  const N = nights();
  const hotels = allHotels().filter((h) => !h.ov.hidden || segs.some((s) => s.hotelId === h.id));
  // night strip
  const nightsEl = $('#nights'); nightsEl.style.setProperty('--n', N);
  let html = ''; let segIdx = 0, left = rows[0] ? rows[0].seg.nights : N;
  for (let k = 0; k < N; k++) {
    const date = dateAdd(S().checkin, k);
    const isBoundary = left === 1 && k < N - 1;
    html += `<div class="night" style="--seg:${segColor(segIdx)}"><div class="w">${fmtDate(date, { weekday: 'short' })}</div><div class="d">${fmtDate(date, { day: 'numeric' })}</div><div class="tiny muted">${fmtDate(date, { month: 'short' })}</div><span class="bar"></span>${k < N - 1 ? `<button type="button" class="cut${isBoundary ? ' on' : ''}" data-act="cut" data-k="${k}" title="${isBoundary ? 'Merge these bookings' : 'Split here into separate bookings'}" aria-label="Split after night ${k + 1}">${isBoundary ? '|' : '+'}</button>` : ''}</div>`;
    left--; if (left === 0 && rows[segIdx + 1]) { segIdx++; left = rows[segIdx].seg.nights; }
  }
  nightsEl.innerHTML = html;
  const hotelOpts = (sel) => `<option value="">— choose a hotel —</option>${hotels.map((h) => `<option value="${h.id}"${h.id === sel ? ' selected' : ''}>${esc(h.name)} (${h.program})</option>`).join('')}`;
  const creditOpts = (sel) => `<option value="">no credit</option>${S().credits.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}`;
  $('#segs').innerHTML = rows.map((r) => {
    const lp = r.h ? latest(r.h.id) : null;
    const booked = !!state.plan.booked[r.key];
    const win = r.c ? `${r.c.from ? fmtDate(r.c.from, { month: 'short', day: 'numeric', year: 'numeric' }) : '…'} – ${r.c.to ? fmtDate(r.c.to, { month: 'short', day: 'numeric', year: 'numeric' }) : '…'}` : '';
    const winState = r.c && r.c.to && r.c.to < todayISO() ? '<span class="tag bad">window closed</span>' : r.c && r.c.from && r.c.from > todayISO() ? `<span class="tag neutral">opens ${fmtDate(r.c.from)}</span>` : r.c ? '<span class="tag good">open now</span>' : '';
    return `<div class="card segcard" style="--seg:${segColor(r.i)}" data-si="${r.i}"><div class="pad">
      <div class="head"><h3>${fmtDate(r.start, { weekday: 'short', month: 'short', day: 'numeric' })} → ${fmtDate(r.end, { weekday: 'short', month: 'short', day: 'numeric' })}</h3><span class="tag neutral">${r.seg.nights} night${r.seg.nights > 1 ? 's' : ''}</span>${r.h ? `<span class="tag ${r.h.program}">${r.h.program}</span>` : ''}<span class="spacer"></span><label class="check small"><input type="checkbox" data-sk="booked"${booked ? ' checked' : ''}> booked</label></div>
      <div class="row">
        <select class="input" data-sk="hotelId" style="flex:2;min-width:180px">${hotelOpts(r.seg.hotelId)}</select>
        <select class="input" data-sk="creditId" style="flex:1;min-width:150px">${creditOpts(r.seg.creditId)}</select>
        <input class="input mono" data-sk="rate" type="number" min="0" step="1" placeholder="${lp ? Math.round(lp.usd) + ' logged' : 'USD / night'}" value="${r.seg.rate !== '' && r.seg.rate != null ? esc(r.seg.rate) : ''}" style="width:120px" aria-label="Nightly rate override in USD">
      </div>
      <div class="sums">
        <div class="sum"><div class="k">Cost</div><div class="v">${r.cost != null ? money(r.cost) : '—'}</div></div>
        <div class="sum${r.credit ? ' good' : ''}"><div class="k">Credit</div><div class="v">${r.cost != null ? '− ' + money(r.credit) : '—'}</div></div>
        <div class="sum accent"><div class="k">You pay</div><div class="v">${r.net != null ? money(r.net) : '—'}</div></div>
      </div>
      ${r.c ? `<div class="tiny muted">Charge this booking to <strong>${esc(r.c.label)}</strong> between ${win}. ${winState}</div>` : ''}
      ${r.h && !r.eligible ? `<div class="note warn">Hotel Collection bookings need at least 2 nights to earn the Platinum credit and the $100 property credit. Merge this night into a neighbour or pick an FHR hotel.</div>` : ''}
      ${r.c && r.cost != null && r.eligible && r.credit < r.c.amount && r.credit === r.cost ? `<div class="tiny muted">Only ${money(r.credit)} of this credit is used; the remaining ${money(r.c.amount - r.c.used)} can go on another booking charged to the same card in the same half-year.</div>` : ''}
    </div></div>`;
  }).join('');
  const tot = rows.reduce((a, r) => ({ cost: a.cost + (r.cost || 0), credit: a.credit + r.credit, net: a.net + (r.net || 0), known: a.known && r.cost != null }), { cost: 0, credit: 0, net: 0, known: true });
  $('#totals').innerHTML = `<div class="sum"><div class="k">${N} nights</div><div class="v">${tot.known ? money(tot.cost) : '—'}</div></div><div class="sum good"><div class="k">Credits used</div><div class="v">− ${money(tot.credit)}</div></div><div class="sum accent"><div class="k">You pay</div><div class="v">${tot.known ? money(tot.net) : '—'}</div></div><div class="sum"><div class="k">Per night, net</div><div class="v">${tot.known ? money(tot.net / N) : '—'}</div></div>`;
  const warns = [];
  const unused = credits.filter((c) => c.used === 0);
  if (unused.length) warns.push(`<div class="note">Not used yet: ${unused.map((c) => esc(c.label)).join(', ')} (${money(unused.reduce((a, c) => a + c.amount, 0))} on the table).</div>`);
  for (let i = 1; i < rows.length; i++) if (rows[i].h && rows[i - 1].h && rows[i].h.id === rows[i - 1].h.id) { warns.push(`<div class="note warn">Back-to-back bookings at the same hotel count as one stay for the on-property perks, so expect one $100 credit and one upgrade for ${esc(rows[i].h.name)}, not one per booking. The Platinum statement credits are per charge and still apply to each booking.</div>`); break; }
  if (rows.some((r) => r.h && r.cost == null)) warns.push(`<div class="note">Log a price for each hotel (or type a rate) to see costs.</div>`);
  const dup = {}; rows.forEach((r) => { if (r.c) dup[r.c.id] = (dup[r.c.id] || 0) + 1; });
  warns.push(`<div class="tiny muted">Rules of thumb: prepaid “Pay Now” rates only; the half-year is set by the date Amex charges the card; a refund that takes a booking under $300 can claw the credit back; authorised-user cards do not add a second credit, separate card accounts do.</div>`);
  $('#plan-warnings').innerHTML = warns.join('');
  // suggest box
  const sh = $('#sug-hotel'); const cur = sh.value;
  sh.innerHTML = hotelOpts(cur || defaultPlanHotel() || (rows[0] && rows[0].seg.hotelId) || '');
  if (!$('#sug-rate').value) { const l = sh.value ? latest(sh.value) : null; $('#sug-rate').placeholder = l ? `${Math.round(l.usd)} (logged)` : 'USD / night'; }
}
function partitions(n) {
  const out = []; const rec = (rem, max, cur) => { if (rem === 0) { out.push(cur.slice()); return; } for (let p = Math.min(rem, max); p >= 1; p--) { cur.push(p); rec(rem - p, p, cur); cur.pop(); } };
  rec(n, n, []); return out;
}
function suggestSplits(rate, program, N, credits) {
  const res = partitions(N).map((parts) => {
    const cs = credits.map((c) => ({ id: c.id, label: c.label, remaining: Number(c.amount) || 0 }));
    const segs = parts.map((n) => ({ nights: n, cost: rate * n, eligible: program === 'FHR' || n >= 2, creditId: null, credit: 0 }));
    // distinct credits first for the largest bookings, then spread leftovers
    segs.filter((s) => s.eligible).forEach((s, i) => { if (i < cs.length) { const c = cs[i]; s.creditId = c.id; s.credit = Math.min(c.remaining, s.cost); c.remaining -= s.credit; } });
    segs.filter((s) => s.eligible && !s.creditId).forEach((s) => { const c = cs.slice().sort((a, b) => b.remaining - a.remaining)[0]; if (c && c.remaining > 0) { s.creditId = c.id; s.credit = Math.min(c.remaining, s.cost); c.remaining -= s.credit; } });
    const credit = segs.reduce((a, s) => a + s.credit, 0);
    return { parts, segs, credit, net: rate * N - credit, bookings: parts.length };
  });
  res.sort((a, b) => b.credit - a.credit || a.bookings - b.bookings);
  return res;
}
function renderSuggestions() {
  const hid = $('#sug-hotel').value; const h = hid ? hotelById(hid) : null;
  let rate = Number($('#sug-rate').value); if (!rate) { const l = h ? latest(h.id) : null; rate = l ? l.usd : 0; }
  const box = $('#suggest');
  if (!h) { box.innerHTML = `<div class="note">Pick a hotel first.</div>`; return; }
  if (!rate) { box.innerHTML = `<div class="note">Enter a nightly rate (or log a price for ${esc(h.name)}).</div>`; return; }
  const N = nights(); const opts = suggestSplits(rate, h.program, N, S().credits).slice(0, 5);
  box.innerHTML = opts.map((o, i) => `<div class="opt${i === 0 ? ' best' : ''}"><span class="parts">${o.parts.join(' + ')}</span><span class="why">${o.bookings} booking${o.bookings > 1 ? 's' : ''} · credits cover <span class="num">${money(o.credit)}</span> of <span class="num">${money(rate * N)}</span>${h.program === 'THC' && o.parts.some((p) => p === 1) ? ' · 1-night THC bookings earn nothing' : ''}</span><span class="val">${money(o.net)} net</span><button type="button" class="btn sm${i === 0 ? ' primary' : ''}" data-act="apply-split" data-parts="${o.parts.join(',')}" data-credits="${o.segs.map((s) => s.creditId || '').join(',')}">Apply</button></div>`).join('') +
    `<p class="tiny muted" style="margin:0">Assumes ${esc(h.name)} at ${money(rate)}/night for every booking, one room. Perks (breakfast, $100 credit) apply per stay, not per booking, when the bookings are back-to-back.</p>`;
}

/* ---------------- prices: import, compare, export ---------------- */
function parsePaste(text, opts) {
  const hotels = allHotels();
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const aliases = [];
  hotels.forEach((h) => [h.name].concat(h.aliases || []).forEach((a) => { const n = norm(a); if (n.length >= 5) aliases.push({ h, a: n }); }));
  aliases.sort((x, y) => y.a.length - x.a.length);
  const findHotel = (l) => { const n = ' ' + norm(l) + ' '; if (n.length < 7) return null; for (const { h, a } of aliases) if (n.includes(' ' + a + ' ')) return h; return null; };
  const blocks = []; let cur = null; let pendingId = null;
  for (const l of lines) {
    const m = l.match(/amex_hotel_id=(\d+)/); if (m) { pendingId = m[1]; cur = null; continue; }
    const h = findHotel(l);
    if (h && (!cur || cur.h.id !== h.id)) { cur = { h, lines: [l], amexId: pendingId }; pendingId = null; blocks.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  const priceRe = /(US\$|USD|\$|฿|THB)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{1,2})?\s?(USD|THB|baht)\b/gi;
  const EXCLUDE = /credit|value|save|saving|\bwas\b|\boff\b|points|%|resort fee|\btax|deposit|per person|upgrade|dining|spa\b|breakfast/;
  const rows = []; const seen = new Set();
  for (const b of blocks) {
    const bl = b.lines.slice(0, 45);
    const cands = [];
    bl.forEach((line, li) => {
      const next = (bl[li + 1] || '').toLowerCase(), prevLine = (bl[li - 1] || '').toLowerCase();
      let m; priceRe.lastIndex = 0;
      while ((m = priceRe.exec(line))) {
        const sym = (m[1] || m[4] || '').toUpperCase(); const val = Number((m[2] || m[3]).replace(/,/g, ''));
        const cur2 = /THB|฿|BAHT/.test(sym) ? 'THB' : /USD|\$/.test(sym) ? 'USD' : opts.cur;
        const sameBefore = line.slice(0, m.index).toLowerCase(), sameAfter = line.slice(m.index + m[0].length).toLowerCase();
        const lonely = !sameBefore.trim() && !sameAfter.trim();      // the price sits on its own line
        const exclCtx = sameBefore + ' | ' + sameAfter + (lonely ? ' | ' + next : '');
        if (EXCLUDE.test(exclCtx)) continue;
        const kindCtx = sameAfter + ' | ' + (lonely ? next : '');
        let kind = 'unknown';
        if (/per night|\/\s?night|nightly|a night|\/nt\b|avg|average/.test(kindCtx) || /avg|average|\bfrom\b|per night|nightly/.test(sameBefore + ' ' + (lonely ? prevLine : ''))) kind = 'night';
        else if (/total|for \d+ nights|incl|including/.test(kindCtx) || /total/.test(sameBefore + ' ' + (lonely ? prevLine : ''))) kind = 'total';
        cands.push({ val, cur: cur2, kind });
      }
    });
    const body = bl.join('\n');
    const soldOut = /sold out|unavailable|no availability|not available|no rooms/i.test(body);
    const plausible = (c) => (c.cur === 'THB' ? c.val >= 1500 : c.val >= 60);
    const pick = cands.find((c) => c.kind === 'night' && plausible(c)) || cands.find((c) => c.kind === 'unknown' && plausible(c)) || cands.find((c) => c.kind === 'total' && plausible(c)) || null;
    const kind = opts.kind !== 'auto' ? opts.kind : pick ? (pick.kind === 'total' ? 'total' : 'night') : 'night';
    if (seen.has(b.h.id) && !pick) continue;
    if (seen.has(b.h.id)) { const idx = rows.findIndex((r) => r.hotelId === b.h.id); if (rows[idx].amount != null) continue; rows.splice(idx, 1); }
    seen.add(b.h.id);
    rows.push({ hotelId: b.h.id, name: b.h.name, amount: pick ? pick.val : null, cur: pick ? pick.cur : opts.cur, kind, soldOut, amexId: b.amexId, accept: !!pick });
  }
  return rows;
}
function renderPreview(rows) {
  const box = $('#preview');
  if (!rows) { box.innerHTML = ''; return; }
  if (!rows.length) { box.innerHTML = `<div class="note warn">No hotel names recognised in that text. Make sure the results page was fully loaded and copied as text, or log prices from each hotel card instead.</div>`; return; }
  const N = nights();
  box.innerHTML = `<div class="tbl-wrap preview"><table class="tbl"><thead><tr><th></th><th>Hotel</th><th>Price</th><th></th><th></th><th>Amex id</th></tr></thead><tbody>${rows.map((r, i) => `<tr class="${r.accept ? '' : 'dim'}" data-pi="${i}">
      <td><input type="checkbox" data-pk="accept"${r.accept ? ' checked' : ''} aria-label="Save this row"></td>
      <td>${esc(r.name)}${r.soldOut ? ' <span class="tag bad">sold out?</span>' : ''}</td>
      <td><input class="input mono" data-pk="amount" type="number" min="0" step="0.01" value="${r.amount != null ? r.amount : ''}" placeholder="none found"></td>
      <td><select class="input" data-pk="cur"><option${r.cur === 'USD' ? ' selected' : ''}>USD</option><option${r.cur === 'THB' ? ' selected' : ''}>THB</option></select></td>
      <td><select class="input" data-pk="kind"><option value="night"${r.kind === 'night' ? ' selected' : ''}>per night</option><option value="total"${r.kind === 'total' ? ' selected' : ''}>total (${N} n)</option></select></td>
      <td class="tiny muted">${r.amexId ? esc(r.amexId) : '—'}</td></tr>`).join('')}</tbody></table></div>
    <div class="row"><button type="button" class="btn primary" id="btn-save-preview">Save ${rows.filter((r) => r.accept).length} prices</button><span class="small muted">${rows.filter((r) => r.amexId).length ? `${rows.filter((r) => r.amexId).length} Amex hotel ids will be stored for date-filled links.` : ''}</span></div>`;
}
function renderCompare() {
  const list = allHotels().filter((h) => !h.ov.hidden);
  const priced = list.filter((h) => latest(h.id)).sort((a, b) => latest(a.id).usd - latest(b.id).usd);
  const N = nights();
  const bars = $('#bars');
  if (!priced.length) bars.innerHTML = `<div class="note">No prices yet. Paste an Amex results page above, or log prices hotel by hotel.</div>`;
  else {
    const max = Math.max(...priced.map((h) => latest(h.id).usd));
    bars.innerHTML = priced.map((h) => { const l = latest(h.id); return `<div class="bar ${h.program}" data-id="${h.id}" data-tip="${esc(h.name)} · ${money(l.usd)}/night · ${money(l.usd * N)} total · checked ${ago(l.t)}"><span class="n"><button type="button" data-act="open" data-id="${h.id}">${esc(h.name)}</button></span><span class="track"><span class="fill" style="width:${(l.usd / max) * 100}%"></span></span><span class="v">${money(l.usd)}</span></div>`; }).join('');
  }
  const rowsHtml = list.slice().sort((a, b) => { const la = latest(a.id), lb = latest(b.id); return (la ? la.usd : 1e9) - (lb ? lb.usd : 1e9) || a.name.localeCompare(b.name); }).map((h) => {
    const es = entries(h.id); const l = latest(h.id);
    const lo = es.length ? Math.min(...es.map((e) => e.usd)) : null, hi = es.length ? Math.max(...es.map((e) => e.usd)) : null;
    return `<tr class="${l ? '' : 'dim'}"><td><button type="button" class="btn sm quiet" data-act="open" data-id="${h.id}" style="padding-left:0">${esc(h.name)}</button></td><td><span class="tag ${h.program}">${h.program}</span></td><td class="small">${esc(h.area)}</td><td class="r num">${l ? money(l.usd) : '—'}</td><td class="r">${deltaHTML(h.id)}</td><td class="r num small">${lo != null ? money(lo) : '—'}</td><td class="r num small">${hi != null ? money(hi) : '—'}</td><td class="small muted">${l ? ago(l.t) : ''}</td></tr>`;
  }).join('');
  $('#cmp').innerHTML = `<thead><tr><th>Hotel</th><th></th><th>Area</th><th class="r">Latest / night</th><th class="r">Change</th><th class="r">Low</th><th class="r">High</th><th>Checked</th></tr></thead><tbody>${rowsHtml}</tbody>`;
}
function exportCSV() {
  const N = nights(); const rows = [['hotel', 'program', 'area', 'latest_usd_per_night', 'latest_thb_per_night', `total_${N}_nights_usd`, 'checked_at', 'entries', 'low_usd', 'high_usd']];
  allHotels().forEach((h) => { const l = latest(h.id); const es = entries(h.id); rows.push([h.name, h.program, h.area, l ? l.usd : '', l ? Math.round(l.usd * S().thbPerUsd) : '', l ? Math.round(l.usd * N) : '', l ? new Date(l.t).toISOString() : '', es.length, es.length ? Math.min(...es.map((e) => e.usd)) : '', es.length ? Math.max(...es.map((e) => e.usd)) : '']); });
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  store.download(`bangkok-hotels-${todayISO()}.csv`, csv, 'text/csv');
}
function importCSV(text) {
  let n = 0; const hotels = allHotels();
  text.split(/\r?\n/).forEach((line) => {
    const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) return;
    const name = norm(cells[0]); if (!name || /^hotel$/.test(name)) return;
    const h = hotels.find((x) => [x.name].concat(x.aliases || []).some((a) => norm(a) === name)) || hotels.find((x) => norm(x.name).includes(name) || name.includes(norm(x.name)));
    const amount = Number(String(cells[1]).replace(/[^\d.]/g, '')); if (!h || !amount) return;
    const cur = /thb|฿/i.test(cells.join(' ')) ? 'THB' : 'USD'; const kind = /total/i.test(cells.slice(2).join(' ')) ? 'total' : 'night';
    if (logPrice(h.id, { amount, cur, kind, src: 'csv' })) n++;
  });
  return n;
}

/* ---------------- settings & custom hotels ---------------- */
function openSettings() {
  const s = S();
  $('#s-checkin').value = s.checkin; $('#s-checkout').value = s.checkout; $('#s-adults').value = s.adults; $('#s-currency').value = s.currency; $('#s-rate').value = s.thbPerUsd;
  let theme = ''; try { theme = localStorage.getItem('bkk-theme') || ''; } catch (e) { /* ignore */ }
  $('#s-theme').value = theme;
  $('#a-area').innerHTML = AREAS.map((a) => `<option>${a}</option>`).join('');
  $('#about-line').textContent = `${DATA.hotels.length} hotels from Amex property pages, list dated ${DATA.updated || '2026'} · ${store.mode === 'db' ? 'shared store' : 'saved in this browser'}`;
  $('#dlg-settings').showModal();
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  try { if (t) localStorage.setItem('bkk-theme', t); else localStorage.removeItem('bkk-theme'); } catch (e) { /* ignore */ }
}

/* ---------------- events ---------------- */
function wire() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    if (b.dataset.tab === 'map') ui.view = 'map'; else { ui.tab = b.dataset.tab; ui.view = 'side'; }
    saveUI(); renderTabs(); if (ui.tab === 'prices') renderCompare();
  });
  window.addEventListener('resize', debounce(renderTabs, 120));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#dlg-settings').addEventListener('change', (e) => {
    const t = e.target; const s = S();
    if (t.id === 's-checkin' || t.id === 's-checkout') { const ci = $('#s-checkin').value, co = $('#s-checkout').value; if (ci && co && co > ci) { s.checkin = ci; s.checkout = co; store.write('settings'); } }
    if (t.id === 's-adults') { s.adults = Math.max(1, Number(t.value) || 2); store.write('settings'); }
    if (t.id === 's-currency') { s.currency = t.value; store.write('settings'); }
    if (t.id === 's-rate') { const v = Number(t.value); if (v > 1) { s.thbPerUsd = v; store.write('settings'); } }
    if (t.id === 's-theme') applyTheme(t.value);
    scheduleRender();
  });
  $('#btn-add-hotel').addEventListener('click', () => {
    const name = $('#a-name').value.trim(); if (!name) { toast('Give the hotel a name'); return; }
    const ll = $('#a-latlng').value.split(/[ ,]+/).map(Number).filter((n) => isFinite(n));
    const id = 'custom-' + norm(name).replace(/\s+/g, '-').slice(0, 40) + '-' + uid().slice(0, 4);
    state.custom[id] = { id, name, aliases: [], program: $('#a-program').value, brand: '', area: $('#a-area').value, lat: ll.length === 2 ? ll[0] : null, lng: ll.length === 2 ? ll[1] : null, coords: 'user', address: '', official: $('#a-url').value.trim() || null, amexPage: null, wikipedia: null, transit: '', notes: 'Added by you.' };
    store.write('custom', id);
    $('#a-name').value = ''; $('#a-latlng').value = ''; $('#a-url').value = '';
    toast(`${name} added`); scheduleRender();
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Erase every logged price, note, plan and setting? Hotels themselves stay.')) return;
    const ids = new Set([...Object.keys(state.prices), ...Object.keys(state.hotels)]); const customIds = Object.keys(state.custom);
    state.prices = {}; state.hotels = {}; state.custom = {}; state.plan = { segments: null, booked: {} }; state.settings = clone(DEFAULT_SETTINGS);
    if (store.mode === 'db') { ids.forEach((id) => { store.write('prices', id); store.write('hotels', id); }); customIds.forEach((id) => store.write('custom', id)); store.write('plan'); store.write('settings'); }
    else { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }
    $('#dlg-settings').close(); scheduleRender(); toast('Erased');
  });

  // filters
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]'); if (!b) return;
    if (b.dataset.f === 'program') { ui.program[b.dataset.v] = !(ui.program[b.dataset.v] !== false); if (!ui.program.FHR && !ui.program.THC) ui.program[b.dataset.v] = true; }
    if (b.dataset.f === 'starred') ui.starred = !ui.starred;
    saveUI(); renderList(); renderMarkers();
  });
  $('#f-area').addEventListener('change', (e) => { ui.area = e.target.value; saveUI(); renderList(); renderMarkers(); });
  $('#f-sort').addEventListener('change', (e) => { ui.sort = e.target.value; saveUI(); renderList(); });
  $('#f-hidden').addEventListener('change', (e) => { ui.showHidden = e.target.checked; saveUI(); renderList(); renderMarkers(); });

  // list
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const card = e.target.closest('.hcard'); if (!card) return; const id = card.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') openHotel(id);
    else if (act === 'star') { setOverride(id, { star: !(state.hotels[id] || {}).star }); scheduleRender(); }
    else if (act === 'quick') { const q = $('[data-quick]', card); q.hidden = !q.hidden; if (!q.hidden) $('input', q).focus(); }
    else if (act === 'quick-save') { const q = $('[data-quick]', card); const v = Number($('input', q).value); if (logPrice(id, { amount: v, cur: S().currency, kind: 'night', src: 'manual' })) { toast('Price logged'); scheduleRender(); } else toast('Enter a nightly rate first'); }
    else if (!e.target.closest('a, input, button')) openHotel(id);
  });
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-quick] input')) { e.preventDefault(); $('[data-act="quick-save"]', e.target.closest('.hcard')).click(); } });
  list.addEventListener('mouseover', (e) => { const c = e.target.closest('.hcard'); if (c) setHover(c.dataset.id); });
  list.addEventListener('mouseleave', () => setHover(null));

  // drawer
  const drawer = $('#drawer');
  drawer.addEventListener('click', async (e) => {
    const id = ui.selected; if (!id) return;
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'close') closeDrawer();
    else if (act === 'star') { setOverride(id, { star: !(state.hotels[id] || {}).star }); scheduleRender(); }
    else if (act === 'hide') { setOverride(id, { hidden: !(state.hotels[id] || {}).hidden }); scheduleRender(); }
    else if (act === 'remove') { if (confirm('Remove this hotel you added?')) { delete state.custom[id]; store.write('custom', id); closeDrawer(); scheduleRender(); } }
    else if (act === 'clear-amex') { setOverride(id, { amexUrl: null, amexHotelId: null }); scheduleRender(); }
    else if (act === 'reset-photo') { setOverride(id, { photoUrl: null, photoAsset: null }); scheduleRender(); }
    else if (act === 'del-entry') { const i = Number(e.target.closest('[data-i]').dataset.i); const es = entries(id).slice(); es.splice(i, 1); if (es.length) state.prices[id] = es; else delete state.prices[id]; store.write('prices', id); scheduleRender(); }
    else if (act === 'plan') { const segs = planSegments().map((s) => ({ ...s, hotelId: id })); state.plan.segments = segs; store.write('plan'); ui.tab = 'plan'; ui.view = 'side'; saveUI(); closeDrawer(); scheduleRender(); toast('Plan updated'); }
  });
  drawer.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form="log"]'); if (!f) return; e.preventDefault();
    const fd = new FormData(f);
    if (logPrice(ui.selected, { amount: fd.get('amount'), cur: fd.get('cur'), kind: fd.get('kind'), src: 'manual', note: fd.get('note') })) { toast('Price logged'); scheduleRender(); } else toast('Enter a positive amount');
  });
  drawer.addEventListener('change', async (e) => {
    const id = ui.selected; if (!id) return; const f = e.target.dataset.field; if (!f) return;
    if (f === 'note') setOverride(id, { note: e.target.value.trim() });
    if (f === 'photoUrl') setOverride(id, { photoUrl: e.target.value.trim(), photoAsset: null });
    if (f === 'amexUrl') { const v = e.target.value.trim(); const aid = extractAmexId(v); setOverride(id, { amexUrl: v || null, amexHotelId: aid || null }); toast(aid ? `Amex hotel id ${aid} saved — links now carry your dates` : v ? 'Saved. No hotel id in that link yet; use the Check availability page address.' : 'Cleared'); }
    if (f === 'photoFile' && e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      try {
        const blob = await shrinkImage(file);
        if (store.assets) { const r = await store.assets.upload(blob, { type: 'image/jpeg' }); setOverride(id, { photoAsset: r.id, photoUrl: null }); toast('Photo uploaded'); }
        else { const dataUrl = await blobToDataURL(blob); setOverride(id, { photoUrl: dataUrl, photoAsset: null }); toast('Photo saved in this browser'); }
      } catch (err) { console.warn(err); toast('Could not add that photo' + (err && err.code ? ` (${err.code})` : '')); }
    }
    scheduleRender();
  });
  drawer.addEventListener('mousemove', (e) => {
    const svg = e.target.closest('#chart'); const tip = $('#tip');
    if (!svg || !chartPts.length) { tip.hidden = true; return; }
    const r = svg.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 520;
    let best = chartPts[0]; chartPts.forEach((p) => { if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p; });
    $('#cross', svg).setAttribute('x1', best.x); $('#cross', svg).setAttribute('x2', best.x);
    tip.innerHTML = `<span class="num">${money(best.e.usd)}</span> per night<br>${new Date(best.e.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${best.e.note ? '<br>' + esc(best.e.note) : ''}`;
    tip.hidden = false; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 40) + 'px';
  });
  drawer.addEventListener('mouseleave', () => { $('#tip').hidden = true; const c = $('#cross'); if (c) { c.setAttribute('x1', -10); c.setAttribute('x2', -10); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.selected && !$('#dlg-settings').open) closeDrawer(); });

  // plan
  const plan = $('#tab-plan');
  plan.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act;
    if (act === 'cut') {
      const k = Number(b.dataset.k); const segs = planSegments(); const bounds = new Set(); let acc = 0;
      segs.slice(0, -1).forEach((s) => { acc += s.nights; bounds.add(acc - 1); });
      if (bounds.has(k)) bounds.delete(k); else bounds.add(k);
      const cuts = [...bounds].sort((a, b2) => a - b2); const N = nights(); const out = []; let start = 0; let si = 0; let nightIdx = 0;
      const owner = []; segs.forEach((s, i) => { for (let j = 0; j < s.nights; j++) owner.push(i); });
      const used = new Set(segs.map((s) => s.creditId).filter(Boolean));
      [...cuts, N - 1].forEach((c) => { const n = c - start + 1; const src = segs[owner[start]]; let creditId = src.creditId; if (out.some((o) => o.creditId === creditId && creditId)) { const free = S().credits.find((cr) => !used.has(cr.id) && !out.some((o) => o.creditId === cr.id)); creditId = free ? free.id : ''; if (free) used.add(free.id); } out.push({ nights: n, hotelId: src.hotelId, creditId, rate: src.rate || '' }); start = c + 1; si++; nightIdx += n; });
      state.plan.segments = out; store.write('plan'); renderPlan();
    } else if (act === 'del-credit') {
      const i = Number(b.closest('tr').dataset.ci); if (S().credits.length <= 1) return; S().credits.splice(i, 1); store.write('settings'); renderPlan();
    } else if (act === 'apply-split') {
      const parts = b.dataset.parts.split(',').map(Number); const creds = b.dataset.credits.split(','); const hid = $('#sug-hotel').value; const rate = $('#sug-rate').value;
      state.plan.segments = parts.map((n, i) => ({ nights: n, hotelId: hid, creditId: creds[i] || '', rate: rate || '' })); store.write('plan'); renderPlan(); toast('Split applied'); window.scrollTo({ top: 0 }); $('#segs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  plan.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ck) { const i = Number(t.closest('tr').dataset.ci); const c = S().credits[i]; if (!c) return; c[t.dataset.ck] = t.dataset.ck === 'amount' ? Number(t.value) || 0 : t.value; store.write('settings'); renderPlan(); return; }
    if (t.dataset.sk) {
      const i = Number(t.closest('[data-si]').dataset.si); const segs = planSegments().map((s) => ({ ...s })); const seg = segs[i]; if (!seg) return;
      if (t.dataset.sk === 'booked') { const { rows } = computePlan(segs); const key = rows[i].key; if (t.checked) state.plan.booked[key] = true; else delete state.plan.booked[key]; }
      else seg[t.dataset.sk] = t.value;
      state.plan.segments = segs; store.write('plan'); renderPlan(); return;
    }
    if (t.id === 'sug-hotel') { $('#sug-rate').value = ''; renderPlan(); renderSuggestions(); }
  });
  $('#btn-add-credit').addEventListener('click', () => { S().credits.push({ id: 'c' + uid(), label: 'Another card · Jan–Jun 2027', amount: 300, from: '2027-01-01', to: '2027-06-30' }); store.write('settings'); renderPlan(); });
  $('#btn-plan-reset').addEventListener('click', () => { state.plan = { segments: null, booked: {} }; store.write('plan'); renderPlan(); });
  $('#btn-suggest').addEventListener('click', renderSuggestions);

  // prices
  $('#btn-parse').addEventListener('click', () => { ui.previewRows = parsePaste($('#paste').value, { kind: $('#paste-kind').value, cur: $('#paste-cur').value }); renderPreview(ui.previewRows); });
  const prices = $('#tab-prices');
  prices.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset.pk || !ui.previewRows) return; const r = ui.previewRows[Number(t.closest('tr').dataset.pi)]; if (!r) return;
    if (t.dataset.pk === 'accept') { r.accept = t.checked; t.closest('tr').classList.toggle('dim', !r.accept); }
    if (t.dataset.pk === 'amount') { r.amount = t.value === '' ? null : Number(t.value); }
    if (t.dataset.pk === 'cur') r.cur = t.value;
    if (t.dataset.pk === 'kind') r.kind = t.value;
    const btn = $('#btn-save-preview'); if (btn) btn.textContent = `Save ${ui.previewRows.filter((x) => x.accept).length} prices`;
  });
  prices.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'btn-save-preview' && ui.previewRows) {
      let n = 0, ids = 0;
      ui.previewRows.forEach((r) => { if (r.amexId && !(state.hotels[r.hotelId] || {}).amexHotelId) { setOverride(r.hotelId, { amexHotelId: r.amexId }); ids++; } if (r.accept && r.amount) { if (logPrice(r.hotelId, { amount: r.amount, cur: r.cur, kind: r.kind, src: 'paste' })) n++; } });
      toast(`${n} prices saved${ids ? `, ${ids} Amex ids stored` : ''}`); ui.previewRows = null; renderPreview(null); $('#paste').value = ''; scheduleRender();
    }
    if (b.dataset.act === 'open' && b.dataset.id) openHotel(b.dataset.id);
  });
  prices.addEventListener('mousemove', (e) => { const bar = e.target.closest('.bar'); const tip = $('#tip'); if (!bar) { if (!e.target.closest('#chart')) tip.hidden = true; return; } tip.textContent = bar.dataset.tip; tip.hidden = false; tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 36) + 'px'; });
  prices.addEventListener('mouseleave', () => { $('#tip').hidden = true; });
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#btn-export-json').addEventListener('click', () => store.download(`bangkok-hotel-ledger-backup-${todayISO()}.json`, JSON.stringify({ version: 1, exported: new Date().toISOString(), ...state }, null, 1), 'application/json'));
  $('#file-json').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const obj = JSON.parse(await f.text()); applyState(obj); store.writeAll(); if (store.mode !== 'db') store.persistLocal(); toast('Backup restored'); scheduleRender(); } catch (err) { toast('That file is not a valid backup'); } e.target.value = ''; });
  $('#file-csv').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; const n = importCSV(await f.text()); toast(`${n} prices imported`); scheduleRender(); e.target.value = ''; });

  // bookmarklet
  const bm = `javascript:(()=>{const seen=new Set();const out=[];document.querySelectorAll('a[href*="/hotels/"]').forEach(a=>{const m=a.href.match(/\\/hotels\\/(\\d+)/);if(!m||seen.has(m[1]))return;const box=a.closest('li,article,section,[class*="card" i],[class*="result" i],[class*="hotel" i],[class*="property" i]')||a.parentElement;const t=((box&&box.innerText)||a.innerText||'').trim();if(!t)return;seen.add(m[1]);out.push('### amex_hotel_id='+m[1]+'\\n'+t);});const text=out.length?out.join('\\n\\n'):document.body.innerText;navigator.clipboard.writeText(text).then(()=>alert('Copied '+(out.length?out.length+' hotels':'the page text')+' \\u2014 paste it into the Bangkok Hotel Ledger'),()=>prompt('Copy this text:',text));})();`;
  $('#bookmarklet').setAttribute('href', bm); $('#bookmarklet-code').value = bm;
  $('#bookmarklet').addEventListener('click', (e) => { if (!/amextravel|americanexpress/.test(location.hostname)) { e.preventDefault(); navigator.clipboard?.writeText(bm).then(() => toast('Bookmarklet code copied — create a bookmark and paste it as the address'), () => toast('Drag this link to your bookmarks bar')); } });
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const max = 1400; const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.82));
}
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

/* ---------------- boot ---------------- */
function boot() {
  try { applyTheme(localStorage.getItem('bkk-theme') || ''); } catch (e) { /* ignore */ }
  store.loadLocal();
  $('#f-area').innerHTML = `<option value="">All areas</option>` + AREAS.map((a) => `<option>${a}</option>`).join('');
  wire();
  initMap();
  renderAll();
  store.connect();
}
boot();
})();
