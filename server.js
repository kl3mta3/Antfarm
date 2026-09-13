// Static server, keeper sign-in, and the house farm.
//
// Two farms are served from here:
//   /      the house farm — one colony simulated on this server, watched by
//          everyone. Changing it needs a signed-in keeper.
//   /play  "Run your own" — the whole simulation runs in the visitor's browser.
//          Nothing is sent back and no account is needed.
//
// Credentials come from the environment and never reach the browser. The
// browser sends what the keeper typed; the server compares it here. Because the
// house farm's state lives on the server, the token is what it takes to change
// it — there is no hidden button to find in devtools.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

// Read a local .env if there is one. Docker Compose passes it in for the
// container, but a plain `node server.js` wouldn't see it, and silently fell
// back to the development login. Anything already set in the environment wins.
// (.env is excluded from the Docker image, so this only matters when running
// Node directly.)
(function loadDotEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch (e) { return; }
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '') process.env[m[1]] = v;
  }
})();

const PORT = process.env.PORT || 8173;
const PRODUCTION = process.env.NODE_ENV === 'production';
// Outside production a throwaway login keeps local development easy. In
// production there is no fallback: without both variables set, sign-in is
// switched off entirely rather than left open to a guessable default.
const USER = process.env.ANTFARM_USER || (PRODUCTION ? '' : 'keeper');
const PASSWORD = process.env.ANTFARM_PASSWORD || (PRODUCTION ? '' : 'antfarm');
const SIGN_IN_ENABLED = USER !== '' && PASSWORD !== '';
const SESSION_HOURS = Number(process.env.ANTFARM_SESSION_HOURS || 72);
const DATA_FILE = process.env.ANTFARM_DATA || path.join(__dirname, 'data', 'house.json');
const FRAME_HZ = Math.max(2, Math.min(20, Number(process.env.ANTFARM_FRAME_HZ || 10)));
const MAX_VIEWERS = Number(process.env.ANTFARM_MAX_VIEWERS || 200);
const SAVE_SECONDS = Math.max(10, Number(process.env.ANTFARM_SAVE_SECONDS || 60));
// Domains that should get the landing page instead of the farm, e.g.
// "antfarm.lastweeksproject.com". Add the domain to this same deployment and
// list it here; the farm stays on its own domain.
const LANDING_HOSTS = (process.env.ANTFARM_LANDING_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ------------------------------------------------------------------ sessions

// token -> expiry. In-memory on purpose: a restart signs everyone out.
const sessions = new Map();

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_HOURS * 3600e3);
  return token;
}

function validToken(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

// Constant-time compare so the endpoint doesn't leak the answer one byte at a
// time. Hash first: timingSafeEqual needs equal lengths.
function matches(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// A keeper clicking fast is fine; a script hammering the farm is not.
const actionLog = new Map();   // token -> recent action timestamps
function allowAction(token) {
  const now = Date.now();
  const recent = (actionLog.get(token) || []).filter(t => now - t < 10000);
  if (recent.length >= 40) { actionLog.set(token, recent); return false; }
  recent.push(now);
  actionLog.set(token, recent);
  return true;
}

// ------------------------------------------------------------------- helpers

function json(req, res, code, body) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  // Pheromone grids are big and mostly zeros; they compress to almost nothing.
  if (payload.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(code, headers);
    res.end(zlib.gzipSync(payload));
    return;
  }
  res.writeHead(code, headers);
  res.end(payload);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Only the page and its scripts are served. Everything else in this folder —
// the server's own source, the saved farm, Docker files — stays private.
function staticPath(url) {
  if (url === '/' || url === '/play' || url === '/play/') return 'index.html';
  if (url === '/style.css') return 'style.css';
  if (/^\/src\/[a-z0-9_-]+\.(js|css)$/i.test(url)) return url.slice(1);
  if (url === '/README.md') return 'README.md';
  return null;
}

// ---------------------------------------------------------------- house farm

// A fingerprint of the page and scripts this server is handing out. An open
// house-farm page keeps running the code it loaded, and the live stream
// reconnects on its own after a redeploy — so without this a tab left open
// across an update showed the new farm through the old code indefinitely.
// Viewers reload when they reconnect to a different build.
const BUILD = (() => {
  const h = crypto.createHash('sha1');
  const files = ['index.html', 'style.css'].concat(
    fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).sort().map(f => 'src/' + f));
  for (const f of files) {
    try { h.update(f); h.update(fs.readFileSync(path.join(ROOT, f))); } catch (e) { /* missing file: skip */ }
  }
  return h.digest('hex').slice(0, 12);
})();

// The farm runs on its own thread (house-worker.js) so that however busy it
// gets, this thread is free to serve pages, the stream and the health check.
// Everything the routes need from it is asked for by message.
const farm = (() => {
  let worker = null, nextId = 1, restarts = 0, stopping = false, watching = false;
  const pending = new Map();   // request id -> { resolve, reject, timer }
  const api = { onFrame: null };

  function spawn() {
    const born = Date.now();
    worker = new Worker(path.join(ROOT, 'house-worker.js'), {
      workerData: { root: ROOT, dataFile: DATA_FILE, build: BUILD, frameHz: FRAME_HZ, saveSeconds: SAVE_SECONDS },
    });
    worker.postMessage({ type: 'watching', on: watching });
    worker.on('message', m => {
      if (m.type === 'frame') { if (api.onFrame) api.onFrame(m); return; }
      if (m.type !== 'reply') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    worker.on('error', e => console.error('House farm thread crashed: ' + (e.stack || e)));
    worker.on('exit', code => {
      worker = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The house farm is restarting.')); }
      pending.clear();
      if (stopping) return;
      // Start again from the last save. Back off if it keeps falling over.
      if (Date.now() - born > 60000) restarts = 0;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(restarts++, 5));
      console.error('House farm thread stopped (exit ' + code + '); restarting from its last save in ' +
        delay / 1000 + 's.');
      setTimeout(spawn, delay);
    });
  }

  api.call = (method, arg, timeoutMs = 10000) => new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('The house farm is restarting.'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The house farm did not answer in time.'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ type: 'call', id, method, arg });
  });

  api.setWatching = on => {
    if (on === watching) return;
    watching = on;
    if (worker) worker.postMessage({ type: 'watching', on });
  };

  // Save once more before the process goes. Docker allows about ten seconds.
  api.stop = () => {
    stopping = true;
    return api.call('save', 'shutdown', 8000)
      .catch(e => console.error('Could not save the house farm on shutdown: ' + e.message));
  };

  spawn();
  return api;
})();

// Asks the farm, or answers 503 if it can't right now. Returns { value } or null.
async function ask(req, res, method, arg) {
  try { return { value: await farm.call(method, arg) }; }
  catch (e) {
    json(req, res, 503, { error: 'The house farm is not answering right now. Try again in a moment.' });
    return null;
  }
}

const viewers = new Set();

async function openStream(req, res) {
  if (viewers.size >= MAX_VIEWERS) {
    res.writeHead(503, { 'Retry-After': '30', 'Content-Type': 'text/plain' });
    res.end('The house farm has as many watchers as it can take. Try again shortly.');
    return;
  }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);

  const out = gzip ? zlib.createGzip() : null;
  if (out) out.pipe(res);

  const viewer = {
    stale: false, refetching: false, closed: false,
    send(event, data) {
      const chunk = (event ? 'event: ' + event + '\n' : '') + data + '\n\n';
      if (out) { out.write(chunk); out.flush(); } else res.write(chunk);
    },
    backlog() { return res.writableLength + (out ? out.writableLength : 0); },
  };
  req.on('close', () => {
    viewer.closed = true;
    viewers.delete(viewer);
    farm.setWatching(viewers.size > 0);
    if (out) out.destroy();
  });

  // Frames only start reaching this viewer once its keyframe has arrived.
  // Replies and frames come from the farm in the order it sent them, so every
  // frame after this is newer than the keyframe.
  let key;
  try { key = await farm.call('keyframe'); }
  catch (e) {
    // Ending the stream makes the page reconnect a moment later.
    if (!viewer.closed) res.end();
    return;
  }
  if (viewer.closed) return;
  viewer.send('key', 'data: ' + key);
  viewers.add(viewer);
  farm.setWatching(true);
}

// A viewer that fell behind gets a fresh keyframe rather than the deltas it
// missed. Until it arrives, frames for that viewer are skipped.
function refreshViewer(v) {
  v.refetching = true;
  farm.call('keyframe').then(key => {
    v.refetching = false;
    if (v.closed || !v.stale) return;
    v.stale = false;
    v.send('key', 'data: ' + key);
  }, () => { v.refetching = false; });
}

// The farm sends each frame once; every viewer gets the same one.
farm.onFrame = f => {
  const line = 'data: ' + f.data;
  for (const v of viewers) {
    // A viewer that can't keep up misses frames — and with them tile changes —
    // so when it catches up it gets a fresh keyframe instead of a delta.
    if (v.backlog() > 4 * 1024 * 1024) { v.stale = true; continue; }
    if (v.stale) {
      if (f.event === 'key') { v.stale = false; v.send('key', line); }
      else if (!v.refetching) refreshViewer(v);
      continue;
    }
    v.send(f.event, line);
  }
};

// Keep idle proxies from closing the stream.
setInterval(() => { for (const v of viewers) v.send(null, ': ping'); }, 15000);

// The farm saves itself every SAVE_SECONDS on its own thread; this is the
// last save on the way out.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    farm.stop().finally(() => process.exit(0));
  });
}

// -------------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400).end('bad request'); return; }
  const route = url.pathname;

  // Health check for the hosting platform: a plain 200 "OK" as long as the
  // server is up and answering. Checked before anything else, so it works on
  // every domain this server answers to and never touches the simulation.
  if (route === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('OK');
    return;
  }

  if (route === '/api/login' && req.method === 'POST') {
    let creds;
    try { creds = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return json(req, res, 400, { error: 'bad request' }); }

    if (!SIGN_IN_ENABLED) {
      return json(req, res, 503, { error: 'Sign-in is not set up on this server.' });
    }
    const ok = matches(creds.user || '', USER) && matches(creds.password || '', PASSWORD);
    // A small delay blunts brute forcing without needing any state.
    await new Promise(r => setTimeout(r, ok ? 0 : 400));
    if (!ok) return json(req, res, 401, { error: 'Those details were not recognised.' });
    return json(req, res, 200, { token: issueToken(), user: USER });
  }

  if (route === '/api/session') {
    return validToken(bearer(req))
      ? json(req, res, 200, { signedIn: true, user: USER })
      : json(req, res, 200, { signedIn: false });
  }

  if (route === '/api/logout' && req.method === 'POST') {
    sessions.delete(bearer(req));
    return json(req, res, 200, { signedIn: false });
  }

  // ---- house farm: watching is open to anyone ----
  if (route === '/api/house/stream') return openStream(req, res);
  if (route === '/api/house/pheromones') {
    const r = await ask(req, res, 'pheromones');
    return r && json(req, res, 200, r.value);
  }
  if (route === '/api/house/status') {
    // Read-only and already public; the landing page on another domain shows it.
    res.setHeader('Access-Control-Allow-Origin', '*');
    const r = await ask(req, res, 'status');
    return r && json(req, res, 200, r.value);
  }
  if (route === '/api/house/ant') {
    const r = await ask(req, res, 'ant', Number(url.searchParams.get('i')));
    if (!r) return;
    return r.value ? json(req, res, 200, r.value) : json(req, res, 400, { error: 'No such ant.' });
  }

  // ---- house farm: changing it needs a keeper ----
  if (route === '/api/house/act' && req.method === 'POST') {
    const token = bearer(req);
    if (!validToken(token)) return json(req, res, 401, { ok: false, error: 'Sign in to tend the house farm.' });
    if (!allowAction(token)) return json(req, res, 429, { ok: false, error: 'Too many changes at once. Give it a moment.' });
    let action;
    try { action = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return json(req, res, 400, { ok: false, error: 'bad request' }); }
    const r = await ask(req, res, 'act', action || {});
    if (!r) return;
    const { result, status: s } = r.value;
    return json(req, res, result.ok ? 200 : 400,
      Object.assign({}, result, { house: { autoTend: s.autoTend, speed: s.speed, paused: s.paused, name: s.name } }));
  }

  // ---- landing page ----
  // On a landing domain, / is the landing page and anything else is sent to
  // the same path on the farm's own domain... which is the path it asked for,
  // just not here. It's also viewable at /landing on any domain, for checking
  // it before the DNS is pointed.
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if ((LANDING_HOSTS.includes(host) && route === '/') || route === '/landing' || route === '/landing/') {
    return fs.readFile(path.join(ROOT, 'landing', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  // ---- static files ----
  const rel = staticPath(route);
  if (!rel) { res.writeHead(404).end('not found'); return; }
  const file = path.join(ROOT, rel);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log('Antfarm running at http://localhost:' + PORT +
    '  (house farm at /, run-your-own at /play)');
  console.log('House farm saves to ' + DATA_FILE);
  if (!SIGN_IN_ENABLED) {
    console.log('Sign-in is OFF: ANTFARM_USER and ANTFARM_PASSWORD are not set. ' +
                'The house farm can be watched but not tended.');
  } else if (!process.env.ANTFARM_USER || !process.env.ANTFARM_PASSWORD) {
    console.log('WARNING: using the development login (keeper / antfarm). Set ANTFARM_USER and ' +
                'ANTFARM_PASSWORD before exposing this to anyone.');
  }
});
