// The house farm: one colony, simulated here on the server, that every visitor
// watches at once.
//
// The simulation files are the same ones the browser runs, loaded into a
// sandbox with a stand-in `window`. Nothing about the ants changes between the
// two modes — only where the ticks happen. Because the state lives here and
// nowhere else, the controls that change it are real controls: a browser can
// only ask, and the server checks the keeper's token before it does anything.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIM_FILES = ['config', 'world', 'nests', 'colony', 'grid', 'ai'];
const TAU = Math.PI * 2;

function createHouse({ root, dataFile, log = console.log }) {
  // ------------------------------------------------------------ the sandbox
  const sandbox = { console, btoa, atob, performance };
  vm.createContext(sandbox);
  vm.runInContext('var window = globalThis;', sandbox);
  for (const f of SIM_FILES) {
    const file = path.join(root, 'src', f + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  const AF = sandbox.AF;
  const C = AF.CFG, W = AF.world, NS = AF.nests, col = AF.colony, sim = AF.sim;
  const A = col.A, B = col.B;

  const house = {
    autoTend: true,
    speed: 1,
    paused: false,
    tickMs: 0,          // rolling cost of one tick, for the health endpoint
    AF,
  };

  // ----------------------------------------------------------- persistence
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (!data || data.v !== 2 || !data.world || !data.nests || !data.colony) throw new Error('old save');
      W.loadState(data.world);
      NS.loadState(data.nests);
      col.loadState(data.colony);
      if (data.house) {
        house.autoTend = data.house.autoTend !== false;
        house.speed = [1, 3, 10].includes(data.house.speed) ? data.house.speed : 1;
        house.paused = !!data.house.paused;
      }
      log('House farm restored: tick ' + col.tick + ', ' + col.count + ' ants.');
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT') log('House farm save unreadable (' + e.message + '); starting fresh.');
      return false;
    }
  }

  house.save = function () {
    const payload = JSON.stringify({
      v: 2, saved: Date.now(),
      world: W.saveState(), nests: NS.saveState(), colony: col.saveState(),
      house: { autoTend: house.autoTend, speed: house.speed, paused: house.paused },
    });
    // Write beside and rename, so a crash mid-write can't leave half a farm.
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, dataFile);
  };

  if (!load()) { W.generate(1); col.reset(1); }

  // -------------------------------------------------------------- tending
  // The same ration the browser's auto-tend hands out: water near each door,
  // food scattered inside the search radius, both scaled to the colony.
  function tend() {
    for (const nest of NS.list) {
      if (!nest.alive || nest.count === 0) continue;
      const range = AF.forageRange(nest);
      const wet = 34;
      const nearWater = () => Math.max(6, Math.min(C.W - 6,
        nest.entrance.x + (Math.random() * 2 - 1) * wet));
      const scatterFood = () => Math.max(6, Math.min(C.W - 6,
        nest.entrance.x + (Math.random() < 0.5 ? -1 : 1) * (16 + Math.random() * range * 0.8)));
      const nearby = (list, reach) => list.reduce((sum, p) =>
        sum + (Math.abs(p.x - nest.entrance.x) < reach ? p.amount : 0), 0);
      const foodWant = 70 + nest.count * 2.6;
      const waterWant = 70 + nest.count * 2.2;
      const load = Math.max(C.PILE_AMOUNT, Math.round(nest.count * 3));
      if (nest.res.food < foodWant && nearby(col.piles, range) < foodWant * 1.5) {
        const x = scatterFood();
        col.addPile(x, W.surfaceAt(x) - 0.6, load);
      }
      if (nest.res.water < waterWant && nearby(col.puddles, wet * 1.6) < waterWant * 1.5) {
        const x = nearWater();
        col.addPuddle(x, W.surfaceAt(x) - 0.4, load);
      }
    }
  }

  // ------------------------------------------------------ real-time loop
  const STEP_MS = 1000 / C.BASE_HZ;
  let last = Date.now(), acc = 0, tendTicks = 0, failures = 0;

  function advance() {
    const now = Date.now();
    acc += Math.min(1000, now - last);
    last = now;
    if (house.paused) { acc = 0; return; }
    let steps = 0;
    const t0 = process.hrtime.bigint();
    let ticks = 0;
    while (acc >= STEP_MS && steps < 40) {
      for (let s = 0; s < house.speed; s++) {
        try {
          sim.tick();
        } catch (e) {
          // One bad tick must not take the farm down for everyone watching.
          if (failures++ < 5) log('House farm tick failed: ' + (e.stack || e));
        }
        ticks++;
        if (++tendTicks >= C.TEND_EVERY) { tendTicks = 0; if (house.autoTend) tend(); }
      }
      acc -= STEP_MS;
      steps++;
    }
    if (acc > STEP_MS * 40) acc = 0;           // fell badly behind: don't try to catch up
    if (ticks) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / ticks;
      house.tickMs = house.tickMs * 0.9 + ms * 0.1;
    }
  }

  // ------------------------------------------------------- what viewers get
  //
  // A keyframe is the ordinary save payload — the viewer loads it with the same
  // code a reload uses. After that come small frames: tiles that changed, and
  // the moving parts packed into bytes. Anything a viewer only needs when it
  // asks (pheromone grids, one ant's full record) is fetched separately.

  let lastTiles = null, lastSurf = null, lastNestSig = '';
  let frameNo = 0;

  function nestSignature() {
    return NS.list.map(n => n.id + ':' + (n.alive ? 1 : 0)).join(',') + '|' + C.W + 'x' + C.H;
  }

  function controls() {
    return { autoTend: house.autoTend, speed: house.speed, paused: house.paused };
  }

  // `broadcast` is a keyframe going to everyone, which resets the baseline the
  // deltas are measured from. A keyframe for one newcomer must not: the
  // viewers already watching would never be sent the tiles that changed in
  // between. (Deltas carry absolute values, so the newcomer can apply the
  // next one on top of its keyframe harmlessly.)
  house.keyframe = function (broadcast) {
    if (broadcast) {
      lastTiles = Uint8Array.from(W.tiles);
      lastSurf = Array.from(W.surfY);
      lastNestSig = nestSignature();
    }
    return JSON.stringify({
      tick: col.tick,
      world: W.saveState(), nests: NS.saveState(), colony: col.saveState(),
      house: controls(),
    });
  };

  function q16(v, scale) { return Math.max(0, Math.min(65535, Math.round(v * scale))); }

  function packAnts() {
    let n = 0;
    for (let i = 0; i < C.MAX_ANTS; i++) if (A.alive[i]) n++;
    const buf = Buffer.alloc(n * 11);
    let o = 0;
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      buf.writeUInt16LE(i, o);
      buf.writeUInt16LE(q16(A.x[i], 16), o + 2);
      buf.writeUInt16LE(q16(A.y[i], 16), o + 4);
      buf[o + 6] = Math.floor((((A.hd[i] % TAU) + TAU) % TAU) / TAU * 256) & 255;
      buf[o + 7] = A.caste[i];
      buf[o + 8] = A.nest[i];
      buf[o + 9] = A.carry[i];
      buf[o + 10] = A.state[i];
      o += 11;
    }
    return buf.toString('base64');
  }

  function packBrood() {
    let n = 0;
    for (let b = 0; b < C.MAX_BROOD; b++) if (B.alive[b]) n++;
    const buf = Buffer.alloc(n * 12);
    let o = 0;
    for (let b = 0; b < C.MAX_BROOD; b++) {
      if (!B.alive[b]) continue;
      buf.writeUInt16LE(b, o);
      buf.writeUInt16LE(q16(B.x[b], 16), o + 2);
      buf.writeUInt16LE(q16(B.y[b], 16), o + 4);
      buf[o + 6] = B.stage[b];
      buf[o + 7] = B.nest[b];
      buf.writeUInt16LE(q16(B.t[b], 1), o + 8);
      buf[o + 10] = Math.max(0, Math.min(255, Math.round(B.fed[b])));
      buf[o + 11] = B.held[b] >= 0 ? 1 : 0;
      o += 12;
    }
    return buf.toString('base64');
  }

  const r2 = v => Math.round(v * 100) / 100;

  // Returns the event name and its data, or a keyframe when a delta can't
  // describe what happened (the farm grew, a nest was founded or died out).
  house.frame = function () {
    frameNo++;
    if (!lastTiles || lastTiles.length !== W.tiles.length || nestSignature() !== lastNestSig) {
      return { event: 'key', data: house.keyframe(true) };
    }

    const tiles = W.tiles;
    const changed = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === lastTiles[i]) continue;
      changed.push(i, tiles[i]);
      lastTiles[i] = tiles[i];
    }
    if (changed.length > 40000) return { event: 'key', data: house.keyframe(true) };

    let surf = null;
    for (let x = 0; x < W.surfY.length; x++) {
      if (W.surfY[x] !== lastSurf[x]) { surf = Array.from(W.surfY); lastSurf = surf.slice(); break; }
    }

    const out = {
      tick: col.tick,
      ants: packAnts(),
      brood: packBrood(),
      piles: col.piles.map(p => [r2(p.x), r2(p.y), r2(p.amount), r2(p.seed || 0)]),
      puddles: col.puddles.map(p => [r2(p.x), r2(p.y), r2(p.amount), r2(p.max || p.amount)]),
      corpses: col.corpses.map(c => [r2(c.x), r2(c.y), c.nest, c.held >= 0 ? 1 : 0, Math.round(c.age || 0)]),
      intruders: col.intruders.map(t => ({ x: r2(t.x), y: r2(t.y), hp: r2(t.hp || 0),
        max: r2(t.max || t.hp || 1), hd: r2(t.hd || 0) })),
      house: controls(),
    };
    if (changed.length) out.tiles = changed;
    if (surf) out.surf = surf;
    // Stores, plans, the war ledger: once a second is plenty.
    if (frameNo % 10 === 0) out.nests = NS.saveState();
    return { event: 'frame', data: JSON.stringify(out) };
  };

  // Pheromone overlay, only for viewers who switched it on. Quantized to a byte;
  // the renderer saturates at 2.2 anyway.
  house.pheromones = function () {
    const quant = arr => {
      const buf = Buffer.alloc(arr.length);
      for (let i = 0; i < arr.length; i++) buf[i] = Math.max(0, Math.min(255, Math.round(arr[i] / 2.2 * 255)));
      return buf.toString('base64');
    };
    return { w: C.W, h: C.H, alarm: quant(W.alarm), trails: NS.list.map(n => quant(n.trail)) };
  };

  // Everything the inspector shows for one ant, worked out where the ant lives.
  house.ant = function (i) {
    if (!Number.isInteger(i) || i < 0 || i >= C.MAX_ANTS) return null;
    if (!A.alive[i]) return { i, alive: false, uid: A.uid[i] };
    const nest = NS.get(A.nest[i]);
    return {
      i, alive: true, uid: A.uid[i], caste: A.caste[i], nest: A.nest[i],
      goal: sim.goalText(i), thought: sim.thought(i),
      health: r2(A.health[i]), energy: r2(A.energy[i]), hydration: r2(A.hydration[i]),
      carry: A.carry[i], age: A.age[i], life: A.life[i],
      x: r2(A.x[i]), y: r2(A.y[i]), surface: W.surfaceAt(A.x[i]),
      sFood: A.sFood[i], sDirt: A.sDirt[i], sFed: A.sFed[i], sHits: A.sHits[i],
      sDist: r2(A.sDist[i]), gen: A.gen[i],
      eggsLaid: nest ? nest.stats.eggsLaid : 0,
      log: col.recentLog(i), tick: col.tick,
    };
  };

  // ------------------------------------------------------ keeper actions
  // Called only after the server has checked the token.
  house.act = function (a) {
    const x = Number(a.x);
    const onFarm = Number.isFinite(x) && x >= 0 && x < C.W;
    switch (a.type) {
      case 'food':
        if (!onFarm) return { ok: false, error: 'That is off the farm.' };
        col.addPile(x, W.surfaceAt(x) - 0.6);
        return { ok: true };
      case 'water':
        if (!onFarm) return { ok: false, error: 'That is off the farm.' };
        col.addPuddle(x, W.surfaceAt(x) - 0.4);
        return { ok: true };
      case 'queen': {
        if (!onFarm) return { ok: false, error: 'That is off the farm.' };
        if (NS.list.length >= AF.MAX_NESTS) return { ok: false, error: 'The farm already holds as many nests as it can.' };
        return NS.found(x);
      }
      case 'autoTend':
        house.autoTend = !!a.on;
        return { ok: true };
      case 'pause':
        house.paused = !!a.paused;
        return { ok: true };
      case 'speed':
        if (![1, 3, 10].includes(a.speed)) return { ok: false, error: 'Unknown speed.' };
        house.speed = a.speed;
        house.paused = false;
        return { ok: true };
      case 'new': {
        const q = Math.max(1, Math.min(3, Math.round(Number(a.queens) || 1)));
        W.generate(q);
        col.reset(q);
        lastTiles = null;                // everyone gets a fresh keyframe
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown action.' };
    }
  };

  house.status = function () {
    return {
      tick: col.tick, ants: col.count, nests: NS.list.filter(n => n.alive).length,
      tickMs: Math.round(house.tickMs * 1000) / 1000, ...controls(),
    };
  };

  house.start = function () {
    setInterval(advance, STEP_MS);
  };

  return house;
}

module.exports = { createHouse };
