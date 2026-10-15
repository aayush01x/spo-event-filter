// ==UserScript==
// @name         SPO Event Filter
// @namespace    https://github.com/aayush01x/spo-event-filter
// @version      1.0.0
// @description  Shows only SPO / placement bookings from the LHC booking system, in a readable view
// @match        http://172.26.131.13/LHC
// @match        http://172.26.131.13/LHC/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/aayush01x/spo-event-filter/main/spo-event-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/aayush01x/spo-event-filter/main/spo-event-filter.user.js
// ==/UserScript==

(() => {
  'use strict';

  const BASE = location.origin + '/LHC/';
  const PAST_DAYS = 30;
  const FUTURE_DAYS = 75;
  const STALE_MS = 10 * 60 * 1000;
  const IST = 19800; // UTC+5:30 in seconds
  const CACHE_KEY = 'spoFilter.cache.v1';
  const PREFS_KEY = 'spoFilter.prefs.v1';
  const PLACEMENT_RE = /\bSPO\b|placement|\bPPT\b|recruit|interview|aptitude|online test|\bOA\b|hiring|internship/i;
  const NOISE_RE = /^\s*(break|mid semester recess|gazetted holiday|end semester examination)\b/i;
  const FALLBACK_AREAS = [['5', 'Lecture Hall'], ['6', 'Tutorial Block'], ['7', 'Western Lab'], ['8', 'DJAC'], ['10', 'Printing & Scanning']];

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- dates (everything is IST, the booking system's timezone) ----------

  const pad = n => String(n).padStart(2, '0');
  const istToday = () => new Date(Date.now() + IST * 1000).toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
  const epoch = (iso, sec) => Date.parse(iso + 'T00:00:00Z') + (sec - IST) * 1000;

  function fmtTime(sec) {
    let h = Math.floor(sec / 3600) % 24;
    const m = Math.floor((sec % 3600) / 60), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad(m)} ${ap}`;
  }

  const dayLabel = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  function relDay(iso) {
    const n = dayDiff(iso, istToday());
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    return n > 0 ? `In ${n} days` : `${-n} days ago`;
  }

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  }

  // "8:30 PM", "22:30", "12:30" -> seconds. Without AM/PM it's guessed relative to the start.
  function clock(h, m, ap) {
    h = +h; m = +(m || 0);
    if (h > 24 || m > 59) return null;
    if (ap) h = (h % 12) + (/p/i.test(ap) ? 12 : 0);
    return h * 3600 + m * 60;
  }

  function fixEnd(end, start, hadAmPm) {
    if (end > start) return end;
    if (!hadAmPm && end + 43200 > start) return end + 43200;
    return end + 86400;
  }

  function statedRange(text) {
    const m = [...(text || '').matchAll(/(\d{1,2})[:.](\d{2})\s*([AP]\.?M)?/gi)];
    if (m.length < 2) return null;
    const [a, b] = m;
    const apA = a[3] || b[3], apB = b[3] || a[3];
    const s = clock(a[1], a[2], apA), e = clock(b[1], b[2], apB);
    if (s == null || e == null) return null;
    return { s, e: fixEnd(e, s, !!apB) };
  }

  function tillTime(name, start) {
    const m = name.match(/\btill\s+(\d{1,2})(?:[:.](\d{2}))?\s*([AP]\.?M)?/i);
    if (!m) return null;
    const e = clock(m[1], m[2], m[3]);
    return e == null ? null : fixEnd(e, start, !!m[3]);
  }

  // ---------- fetching + parsing MRBS pages ----------

  const parser = new DOMParser();

  async function getDoc(params) {
    const res = await fetch(BASE + 'index.php?' + new URLSearchParams(params), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parser.parseFromString(await res.text(), 'text/html');
  }

  async function pool(items, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  function readAreas(doc) {
    const opts = [...doc.querySelectorAll('select[name="area"] option')];
    return opts.length ? opts.map(o => [o.value, o.textContent.trim()]) : null;
  }

  function roomOf(th) {
    const c = th.cloneNode(true);
    const cap = c.querySelector('.capacity');
    if (cap) cap.remove();
    return { label: c.textContent.replace(/\s+/g, ''), cap: cap ? cap.textContent.trim() : '' };
  }

  // Month view with view_all=1 has one row per room, one cell per day, and each
  // booking is a div whose flex-grow is its length in slots.
  function parseMonth(doc, area) {
    const table = doc.querySelector('#month_main');
    if (!table) return [];
    const res = +table.dataset.resolution || 1800;
    const slots = JSON.parse(table.querySelector('thead').dataset.slots || '[[]]')[0];
    const dates = [...table.querySelectorAll('thead th[data-date]')].map(th => th.dataset.date);
    const out = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const th = tr.querySelector('th[data-room]');
      if (!th) continue;
      const room = roomOf(th);
      tr.querySelectorAll(':scope > td').forEach((td, i) => {
        const date = dates[i];
        if (!date || !slots[i]) return;
        let t = (slots[i][0] + IST) % 86400;
        for (const div of td.querySelectorAll('div[style*="flex"]')) {
          const n = +((div.getAttribute('style').match(/flex:\s*(\d+)/) || [])[1] || 0);
          if (!/\bfree\b/.test(div.className)) {
            out.push({ area, date, room, start: t, end: t + n * res, name: (div.title || div.textContent).trim(), series: /\bseries\b/.test(div.className) });
          }
          t += n * res;
        }
      });
    }
    return out;
  }

  // Day view cells carry the full booking form text (purpose, POC, ...) in the title.
  function parseDay(doc) {
    return [...doc.querySelectorAll('#day_main td.booked a[data-id]')].map(a => ({
      id: a.dataset.id,
      name: a.textContent.trim().toLowerCase(),
      start: +(a.closest('tr').querySelector('th[data-seconds]') || {}).dataset?.seconds,
      info: a.getAttribute('title') || '',
    }));
  }

  function parseInfo(text) {
    const f = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z][A-Za-z .()\/-]{0,40}?)\s*:\s*(.+?)\s*$/);
      if (m && !(m[1].toLowerCase() in f)) f[m[1].toLowerCase()] = m[2];
    }
    return f;
  }

  function group(rows, areaNames) {
    const map = new Map();
    for (const r of rows) {
      const key = [r.date, r.name.toLowerCase(), r.start, r.end].join('|');
      let g = map.get(key);
      if (!g) {
        g = { key, date: r.date, name: r.name, start: r.start, end: r.end, areas: [], rooms: [], placement: PLACEMENT_RE.test(r.name) };
        map.set(key, g);
      }
      if (!g.areas.includes(r.area)) g.areas.push(r.area);
      if (!g.rooms.some(x => x.label === r.room.label)) g.rooms.push({ ...r.room, area: areaNames[r.area] || '' });
    }
    const out = [...map.values()];
    for (const g of out) {
      g.rooms.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      g.s = g.start;
      g.e = tillTime(g.name, g.start) ?? g.end;
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s || a.name.localeCompare(b.name));
  }

  async function scan(onProgress) {
    const today = istToday(), from = addDays(today, -PAST_DAYS), to = addDays(today, FUTURE_DAYS);
    const areas = readAreas(document) || FALLBACK_AREAS;
    const areaNames = Object.fromEntries(areas);

    const months = [];
    for (let d = from.slice(0, 7) + '-01'; d <= to;) {
      months.push(d);
      const x = new Date(d + 'T00:00:00Z');
      x.setUTCMonth(x.getUTCMonth() + 1);
      d = x.toISOString().slice(0, 10);
    }

    let done = 0, total = areas.length * months.length, failed = 0;
    const tick = () => onProgress(++done, total);

    const monthJobs = areas.flatMap(([id]) => months.map(m => ({ id, m })));
    const rows = (await pool(monthJobs, 4, async j => {
      try { return parseMonth(await getDoc({ view: 'month', view_all: 1, page_date: j.m, area: j.id }), j.id); }
      catch { failed++; return []; }
      finally { tick(); }
    })).flat().filter(r => r.date >= from && r.date <= to && r.name && !NOISE_RE.test(r.name) && (!r.series || PLACEMENT_RE.test(r.name)));

    const events = group(rows, areaNames);

    // Fetch day views only for days that have placement bookings, for the details.
    const placement = events.filter(e => e.placement);
    const dayKeys = [...new Set(placement.flatMap(e => e.areas.map(a => `${a}|${e.date}`)))];
    total += dayKeys.length;
    const dayMap = new Map();
    await pool(dayKeys, 4, async k => {
      const [area, date] = k.split('|');
      try { dayMap.set(k, parseDay(await getDoc({ view: 'day', page_date: date, area }))); }
      catch { failed++; }
      finally { tick(); }
    });

    for (const e of placement) {
      const cells = e.areas.flatMap(a => dayMap.get(`${a}|${e.date}`) || []).filter(c => c.name === e.name.toLowerCase());
      const hit = cells.find(c => c.start === e.start && c.info) || cells.find(c => c.info);
      if (!hit) continue;
      e.info = hit.info;
      const f = parseInfo(hit.info);
      e.purpose = f.purpose || '';
      e.poc = f.poc || f['contact'] || '';
      e.projector = /yes/i.test(f['projector required'] || f.projector || '');
      e.mic = /yes/i.test(f.mic || '');
      const r = statedRange(f.time);
      if (r && Math.abs(r.s - e.start) <= 3 * 3600) { e.s = r.s; e.e = tillTime(e.name, r.s) ?? r.e; }
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
    return { at: Date.now(), events, failed, pages: total };
  }

  // ---------- UI ----------

  const CSS = `
:host {
  all: initial;
  --bg: #f4f5f7; --panel: #ffffff; --text: #15171c; --muted: #646b76; --line: #e3e6eb;
  --accent: #3451d1; --accent-2: #6a4fd8; --accent-soft: #eaeefe;
  --live: #0b8a4a; --live-soft: #ddf3e6; --warn: #9a5b00; --warn-soft: #fff1d9;
  --shadow: 0 1px 2px rgba(16,24,40,.05), 0 2px 6px rgba(16,24,40,.06);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text); font-size: 14px; line-height: 1.45;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #0f1115; --panel: #181b21; --text: #eceef2; --muted: #9aa2ae; --line: #282d36;
    --accent: #8fa2ff; --accent-2: #b39cff; --accent-soft: #1f2647;
    --live: #4ade80; --live-soft: #13301f; --warn: #fbbf24; --warn-soft: #33270d;
    --shadow: 0 1px 2px rgba(0,0,0,.4);
  }
}
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }
[hidden] { display: none !important; }

.fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--accent); color: #fff; border: 0; border-radius: 999px;
  padding: 11px 18px; font-weight: 600; font-size: 14px; cursor: pointer;
  box-shadow: 0 6px 20px rgba(52,81,209,.35);
}
.fab:hover { filter: brightness(1.08); }
.badge { background: #fff; color: #3451d1; border-radius: 999px; min-width: 22px; padding: 1px 7px; font-size: 12px; text-align: center; }

.overlay {
  position: fixed; inset: 0; z-index: 2147483001; overflow-y: auto;
  background: rgba(8,10,14,.55); backdrop-filter: blur(3px);
  display: flex; justify-content: center; align-items: flex-start;
}
.panel {
  width: min(920px, 100%); margin: 32px 16px; background: var(--bg);
  border-radius: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.35); overflow: clip;
}
.top { position: sticky; top: 0; z-index: 3; background: var(--bg); padding: 20px 24px 14px; border-bottom: 1px solid var(--line); }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.sub { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.actions { display: flex; gap: 8px; }
.btn { border: 1px solid var(--line); background: var(--panel); padding: 7px 14px; border-radius: 10px; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: .6; cursor: progress; }
.close { width: 36px; padding: 0; font-size: 20px; line-height: 34px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; }
.seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 11px; background: var(--panel); border: 1px solid var(--line); }
.seg button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--muted); }
.seg button.on { background: var(--accent); color: #fff; }
.search { flex: 1; min-width: 160px; padding: 7px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); font-size: 14px; outline: none; }
.search:focus { border-color: var(--accent); }
.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); cursor: pointer; user-select: none; }
.bar { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; }
.bar .fill { height: 100%; width: 0; background: var(--accent); transition: width .25s; }

.list { padding: 6px 24px 32px; }
.notice { margin: 14px 0 0; padding: 9px 12px; border-radius: 10px; background: var(--warn-soft); color: var(--warn); font-size: 13px; }

.hero {
  margin: 18px 0 6px; padding: 20px 22px; border-radius: 16px; color: #fff;
  background: linear-gradient(135deg, #3451d1, #6a4fd8);
  box-shadow: 0 10px 30px rgba(52,81,209,.25);
}
.eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; opacity: .85; }
.hero h2 { margin: 6px 0 2px; font-size: 24px; line-height: 1.2; letter-spacing: -0.01em; }
.hero .when { font-size: 15px; font-weight: 600; opacity: .95; }
.hero .count { display: inline-block; margin-top: 10px; padding: 3px 10px; border-radius: 999px; background: rgba(255,255,255,.18); font-size: 13px; font-weight: 600; }
.hero .rooms .room { background: rgba(255,255,255,.18); color: #fff; }
.hero .meta, .hero .meta a { color: rgba(255,255,255,.92); }
.hero .tag { border-color: rgba(255,255,255,.35); }
.hero .links a { color: #fff; border-color: rgba(255,255,255,.4); }

.day { display: flex; align-items: baseline; gap: 10px; margin: 26px 0 10px; font-size: 15px; font-weight: 700; }
.day em { font-style: normal; font-weight: 500; font-size: 13px; color: var(--muted); }
.day.today em { color: var(--accent); font-weight: 600; }

.card {
  display: grid; grid-template-columns: 96px 1fr auto; gap: 16px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  padding: 14px 16px; margin-bottom: 10px; box-shadow: var(--shadow);
}
.card.placement { border-left: 4px solid var(--accent); }
.card.live { border-color: var(--live); box-shadow: 0 0 0 3px var(--live-soft); }
.card.past { opacity: .55; }
.time b { display: block; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.time span { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.time small { display: block; color: var(--muted); font-size: 11px; }
.body { min-width: 0; }
.body h3 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.purpose { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.rooms { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.room { padding: 2px 8px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 10px; color: var(--muted); font-size: 13px; }
.meta a { color: var(--text); font-weight: 500; text-decoration: none; }
.meta a:hover { text-decoration: underline; }
.tag { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--accent-soft); color: var(--accent); }
.pill.live { background: var(--live-soft); color: var(--live); }
.pill.live::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.4s infinite; vertical-align: 1px; }
.pill.past { background: var(--line); color: var(--muted); }
.links { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.links a { font-size: 12px; color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-radius: 8px; padding: 3px 9px; white-space: nowrap; }
.links a:hover { color: var(--accent); border-color: var(--accent); }
.hero .links { justify-content: flex-start; margin-top: 14px; }

.empty { text-align: center; padding: 56px 16px; color: var(--muted); }
.empty b { display: block; color: var(--text); font-size: 16px; margin-bottom: 4px; }
.skel { height: 84px; border-radius: 14px; margin: 12px 0; background: linear-gradient(90deg, var(--panel), var(--line), var(--panel)); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
.foot { margin-top: 26px; text-align: center; color: var(--muted); font-size: 12px; }

@keyframes pulse { 50% { opacity: .35; } }
@keyframes shimmer { to { background-position: -200% 0; } }

@media (max-width: 640px) {
  .panel { margin: 0; border-radius: 0; min-height: 100%; }
  .top { padding: 14px 16px 12px; }
  .list { padding: 4px 16px 28px; }
  .card { grid-template-columns: 74px 1fr; gap: 12px; }
  .side { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; }
  .hero h2 { font-size: 20px; }
}
`;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const host = document.createElement('div');
  host.id = 'spo-event-filter';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>${CSS}</style>
<button class="fab" type="button">Placements <span class="badge" hidden></span></button>
<div class="overlay" hidden>
  <div class="panel" role="dialog" aria-modal="true" aria-label="Placement events">
    <header class="top">
      <div class="row">
        <div><h1>Placement events</h1><p class="sub">Loading...</p></div>
        <div class="actions">
          <button class="btn refresh" type="button">Refresh</button>
          <button class="btn close" type="button" aria-label="Close">&times;</button>
        </div>
      </div>
      <div class="controls">
        <div class="seg">
          <button type="button" data-mode="placement">Placement</button>
          <button type="button" data-mode="all">All events</button>
        </div>
        <input class="search" type="search" placeholder="Search  ( / )" aria-label="Search">
        <label class="toggle"><input type="checkbox" class="past"> Show past</label>
      </div>
      <div class="bar"><div class="fill"></div></div>
    </header>
    <main class="list"></main>
  </div>
</div>`;

  const $ = s => root.querySelector(s);
  const ui = { fab: $('.fab'), badge: $('.badge'), overlay: $('.overlay'), sub: $('.sub'), list: $('.list'), refresh: $('.refresh'), search: $('.search'), past: $('.past'), bar: $('.bar'), fill: $('.fill') };

  const prefs = Object.assign({ mode: 'placement', showPast: false }, store.get(PREFS_KEY, {}));
  let data = store.get(CACHE_KEY, null);
  let scanning = null, lastError = '', query = '', timer = null;

  const isOpen = () => !ui.overlay.hidden;

  function setProgress(p) {
    ui.bar.hidden = p == null;
    ui.fill.style.width = `${Math.round((p || 0) * 100)}%`;
  }

  function refresh() {
    if (scanning) return scanning;
    lastError = '';
    setProgress(0.02);
    scanning = scan((d, t) => setProgress(d / t))
      .then(r => { data = r; store.set(CACHE_KEY, r); })
      .catch(err => { lastError = err.message || String(err); })
      .finally(() => { scanning = null; setProgress(null); render(); updateBadge(); });
    render();
    return scanning;
  }

  function status(e, now) {
    const s = epoch(e.date, e.s), en = epoch(e.date, e.e);
    if (now >= en) return { cls: 'past', text: 'Done' };
    if (now >= s) return { cls: 'live', text: 'Live now' };
    const mins = Math.round((s - now) / 60000);
    if (mins < 60) return { cls: '', text: `In ${mins} min` };
    if (mins < 24 * 60) return { cls: '', text: `In ${Math.floor(mins / 60)}h ${mins % 60}m` };
    return { cls: '', text: relDay(e.date) };
  }

  function gcal(e) {
    const stamp = sec => `${addDays(e.date, Math.floor(sec / 86400)).replace(/-/g, '')}T${pad(Math.floor(sec % 86400 / 3600))}${pad(Math.floor(sec % 3600 / 60))}00`;
    const p = new URLSearchParams({
      action: 'TEMPLATE', text: e.name, dates: `${stamp(e.s)}/${stamp(e.e)}`, ctz: 'Asia/Kolkata',
      location: 'LHC ' + e.rooms.map(r => r.label).join(', '), details: e.info || '',
    });
    return 'https://calendar.google.com/calendar/render?' + p;
  }

  function pocHtml(poc) {
    if (!poc) return '';
    const phone = (poc.match(/\+?\d[\d\s-]{8,}\d/) || [''])[0];
    const name = poc.replace(phone, '').replace(/[:\-,|]+\s*$/, '').replace(/^\s*[:\-]\s*/, '').trim();
    const digits = phone.replace(/[^\d+]/g, '');
    const label = [name, digits].filter(Boolean).join(' · ');
    return `<span>POC ${digits ? `<a href="tel:${esc(digits)}">${esc(label)}</a>` : esc(label)}</span>`;
  }

  function roomsHtml(e) {
    return `<div class="rooms">${e.rooms.map(r => `<span class="room" title="${esc([r.area, r.cap && `capacity ${r.cap}`].filter(Boolean).join(', '))}">${esc(r.label)}</span>`).join('')}</div>`;
  }

  function metaHtml(e) {
    const bits = [pocHtml(e.poc)];
    if (e.projector) bits.push('<span class="tag">Projector</span>');
    if (e.mic) bits.push('<span class="tag">Mic</span>');
    const html = bits.filter(Boolean).join('');
    return html ? `<div class="meta">${html}</div>` : '';
  }

  function linksHtml(e) {
    const day = `${BASE}index.php?view=day&page_date=${e.date}&area=${e.areas[0]}`;
    return `<div class="links"><a href="${esc(gcal(e))}" target="_blank" rel="noopener">Add to calendar</a><a href="${esc(day)}">Open in LHC</a></div>`;
  }

  const timeRange = e => `${fmtTime(e.s)} to ${fmtTime(e.e)}${e.e >= 86400 ? ' (next day)' : ''}`;
  const purposeHtml = e => e.purpose && !e.name.toLowerCase().startsWith(e.purpose.toLowerCase()) ? `<p class="purpose">${esc(e.purpose)}</p>` : '';

  function cardHtml(e, now) {
    const st = status(e, now);
    return `
<article class="card ${e.placement ? 'placement' : ''} ${st.cls}">
  <div class="time"><b>${fmtTime(e.s)}</b><span>to ${fmtTime(e.e)}</span>${e.e >= 86400 ? '<small>next day</small>' : ''}</div>
  <div class="body">
    <h3>${esc(e.name)}</h3>
    ${purposeHtml(e)}
    ${roomsHtml(e)}
    ${metaHtml(e)}
  </div>
  <div class="side"><span class="pill ${st.cls}">${esc(st.text)}</span>${linksHtml(e)}</div>
</article>`;
  }

  function heroHtml(e, upcomingCount, now) {
    const st = status(e, now);
    const when = `${dayLabel(e.date)} · ${timeRange(e)}`;
    return `
<section class="hero">
  <div class="eyebrow">${st.cls === 'live' ? 'Happening now' : 'Next up'} · ${esc(st.cls === 'live' ? `ends ${fmtTime(e.e)}` : st.text)}</div>
  <h2>${esc(e.name)}</h2>
  <div class="when">${esc(when)}</div>
  ${purposeHtml(e).replace('class="purpose"', 'class="purpose" style="color:rgba(255,255,255,.85)"')}
  ${roomsHtml(e)}
  ${metaHtml(e)}
  ${linksHtml(e)}
  <div class="count">${upcomingCount} upcoming placement booking${upcomingCount === 1 ? '' : 's'}</div>
</section>`;
  }

  function haystack(e) {
    return [e.name, e.purpose, e.poc, e.date, dayLabel(e.date), ...e.rooms.map(r => r.label)].join(' ').toLowerCase();
  }

  function render() {
    root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === prefs.mode));
    ui.past.checked = prefs.showPast;
    ui.refresh.disabled = !!scanning;
    ui.refresh.textContent = scanning ? 'Scanning...' : 'Refresh';

    if (!data) {
      ui.sub.textContent = scanning ? 'Scanning the booking system...' : 'Not loaded yet';
      ui.list.innerHTML = lastError
        ? `<div class="notice">Could not load bookings: ${esc(lastError)}. Are you on the campus network?</div>`
        : '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      return;
    }

    const now = Date.now();
    ui.sub.textContent = `Updated ${ago(data.at)} · next ${FUTURE_DAYS} days${scanning ? ' · refreshing' : ''}`;

    const upcoming = data.events.filter(e => e.placement && epoch(e.date, e.e) > now);
    let list = data.events.filter(e => prefs.mode === 'all' || e.placement);
    if (!prefs.showPast) list = list.filter(e => epoch(e.date, e.e) > now);
    if (query) list = list.filter(e => haystack(e).includes(query));

    let html = '';
    if (data.failed) html += `<div class="notice">${data.failed} page${data.failed === 1 ? '' : 's'} failed to load, the list may be incomplete. Hit Refresh to retry.</div>`;
    if (lastError) html += `<div class="notice">Refresh failed: ${esc(lastError)}. Showing the last saved results.</div>`;

    const hero = prefs.mode === 'placement' && !query ? upcoming[0] : null;
    if (hero) {
      html += heroHtml(hero, upcoming.length, now);
      list = list.filter(e => e !== hero);
    }

    if (!list.length && !hero) {
      html += query
        ? `<div class="empty"><b>Nothing matches "${esc(query)}"</b>Try a room like L20 or a word like test.</div>`
        : prefs.mode === 'placement'
          ? `<div class="empty"><b>No placement bookings coming up</b>SPO usually books a few days ahead, check back later.</div>`
          : `<div class="empty"><b>No events found</b></div>`;
    }

    let lastDate = '';
    for (const e of list) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        html += `<h2 class="day ${e.date === istToday() ? 'today' : ''}">${esc(dayLabel(e.date))}<em>${esc(relDay(e.date))}</em></h2>`;
      }
      html += cardHtml(e, now);
    }
    html += `<div class="foot">Data from the LHC booking system. Matches SPO, PPT, placement, interview, test-style bookings.</div>`;
    ui.list.innerHTML = html;
  }

  function updateBadge() {
    const n = data ? data.events.filter(e => e.placement && epoch(e.date, e.e) > Date.now()).length : 0;
    ui.badge.hidden = !n;
    ui.badge.textContent = n;
  }

  function open() {
    ui.overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (location.hash !== '#spo') history.replaceState(null, '', '#spo');
    render();
    if (!data || Date.now() - data.at > STALE_MS) refresh();
    clearInterval(timer);
    timer = setInterval(() => isOpen() && render(), 30000);
  }

  function close() {
    ui.overlay.hidden = true;
    document.documentElement.style.overflow = '';
    clearInterval(timer);
    if (location.hash === '#spo') history.replaceState(null, '', location.pathname + location.search);
  }

  ui.fab.addEventListener('click', open);
  $('.close').addEventListener('click', close);
  ui.refresh.addEventListener('click', refresh);
  ui.overlay.addEventListener('click', e => { if (e.target === ui.overlay) close(); });
  root.querySelector('.seg').addEventListener('click', e => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (!mode) return;
    prefs.mode = mode; store.set(PREFS_KEY, prefs); render();
  });
  ui.past.addEventListener('change', () => { prefs.showPast = ui.past.checked; store.set(PREFS_KEY, prefs); render(); });
  ui.search.addEventListener('input', () => { query = ui.search.value.trim().toLowerCase(); render(); });
  document.addEventListener('keydown', e => {
    if (!isOpen()) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.composedPath()[0]?.tagName);
    if (e.key === 'Escape') { if (typing && ui.search.value) { ui.search.value = ''; query = ''; render(); } else close(); }
    else if (e.key === '/' && !typing) { e.preventDefault(); ui.search.focus(); }
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#spo' && !isOpen()) open(); });

  updateBadge();
  if (location.hash === '#spo') open();
})();
