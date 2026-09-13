// Watching the house farm.
//
// At / the colony is simulated on the server and everyone watches the same one.
// This file fills the arrays the renderer and the side panel already read —
// ants, brood, tiles, nests — from what the server streams, so none of the
// drawing code needs to know which mode it is in. At /play nothing here runs
// and the browser simulates its own farm.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, col = AF.colony, NS = AF.nests;
  const A = col.A, B = col.B;

  AF.MODE = /^\/play(\/|$)/.test(location.pathname) ? 'local' : 'house';

  const mirror = {
    controls: { autoTend: true, speed: 1, paused: false },
    connected: false,
    rate: 0,
    onKey: null, onControls: null, onStatus: null,
  };
  AF.mirror = mirror;
  if (AF.MODE !== 'house') return;

  const TAU = Math.PI * 2;
  const tx = new Float32Array(C.MAX_ANTS), ty = new Float32Array(C.MAX_ANTS);
  const seen = new Uint8Array(C.MAX_ANTS);
  let rateTick = -1, rateAt = 0;

  function bytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  function setControls(h) {
    if (!h) return;
    const name = NS.cleanName(h.name);              // the house farm's name, if a keeper gave it one
    const changed = h.autoTend !== mirror.controls.autoTend ||
      h.speed !== mirror.controls.speed || h.paused !== mirror.controls.paused ||
      name !== mirror.controls.name;
    mirror.controls = { autoTend: !!h.autoTend, speed: h.speed, paused: !!h.paused, name };
    if (changed && mirror.onControls) mirror.onControls();
  }

  // ------------------------------------------------------------- keyframes
  // The ordinary save payload, loaded with the same code a page reload uses.
  function applyKey(k) {
    // The server has been updated since this page loaded: reload to pick up
    // the new code, rather than show the new farm through the old scripts.
    if (k.build && mirror.build && k.build !== mirror.build) {
      location.reload();
      return;
    }
    if (k.build) mirror.build = k.build;
    W.loadState(k.world);
    NS.loadState(k.nests);
    col.loadState(k.colony);
    col.corpses.length = 0;
    col.tick = k.tick;
    for (let i = 0; i < C.MAX_ANTS; i++) { tx[i] = A.x[i]; ty[i] = A.y[i]; }
    W.dirty = true;
    setControls(k.house);
    if (mirror.onKey) mirror.onKey();
  }

  // ---------------------------------------------------------------- frames
  function applyNests(list) {
    for (const s of list) {
      const nest = NS.get(s.id);
      if (!nest) continue;
      nest.alive = s.alive !== false;
      nest.name = NS.cleanName(s.name);
      nest.entrance = s.entrance;
      nest.entrances = s.entrances;
      nest.plan = s.plan.map(p => Object.assign({ claims: 0 }, p));
      nest.storeNode = nest.plan[s.storeIdx] || null;
      nest.broodNode = nest.plan[s.broodIdx] || null;
      nest.queenNode = nest.plan[s.queenIdx] || null;
      NS.refreshRoles(nest);        // which rooms the queen, brood and larder are in now
      nest.res.food = s.res.food; nest.res.water = s.res.water; nest.res.biomass = s.res.biomass;
      for (const key in s.stats) nest.stats[key] = s.stats[key];
      if (s.policy) nest.policy = s.policy;
    }
  }

  function applyAnts(b64) {
    const u = bytes(b64);
    const dv = new DataView(u.buffer);
    seen.fill(0);
    for (const n of NS.list) { n.count = 0; n.castePop.fill(0); n.queen = -1; }
    const gliding = performance.now() - (mirror.lastUpdate || 0) < 300;
    let count = 0;
    for (let o = 0; o + 11 <= u.length; o += 11) {
      const i = dv.getUint16(o, true);
      const x = dv.getUint16(o + 2, true) / 16, y = dv.getUint16(o + 4, true) / 16;
      // New ants, and ones that jumped (dropped down a shaft), appear where
      // they are; everyone else glides there between frames. With the page in
      // the background there are no animation frames to glide in, so they
      // simply move — otherwise the arrays sit stale until the next jump.
      if (!gliding || !A.alive[i] || Math.abs(x - A.x[i]) > 6 || Math.abs(y - A.y[i]) > 6) {
        A.x[i] = x; A.y[i] = y;
      }
      tx[i] = x; ty[i] = y;
      A.hd[i] = u[o + 6] / 256 * TAU;
      A.caste[i] = u[o + 7];
      A.nest[i] = u[o + 8];
      A.carry[i] = u[o + 9];
      A.state[i] = u[o + 10];
      A.alive[i] = 1;
      seen[i] = 1;
      count++;
      const nest = NS.get(A.nest[i]);
      if (nest) {
        nest.count++;
        nest.castePop[A.caste[i]]++;
        if (A.caste[i] === AF.CASTE.QUEEN) nest.queen = i;
      }
    }
    for (let i = 0; i < C.MAX_ANTS; i++) if (!seen[i]) A.alive[i] = 0;
    col.count = count;
  }

  function applyBrood(b64) {
    const u = bytes(b64);
    const dv = new DataView(u.buffer);
    B.alive.fill(0);
    for (const n of NS.list) { n.broodCount = 0; n.broodPop = [0, 0, 0]; }
    let count = 0;
    for (let o = 0; o + 12 <= u.length; o += 12) {
      const b = dv.getUint16(o, true);
      B.x[b] = dv.getUint16(o + 2, true) / 16;
      B.y[b] = dv.getUint16(o + 4, true) / 16;
      B.stage[b] = u[o + 6];
      B.nest[b] = u[o + 7];
      B.t[b] = dv.getUint16(o + 8, true);
      B.fed[b] = u[o + 10];
      B.held[b] = u[o + 11] ? 0 : -1;
      B.alive[b] = 1;
      count++;
      const nest = NS.get(B.nest[b]);
      if (nest) { nest.broodCount++; nest.broodPop[B.stage[b]]++; }
    }
    col.broodCount = count;
  }

  function applyFrame(f) {
    if (f.tiles) {
      const t = W.tiles;
      for (let k = 0; k < f.tiles.length; k += 2) t[f.tiles[k]] = f.tiles[k + 1];
      W.dirty = true;
    }
    if (f.surf) {
      for (let x = 0; x < f.surf.length && x < W.surfY.length; x++) W.surfY[x] = f.surf[x];
      W.dirty = true;
    }
    if (f.nests) applyNests(f.nests);
    applyAnts(f.ants);
    applyBrood(f.brood);

    col.piles = f.piles.map(([x, y, amount, seed]) => ({ x, y, amount, max: amount, seed }));
    col.puddles = f.puddles.map(([x, y, amount, max]) => ({ x, y, amount, max }));
    col.corpses.length = 0;
    for (const [x, y, nest, held, age] of f.corpses) col.corpses.push({ x, y, nest, held: held ? 0 : -1, age });
    col.intruders = f.intruders;
    col.tick = f.tick;
    if (f.life != null) col.lifeTick = f.life;
    setControls(f.house);

    const now = performance.now();
    if (rateTick < 0) { rateTick = f.tick; rateAt = now; }
    else if (now - rateAt > 2000) {
      mirror.rate = Math.round((f.tick - rateTick) / ((now - rateAt) / 1000));
      rateTick = f.tick; rateAt = now;
    }
  }

  // ------------------------------------------------------------ connecting
  mirror.connect = function () {
    const es = new EventSource('/api/house/stream');
    es.addEventListener('key', e => {
      applyKey(JSON.parse(e.data));
      const was = mirror.connected;
      mirror.connected = true;
      if (!was && mirror.onStatus) mirror.onStatus(null);
    });
    es.addEventListener('frame', e => {
      if (mirror.connected) applyFrame(JSON.parse(e.data));
    });
    // EventSource reconnects by itself; the server opens with a keyframe.
    es.onerror = () => {
      if (mirror.connected && mirror.onStatus) mirror.onStatus('Lost the house farm. Reconnecting…');
      mirror.connected = false;
      rateTick = -1;
    };
  };

  // --------------------------------------------------- on-demand extras
  // The pheromone overlay and one ant's full record are only fetched while
  // someone is actually looking at them.
  let phAt = 0, phBusy = false, antAt = 0, antBusy = false, detail = null;

  async function fetchPheromones() {
    phBusy = true;
    try {
      const d = await (await fetch('/api/house/pheromones')).json();
      if (d.w === C.W && d.h === C.H) {
        const al = bytes(d.alarm);
        for (let i = 0; i < al.length && i < W.alarm.length; i++) W.alarm[i] = al[i] / 255 * 2.2;
        d.trails.forEach((t, k) => {
          const nest = NS.list[k];
          if (!nest) return;
          const u = bytes(t);
          for (let i = 0; i < u.length && i < nest.trail.length; i++) nest.trail[i] = u[i] / 255 * 2.2;
        });
      }
    } catch (e) { /* try again next second */ }
    phBusy = false;
  }

  async function fetchAnt(i) {
    antBusy = true;
    try {
      const d = await (await fetch('/api/house/ant?i=' + i)).json();
      if (d && d.alive) {
        A.uid[i] = d.uid; A.gen[i] = d.gen;
        A.health[i] = d.health; A.energy[i] = d.energy; A.hydration[i] = d.hydration;
        A.age[i] = d.age; A.life[i] = d.life;
        A.sFood[i] = d.sFood; A.sDirt[i] = d.sDirt; A.sFed[i] = d.sFed;
        A.sHits[i] = d.sHits; A.sDist[i] = d.sDist;
      }
      detail = d;
    } catch (e) { /* keep the last one */ }
    antBusy = false;
  }

  // The inspector asks the simulation for words; here the words come from
  // the server's copy of that ant.
  const mine = i => detail && detail.i === i && detail.alive;
  AF.sim.goalText = i => (mine(i) && detail.goal) || AF.ST_NAME[A.state[i]] || 'Idle';
  AF.sim.thought = i => (mine(i) && detail.thought) || '…';
  col.recentLog = i => (mine(i) && detail.log) || [];
  col.antName = i => (mine(i) && NS.cleanName(detail.name)) || null;
  col.freeSlots = () => C.MAX_ANTS - col.count;

  // Called every animation frame.
  mirror.update = function (now) {
    const dt = Math.min(250, now - (mirror.lastUpdate || now));
    mirror.lastUpdate = now;
    const k = 1 - Math.exp(-dt / 70);
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      A.x[i] += (tx[i] - A.x[i]) * k;
      A.y[i] += (ty[i] - A.y[i]) * k;
    }
    const R = AF.render;
    if (R.showPheromones && !phBusy && now - phAt > 1000) { phAt = now; fetchPheromones(); }
    if (R.selected >= 0 && !antBusy && now - antAt > 500) { antAt = now; fetchAnt(R.selected); }
  };

  // Ask the server to change the farm. It checks the keeper's token.
  mirror.act = async function (action) {
    try {
      const res = await fetch('/api/house/act', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, AF.auth.headers()),
        body: JSON.stringify(action),
      });
      const data = await res.json().catch(() => ({}));
      if (data.house) setControls(data.house);
      return Object.assign({}, data, { ok: res.ok && data.ok !== false, status: res.status });
    } catch (e) {
      return { ok: false, error: 'Could not reach the server.' };
    }
  };
})();
