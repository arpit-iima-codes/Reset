'use strict';
/*
 * Steady — personal server
 * - Serves the web app from ./public
 * - Sends push notifications (fasting milestones, daily reminders / danger-hour alerts)
 * - Stores an optional backup of your app data
 *
 * Single user. Protect it with APP_TOKEN (any long random string).
 * No external services besides Apple/Google push endpoints.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const APP_TOKEN = process.env.APP_TOKEN || '';
const DEFAULT_TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:steady@example.com';

if (!APP_TOKEN) {
  console.warn('[steady] WARNING: APP_TOKEN is not set. Anyone who finds your server can change your reminders. Set APP_TOKEN in production.');
}

/* ---------------- state ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyState() {
  return { vapid: null, subscriptions: [], reminders: [], tz: DEFAULT_TZ, fastJobs: [], sent: {}, backup: null, backupAt: null };
}

let state = emptyState();
try {
  state = Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[steady] Could not read state, starting fresh:', e.message);
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 50);
}

/* ---------------- web push ---------------- */
const vapidPublic = process.env.VAPID_PUBLIC_KEY || (state.vapid && state.vapid.publicKey);
const vapidPrivate = process.env.VAPID_PRIVATE_KEY || (state.vapid && state.vapid.privateKey);
if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(VAPID_SUBJECT, vapidPublic, vapidPrivate);
} else {
  const keys = webpush.generateVAPIDKeys();
  state.vapid = keys;
  saveState();
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  console.log('[steady] Generated new VAPID keys (stored in data/state.json).');
}
const VAPID_PUBLIC = vapidPublic || state.vapid.publicKey;

async function pushAll(payload) {
  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    state.subscriptions.map((sub) => webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' }))
  );
  let ok = 0;
  const dead = new Set();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok++;
    else {
      const code = r.reason && r.reason.statusCode;
      console.error('[steady] push failed', code || '', (r.reason && r.reason.body) || (r.reason && r.reason.message) || '');
      if (code === 404 || code === 410) dead.add(state.subscriptions[i].endpoint);
    }
  });
  if (dead.size) {
    state.subscriptions = state.subscriptions.filter((s) => !dead.has(s.endpoint));
    saveState();
  }
  return { sent: ok, total: results.length };
}

/* ---------------- scheduling ---------------- */
function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const GRACE_MIN = 10; // if the server was briefly asleep, still send within 10 minutes

async function tick() {
  const now = new Date();
  const tz = validTz(state.tz) ? state.tz : DEFAULT_TZ;
  const lp = localParts(now, tz);
  let changed = false;

  // Daily reminders
  for (const r of state.reminders) {
    if (r.enabled === false || !/^\d{2}:\d{2}$/.test(r.time)) continue;
    const [h, m] = r.time.split(':').map(Number);
    const due = h * 60 + m;
    const diff = lp.minutes - due;
    const key = `r:${r.id}:${lp.date}`;
    if (diff >= 0 && diff < GRACE_MIN && !state.sent[key]) {
      state.sent[key] = Date.now();
      changed = true;
      await pushAll({ title: r.title || 'Steady', body: r.body || r.label || 'Check in with yourself.', tab: r.tab || 'sos', tag: `rem-${r.id}` });
    }
  }

  // Fasting milestones (one-off)
  for (const j of state.fastJobs) {
    if (j.sent) continue;
    if (now.getTime() >= j.at) {
      j.sent = true;
      changed = true;
      if (now.getTime() - j.at < 30 * 60e3) {
        await pushAll({ title: j.title, body: j.body, tab: 'fast', tag: 'fast' });
      }
    }
  }
  const before = state.fastJobs.length;
  state.fastJobs = state.fastJobs.filter((j) => !j.sent || Date.now() - j.at < 864e5);
  if (state.fastJobs.length !== before) changed = true;

  // prune old sent keys (> 3 days)
  for (const [k, t] of Object.entries(state.sent)) {
    if (Date.now() - t > 3 * 864e5) { delete state.sent[k]; changed = true; }
  }
  if (changed) saveState();
}
setInterval(() => tick().catch((e) => console.error('[steady] tick error', e)), 20e3);
setTimeout(() => tick().catch(() => {}), 2000);

function buildFastJobs(start, targetHours) {
  const H = 3600e3;
  const msgs = {
    12: ['12 hours done', 'Your body is shifting toward burning fat. Water or black tea helps right now.'],
    14: ['14 hours — strong', 'This is where most people quit. You didn’t.'],
    16: ['16 hours!', 'Deep fast. Every hour from here is a bonus.'],
    18: ['18 hours', 'Impressive. Break your fast gently with protein and vegetables.'],
  };
  const jobs = [];
  for (const h of [12, 14, 16, 18]) {
    if (h < targetHours) jobs.push({ at: start + h * H, title: msgs[h][0], body: msgs[h][1] });
  }
  jobs.push({
    at: start + targetHours * H,
    title: `Goal reached: ${targetHours}h fast ✅`,
    body: 'That’s one more vote for the person you’re becoming. Open the app to log it.',
  });
  // gentle nudge 1 hour before the goal
  if (targetHours >= 13) {
    jobs.push({ at: start + (targetHours - 1) * H, title: 'One hour to go', body: 'Craving? Open SOS and ride the wave for 10 minutes.' });
  }
  return jobs.filter((j) => j.at > Date.now()).map((j) => ({ ...j, sent: false }));
}

/* ---------------- http helpers ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, obj, extraHeaders = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, corsHeaders(), extraHeaders));
  res.end(body);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
}

function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!APP_TOKEN) return true;
  const given = String(req.headers['x-app-token'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(APP_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    headers['Cache-Control'] = (ext === '.html' || rel === '/sw.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=3600';
    if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- routes ---------------- */
async function api(req, res, pathname) {
  const m = req.method;

  if (pathname === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString(), tz: state.tz, subscriptions: state.subscriptions.length });
  if (pathname === '/api/vapid' && m === 'GET') return send(res, 200, { publicKey: VAPID_PUBLIC });

  if (!authorized(req)) return send(res, 401, { error: 'Wrong or missing app token' });

  if (pathname === '/api/auth-check') return send(res, 200, { ok: true });

  if (pathname === '/api/subscribe' && m === 'POST') {
    const { subscription } = await readJson(req);
    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys) return send(res, 400, { error: 'Invalid subscription' });
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
    state.subscriptions.push({ endpoint: subscription.endpoint, keys: subscription.keys });
    saveState();
    return send(res, 200, { ok: true, count: state.subscriptions.length });
  }

  if (pathname === '/api/unsubscribe' && m === 'POST') {
    const { endpoint } = await readJson(req);
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
    saveState();
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/test' && m === 'POST') {
    if (!state.subscriptions.length) return send(res, 409, { error: 'No device subscribed yet. Tap "Turn on notifications" in the app first.' });
    const r = await pushAll({ title: 'Steady is connected ✅', body: 'Notifications from your server are working.', tab: 'fast', tag: 'test' });
    return send(res, 200, r);
  }

  if (pathname === '/api/reminders') {
    if (m === 'GET') return send(res, 200, { reminders: state.reminders, tz: state.tz });
    if (m === 'PUT') {
      const { reminders, tz } = await readJson(req);
      if (!Array.isArray(reminders)) return send(res, 400, { error: 'reminders must be an array' });
      state.reminders = reminders.slice(0, 50).map((r) => ({
        id: String(r.id || crypto.randomUUID()).slice(0, 64),
        time: String(r.time || '').slice(0, 5),
        title: String(r.title || 'Steady').slice(0, 80),
        body: String(r.body || r.label || '').slice(0, 200),
        tab: ['fast', 'sos', 'log', 'wins', 'numbers'].includes(r.tab) ? r.tab : 'sos',
        enabled: r.enabled !== false,
      }));
      if (tz && validTz(tz)) state.tz = tz;
      saveState();
      return send(res, 200, { ok: true, reminders: state.reminders, tz: state.tz });
    }
  }

  if (pathname === '/api/fast') {
    if (m === 'POST') {
      const { start, targetHours } = await readJson(req);
      const s = Number(start), t = Number(targetHours);
      if (!Number.isFinite(s) || !Number.isFinite(t) || t < 1 || t > 72) return send(res, 400, { error: 'Invalid fast' });
      state.fastJobs = buildFastJobs(s, t);
      saveState();
      return send(res, 200, { ok: true, scheduled: state.fastJobs.length });
    }
    if (m === 'DELETE') {
      state.fastJobs = [];
      saveState();
      return send(res, 200, { ok: true });
    }
  }

  /* Apple Watch / Apple Health data, pushed by an iPhone Shortcuts automation */
  if (pathname === '/api/watch') {
    if (m === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const toNum = (v) => {
        if (v == null || v === '') return null;
        const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : null;
      };
      const tz = validTz(state.tz) ? state.tz : DEFAULT_TZ;
      let date = String(body.date || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = localParts(new Date(), tz).date;
      const rec = {};
      const fields = { steps: [0, 200000], activeEnergy: [0, 20000], exerciseMinutes: [0, 1440], restingHR: [20, 250], sleepHours: [0, 24], weight: [20, 400], distanceKm: [0, 500] };
      for (const [k, [lo, hi]] of Object.entries(fields)) {
        const v = toNum(body[k]);
        if (v != null && v >= lo && v <= hi) rec[k] = Math.round(v * 10) / 10;
      }
      if (!Object.keys(rec).length) return send(res, 400, { error: 'No recognised values. Send e.g. {"steps": 8432}' });
      state.watch = state.watch || {};
      state.watch[date] = Object.assign({}, state.watch[date], rec, { at: Date.now() });
      // keep ~120 days
      const keys = Object.keys(state.watch).sort();
      while (keys.length > 120) delete state.watch[keys.shift()];
      saveState();
      return send(res, 200, { ok: true, date, saved: rec });
    }
    if (m === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const since = url.searchParams.get('since') || '0000-00-00';
      const out = {};
      for (const [k, v] of Object.entries(state.watch || {})) if (k >= since) out[k] = v;
      return send(res, 200, { days: out });
    }
  }

  if (pathname === '/api/backup') {
    if (m === 'GET') return send(res, 200, { backup: state.backup, at: state.backupAt });
    if (m === 'PUT') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || !body.data) return send(res, 400, { error: 'Missing data' });
      state.backup = body.data;
      state.backupAt = Date.now();
      saveState();
      return send(res, 200, { ok: true, at: state.backupAt });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[steady] error', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[steady] running on http://${HOST}:${PORT}  (timezone for reminders: ${state.tz})`);
});
