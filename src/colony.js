// Population storage, shared by every nest.
//
// Ants live in parallel typed arrays (struct-of-arrays). An "ant" is just an
// index, and one of its fields says which nest it belongs to. Dead ants free
// their index onto a stack and the next pupa to mature reuses it, so memory is
// allocated exactly once at startup — no matter how many colonies are running.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, CASTE = AF.CASTE, ST = AF.ST, CARRY = AF.CARRY;
  const N = C.MAX_ANTS, NB = C.MAX_BROOD;
  const LOGN = 8; // per-ant ring buffer of recent events

  const A = {
    x: new Float32Array(N), y: new Float32Array(N),
    hd: new Float32Array(N), spd: new Float32Array(N),
    caste: new Uint8Array(N), state: new Uint8Array(N), alive: new Uint8Array(N),
    nest: new Uint8Array(N),     // which colony this ant belongs to
    // Age in 64-bit: at 1× an ant ages 1/160 of a life tick per movement tick,
    // and in 32-bit floats that step rounds away to nothing after about ten
    // colony days — a months-long life would simply stop ageing.
    age: new Float64Array(N), life: new Float32Array(N),
    energy: new Float32Array(N), hydration: new Float32Array(N), health: new Float32Array(N),
    carry: new Uint8Array(N), carryAmt: new Float32Array(N),
    tx: new Float32Array(N), ty: new Float32Array(N),
    memx: new Float32Array(N), memy: new Float32Array(N),
    timer: new Float32Array(N),
    stuck: new Float32Array(N),  // ticks spent making no headway
    lx: new Float32Array(N), ly: new Float32Array(N),
    node: new Int16Array(N),     // plan node claimed by a digger
    target: new Int16Array(N),   // brood index a nurse is tending
    digTile: new Int32Array(N),  // tile being excavated
    foe: new Int16Array(N),      // ant index this one is fighting
    uid: new Int32Array(N),      // stable display id
    gen: new Uint16Array(N),     // how many ants have used this slot
    born: new Float64Array(N),
    sFood: new Uint16Array(N), sDirt: new Uint16Array(N),
    sFed: new Uint16Array(N), sHits: new Uint16Array(N),
    sDist: new Float32Array(N),
    logC: new Uint8Array(N * LOGN), logT: new Float64Array(N * LOGN),
    logI: new Uint8Array(N), logN: new Uint8Array(N),
    // The one field that isn't a number: a direct handle on the body an
    // undertaker is carrying, so removing corpses can't shuffle it out from
    // under them the way an index into a compacting list would.
    body: new Array(N).fill(null),
  };

  const B = {
    x: new Float32Array(NB), y: new Float32Array(NB),
    nest: new Uint8Array(NB),    // whose brood this is (raiders can change it)
    stage: new Uint8Array(NB),   // 0 egg, 1 larva, 2 pupa
    t: new Float32Array(NB),     // progress within stage
    fed: new Float32Array(NB),   // buffered nutrition
    alive: new Uint8Array(NB),
    held: new Int16Array(NB),    // ant index carrying it, -1 otherwise
    uid: new Int32Array(NB),
  };

  const freeAnts = new Int32Array(N);
  let freeAntTop = 0;
  const freeBrood = new Int32Array(NB);
  let freeBroodTop = 0;

  let nextUid = 1, nextBroodUid = 1;

  const colony = {
    A, B, LOGN,
    count: 0, broodCount: 0,
    piles: [],
    puddles: [],
    intruders: [],
    corpses: [],
    tick: 0,         // movement ticks
    lifeTick: 0,     // colony time, in life ticks (see DAY_TICKS)
    // Names keepers have given individual ants, by uid. A reused slot gets a
    // new uid, so a name lasts exactly as long as its ant.
    names: {},
  };

  colony.antName = function (i) {
    return (A.alive[i] && colony.names[A.uid[i]]) || null;
  };
  colony.setAntName = function (i, name) {
    if (!A.alive[i]) return false;
    if (name) colony.names[A.uid[i]] = name;
    else delete colony.names[A.uid[i]];
    return true;
  };
  AF.colony = colony;

  const nests = () => AF.nests;
  const nestOf = i => AF.nests.get(A.nest[i]);
  colony.nestOf = nestOf;

  // ------------------------------------------------------------------ logging

  colony.log = function (i, code) {
    const base = i * LOGN;
    const p = A.logI[i];
    A.logC[base + p] = code;
    A.logT[base + p] = colony.tick;
    A.logI[i] = (p + 1) % LOGN;
    if (A.logN[i] < LOGN) A.logN[i]++;
  };

  colony.recentLog = function (i) {
    const out = [];
    const base = i * LOGN, n = A.logN[i];
    for (let k = 0; k < n; k++) {
      const p = (A.logI[i] - 1 - k + LOGN * 2) % LOGN;
      out.push({ code: A.logC[base + p], t: A.logT[base + p] });
    }
    return out;
  };

  // ------------------------------------------------------------- ant lifecycle

  colony.initPool = function () {
    freeAntTop = 0;
    for (let i = N - 1; i >= 0; i--) { freeAnts[freeAntTop++] = i; A.alive[i] = 0; A.gen[i] = 0; }
    freeBroodTop = 0;
    for (let i = NB - 1; i >= 0; i--) { freeBrood[freeBroodTop++] = i; B.alive[i] = 0; }
    colony.count = 0; colony.broodCount = 0;
  };

  colony.spawnAnt = function (nest, caste, x, y, freeOfCharge) {
    if (freeAntTop === 0) return -1;
    if (!freeOfCharge && nest.res.biomass < C.BIOMASS_PER_ANT) return -1;
    if (!freeOfCharge) nest.res.biomass -= C.BIOMASS_PER_ANT;

    const i = freeAnts[--freeAntTop];
    if (A.gen[i] > 0) nest.stats.recycled++;
    A.gen[i]++;

    A.alive[i] = 1;
    A.nest[i] = nest.id;
    A.x[i] = x; A.y[i] = y;
    A.hd[i] = Math.random() * Math.PI * 2;
    A.caste[i] = caste;
    A.state[i] = caste === CASTE.QUEEN ? ST.LAY : ST.IDLE;
    A.age[i] = 0;
    A.life[i] = caste === CASTE.QUEEN
      ? C.QUEEN_LIFE
      : C.LIFE_MIN + Math.random() * (C.LIFE_MAX - C.LIFE_MIN);
    A.energy[i] = C.ENERGY_MAX * (0.7 + Math.random() * 0.3);
    A.hydration[i] = C.HYDRATION_MAX * (0.7 + Math.random() * 0.3);
    A.health[i] = 100;
    A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0;
    A.timer[i] = 0; A.stuck[i] = 0;
    A.lx[i] = 0; A.ly[i] = 0;
    A.node[i] = -1; A.target[i] = -1; A.digTile[i] = -1; A.foe[i] = -1;
    A.body[i] = null;
    A.memx[i] = -1; A.memy[i] = -1;
    A.tx[i] = x; A.ty[i] = y;
    A.uid[i] = nextUid++;
    A.born[i] = colony.lifeTick;
    A.sFood[i] = 0; A.sDirt[i] = 0; A.sFed[i] = 0; A.sHits[i] = 0; A.sDist[i] = 0;
    A.logI[i] = 0; A.logN[i] = 0;
    A.spd[i] = baseSpeed(caste) * (0.85 + Math.random() * 0.3);

    colony.count++;
    nest.count++;
    nest.castePop[caste]++;
    nest.stats.births++;
    colony.log(i, 0);
    if (caste === CASTE.QUEEN) nest.queen = i;
    return i;
  };

  function baseSpeed(caste) {
    switch (caste) {
      case CASTE.FORAGER: return C.SPD_FORAGER;
      case CASTE.DIGGER: return C.SPD_DIGGER;
      case CASTE.NURSE: return C.SPD_NURSE;
      case CASTE.SOLDIER: return C.SPD_SOLDIER;
      case CASTE.UNDERTAKER: return C.SPD_UNDERTAKER;
      default: return C.SPD_QUEEN;
    }
  }

  // Death. The array slot is freed at once — that is bookkeeping — but the
  // body is not. It lies where it fell until an undertaker carries it out, and
  // only then does its substance return to anyone.
  colony.killAnt = function (i, cause) {
    if (!A.alive[i]) return;
    const nest = nestOf(i);

    if (A.carry[i] === CARRY.FOOD) nest.res.food += A.carryAmt[i] * 0.5;
    if (A.carry[i] === CARRY.WATER) nest.res.water += A.carryAmt[i] * 0.5;
    if (A.carry[i] === CARRY.DIRT) nest.pendingSpoil += A.carryAmt[i];
    if (A.carry[i] === CARRY.EGG && A.target[i] >= 0) B.held[A.target[i]] = -1;
    if (A.carry[i] === CARRY.CORPSE && A.body[i]) {
      const c = A.body[i];
      c.held = -1; c.x = A.x[i]; c.y = A.y[i];
      A.body[i] = null;
    }

    A.alive[i] = 0;
    colony.count--;
    nest.count--;
    nest.castePop[A.caste[i]]--;
    nest.stats.deaths++;
    if (cause === 'starve') nest.stats.starved++;
    if (cause === 'thirst') nest.stats.dehydrated++;
    if (cause === 'killed') nest.stats.killed++;

    colony.addCorpse(A.x[i], A.y[i], nest.id, A.caste[i]);

    // Let go of any dig site this ant had claimed. Leaking the claim made the
    // room look permanently crowded: nobody else would take it, and the review
    // wrote it off for lack of progress nobody was ever making.
    if (A.node[i] >= 0 && nest.plan[A.node[i]]) {
      const site = nest.plan[A.node[i]];
      site.claims = Math.max(0, site.claims - 1);
    }
    A.node[i] = -1;

    if (nest.queen === i) nest.queen = -1;
    freeAnts[freeAntTop++] = i;
  };

  // ------------------------------------------------------------------ bodies

  colony.addCorpse = function (x, y, nestId, caste) {
    if (colony.corpses.length >= C.MAX_CORPSES) {
      // Too many to track. The oldest has effectively rotted away.
      colony.corpses.shift();
    }
    colony.corpses.push({
      x, y, nest: nestId, caste,
      biomass: C.BIOMASS_RETURN, food: C.FOOD_FROM_CORPSE,
      age: 0, held: -1,
    });
  };

  // Left where it lies, a body decomposes. Some of it seeps back to the colony
  // whose tunnel it is in; the rest is simply lost, which is the standing
  // argument for keeping undertakers on the payroll.
  colony.rotCorpses = function () {
    for (let k = colony.corpses.length - 1; k >= 0; k--) {
      const c = colony.corpses[k];
      if (c.held >= 0) continue;
      c.age += AF.sim ? AF.sim.lifeRate() : 1;   // rots in colony time
      if (c.age < C.CORPSE_ROT) continue;
      const nest = AF.nests.get(c.nest);
      if (nest) nest.res.biomass += c.biomass * C.CORPSE_ROT_RETURN;
      colony.corpses.splice(k, 1);
    }
  };

  // ------------------------------------------------------------ brood lifecycle

  colony.spawnBrood = function (nest, x, y) {
    if (freeBroodTop === 0) return -1;
    const b = freeBrood[--freeBroodTop];
    B.alive[b] = 1; B.x[b] = x; B.y[b] = y;
    B.nest[b] = nest.id;
    B.stage[b] = 0; B.t[b] = 0; B.fed[b] = 0; B.held[b] = -1;
    B.uid[b] = nextBroodUid++;
    colony.broodCount++;
    nest.broodCount++;
    nest.broodPop[0]++;
    return b;
  };

  colony.killBrood = function (b) {
    if (!B.alive[b]) return;
    const nest = AF.nests.get(B.nest[b]);
    B.alive[b] = 0;
    colony.broodCount--;
    nest.broodCount--;
    nest.broodPop[B.stage[b]]--;
    nest.res.biomass += 0.8;
    freeBrood[freeBroodTop++] = b;
  };

  // Pupa became an adult: free the brood slot with no biomass refund, since
  // the body went into the new ant rather than back to the pool.
  colony.consumeBrood = function (b) {
    if (!B.alive[b]) return;
    const nest = AF.nests.get(B.nest[b]);
    B.alive[b] = 0;
    nest.broodPop[B.stage[b]]--;
    nest.broodCount--;
    colony.broodCount--;
    B.held[b] = -1;
    freeBrood[freeBroodTop++] = b;
  };

  // Carried off in a raid. Brood raised by another colony becomes that
  // colony's — which is exactly what slave-making ants do.
  colony.adoptBrood = function (b, nest) {
    const old = AF.nests.get(B.nest[b]);
    if (old === nest) return;
    old.broodPop[B.stage[b]]--;
    old.broodCount--;
    B.nest[b] = nest.id;
    nest.broodPop[B.stage[b]]++;
    nest.broodCount++;
    nest.stats.captives++;
  };

  colony.freeSlots = function () { return freeAntTop; };
  colony.freeBroodSlots = function () { return freeBroodTop; };

  // Workers change jobs. Without this a colony that loses its last nurse can
  // never raise brood again, so it dies even with a full larder.
  colony.retask = function (nest, toCaste, preferFrom) {
    for (let i = 0; i < N; i++) {
      if (!A.alive[i] || A.nest[i] !== nest.id) continue;
      const c = A.caste[i];
      if (c === CASTE.QUEEN || c === toCaste) continue;
      if (preferFrom != null && c !== preferFrom) continue;
      if (A.carry[i] !== CARRY.NONE) continue;

      if (A.node[i] >= 0 && nest.plan[A.node[i]]) nest.plan[A.node[i]].claims--;
      nest.castePop[c]--;
      A.caste[i] = toCaste;
      nest.castePop[toCaste]++;
      A.spd[i] = baseSpeed(toCaste) * (0.85 + Math.random() * 0.3);
      A.state[i] = 0; A.timer[i] = 0; A.node[i] = -1; A.target[i] = -1;
      colony.log(i, 19);
      return i;
    }
    return -1;
  };

  // ------------------------------------------- which caste does this nest need?
  // New adults take the job the colony is shortest on, weighted by whatever the
  // queen is currently investing in.

  colony.chooseCaste = function (nest) {
    const t = Object.assign({}, C.CASTE_TARGET);
    const pop = Math.max(1, nest.count);

    // The queen's standing policy tilts the whole intake.
    const mode = nest.policy.mode;
    if (mode === 'defend') { t.soldier += 0.22; t.digger -= 0.12; t.nurse -= 0.06; }
    else if (mode === 'expand') { t.digger += 0.16; t.soldier -= 0.06; t.forager -= 0.06; }
    else if (mode === 'grow') { t.nurse += 0.10; t.forager += 0.08; t.digger -= 0.12; }

    // Hard floors first. A colony that lets its last nurse become a forager
    // during a famine can never raise brood again once food returns.
    if (nest.broodPop[1] > 0 &&
        nest.castePop[CASTE.NURSE] < Math.max(2, Math.ceil(nest.broodPop[1] / 8))) {
      return CASTE.NURSE;
    }
    if (nest.castePop[CASTE.FORAGER] < 3) return CASTE.FORAGER;

    if (nest.res.food < 25 || nest.res.water < 25) { t.forager += 0.18; t.digger -= 0.12; t.nurse -= 0.06; }
    if (nest.res.food > 220) { t.forager -= 0.12; t.digger += 0.08; t.nurse += 0.04; }

    let unbuilt = 0;
    for (const n of nest.plan) if (n.built < 1) unbuilt++;
    if (unbuilt > 3) { t.digger += 0.10; t.forager -= 0.10; }

    if (nest.broodPop[1] > pop * 0.25) { t.nurse += 0.12; t.forager -= 0.08; t.digger -= 0.04; }
    if (colony.intruders.length) { t.soldier += 0.15; t.digger -= 0.10; t.nurse -= 0.05; }

    // Bodies piling up is its own kind of shortage.
    const bodies = colony.corpses.length;
    if (bodies > 6 && nest.castePop[CASTE.UNDERTAKER] < Math.ceil(bodies / 12)) {
      return CASTE.UNDERTAKER;
    }

    const names = ['forager', 'digger', 'nurse', 'soldier', 'undertaker'];
    const ids = [CASTE.FORAGER, CASTE.DIGGER, CASTE.NURSE, CASTE.SOLDIER, CASTE.UNDERTAKER];
    let bestId = CASTE.FORAGER, bestDeficit = -Infinity;
    for (let k = 0; k < names.length; k++) {
      const have = nest.castePop[ids[k]] / pop;
      const deficit = Math.max(0.02, t[names[k]]) - have;
      if (deficit > bestDeficit) { bestDeficit = deficit; bestId = ids[k]; }
    }
    return bestId;
  };

  // --------------------------------------------------------------- food piles
  // Surface food and water belong to nobody. Whoever finds them first gets
  // them, which is where competition between neighbours starts.

  colony.addPile = function (x, y, amount) {
    const amt = amount != null ? amount : C.PILE_AMOUNT;
    for (const p of colony.piles) {
      if (Math.hypot(p.x - x, p.y - y) < 4) {
        p.amount += amt; p.max = Math.max(p.max, p.amount);
        return p;
      }
    }
    if (colony.piles.length >= C.MAX_PILES) return null;
    const p = { x, y, amount: amt, max: amt, seed: Math.random() * 1000 };
    colony.piles.push(p);
    return p;
  };

  colony.addPuddle = function (x, y, amount) {
    const amt = amount != null ? amount : C.PUDDLE_AMOUNT;
    for (const p of colony.puddles) {
      if (Math.hypot(p.x - x, p.y - y) < 4) {
        p.amount += amt; p.max = Math.max(p.max, p.amount);
        return p;
      }
    }
    if (colony.puddles.length >= C.MAX_PILES) return null;
    const p = { x, y, amount: amt, max: amt, seed: Math.random() * 1000 };
    colony.puddles.push(p);
    return p;
  };

  // ------------------------------------------------------------------ totals
  // The side panel wants farm-wide figures as well as per-nest ones.

  colony.totals = function () {
    const t = {
      count: 0, broodCount: 0, food: 0, water: 0, biomass: 0,
      castePop: new Array(AF.NCASTE).fill(0), broodPop: [0, 0, 0],
      births: 0, deaths: 0, recycled: 0, starved: 0, dehydrated: 0, killed: 0,
      foodGathered: 0, waterGathered: 0, tilesDug: 0, spoilDumped: 0,
      larvaeFed: 0, eggsLaid: 0, stolen: 0,
      kills: 0, captives: 0, conquests: 0, bodiesCleared: 0, bodiesEaten: 0, cacheFound: 0,
    };
    for (const n of AF.nests.list) {
      t.count += n.count; t.broodCount += n.broodCount;
      t.food += n.res.food; t.water += n.res.water; t.biomass += n.res.biomass;
      for (let k = 0; k < AF.NCASTE; k++) t.castePop[k] += n.castePop[k];
      for (let k = 0; k < 3; k++) t.broodPop[k] += n.broodPop[k];
      const s = n.stats;
      t.births += s.births; t.deaths += s.deaths; t.recycled += s.recycled;
      t.starved += s.starved; t.dehydrated += s.dehydrated; t.killed += s.killed;
      t.foodGathered += s.foodGathered; t.waterGathered += s.waterGathered;
      t.tilesDug += s.tilesDug; t.spoilDumped += s.spoilDumped;
      t.larvaeFed += s.larvaeFed; t.eggsLaid += s.eggsLaid; t.stolen += s.stolen;
      t.kills += s.kills; t.captives += s.captives; t.conquests += s.conquests;
      t.bodiesCleared += s.bodiesCleared; t.bodiesEaten += s.bodiesEaten;
      t.cacheFound += s.cacheFound;
    }
    return t;
  };

  // ------------------------------------------------------------ save / load
  // Ants are written positionally to keep the payload small — at a few hundred
  // ants an object per field would be megabytes of JSON.

  const ANT_FIELDS = [
    'x', 'y', 'hd', 'spd', 'caste', 'state', 'nest', 'age', 'life', 'energy',
    'hydration', 'health', 'carry', 'carryAmt', 'tx', 'ty', 'memx', 'memy',
    'timer', 'stuck', 'lx', 'ly', 'node', 'target', 'digTile', 'foe',
    'uid', 'gen', 'born', 'sFood', 'sDirt', 'sFed', 'sHits', 'sDist', 'logI', 'logN',
  ];

  function round(v) { return Math.round(v * 1000) / 1000; }

  colony.saveState = function () {
    const ants = [];
    for (let i = 0; i < N; i++) {
      if (!A.alive[i]) continue;
      const rec = [i];
      for (const f of ANT_FIELDS) rec.push(round(A[f][i]));
      const base = i * LOGN;
      for (let k = 0; k < LOGN; k++) rec.push(A.logC[base + k]);
      for (let k = 0; k < LOGN; k++) rec.push(A.logT[base + k]);
      ants.push(rec);
    }
    const brood = [];
    for (let b = 0; b < NB; b++) {
      if (!B.alive[b]) continue;
      brood.push([b, round(B.x[b]), round(B.y[b]), B.stage[b], round(B.t[b]),
                  round(B.fed[b]), B.held[b], B.uid[b], B.nest[b]]);
    }
    const gen = [];
    for (let i = 0; i < N; i++) if (A.gen[i]) gen.push([i, A.gen[i]]);

    return {
      tick: colony.tick, lifeTick: colony.lifeTick, nextUid, nextBroodUid, ants, brood, gen,
      // Only the living keep their names; the dead's are dropped here.
      names: (() => {
        const kept = {};
        for (let i = 0; i < N; i++) {
          if (A.alive[i] && colony.names[A.uid[i]]) kept[A.uid[i]] = colony.names[A.uid[i]];
        }
        return kept;
      })(),
      piles: colony.piles, puddles: colony.puddles, intruders: [],
    };
  };

  colony.loadState = function (s) {
    colony.initPool();
    colony.tick = s.tick;
    // Saves from before the two clocks ran life and movement as one.
    colony.lifeTick = s.lifeTick != null ? s.lifeTick : s.tick;
    colony.names = {};
    for (const uid in (s.names || {})) {
      const name = AF.nests.cleanName(s.names[uid]);
      if (name) colony.names[uid] = name;
    }
    nextUid = s.nextUid; nextBroodUid = s.nextBroodUid;

    for (const nest of AF.nests.list) {
      nest.count = 0; nest.broodCount = 0;
      nest.castePop = new Array(AF.NCASTE).fill(0);
      nest.broodPop = [0, 0, 0];
    }

    for (const [i, g] of s.gen) A.gen[i] = g;

    for (const rec of s.ants) {
      const i = rec[0];
      let p = 1;
      for (const f of ANT_FIELDS) A[f][i] = rec[p++];
      const base = i * LOGN;
      for (let k = 0; k < LOGN; k++) A.logC[base + k] = rec[p++];
      for (let k = 0; k < LOGN; k++) A.logT[base + k] = rec[p++];
      A.alive[i] = 1;
      const nest = AF.nests.get(A.nest[i]) || AF.nests.get(0);
      A.nest[i] = nest.id;
      colony.count++;
      nest.count++;
      nest.castePop[A.caste[i]]++;
      if (A.caste[i] === CASTE.QUEEN) nest.queen = i;
    }

    for (const rec of s.brood) {
      const b = rec[0];
      B.x[b] = rec[1]; B.y[b] = rec[2]; B.stage[b] = rec[3];
      B.t[b] = rec[4]; B.fed[b] = rec[5]; B.held[b] = rec[6]; B.uid[b] = rec[7];
      B.nest[b] = rec[8] || 0;
      B.alive[b] = 1;
      const nest = AF.nests.get(B.nest[b]) || AF.nests.get(0);
      B.nest[b] = nest.id;
      colony.broodCount++;
      nest.broodCount++;
      nest.broodPop[B.stage[b]]++;
    }

    // Rebuild the free stacks from whatever slots ended up unoccupied.
    freeAntTop = 0;
    for (let i = N - 1; i >= 0; i--) if (!A.alive[i]) freeAnts[freeAntTop++] = i;
    freeBroodTop = 0;
    for (let b = NB - 1; b >= 0; b--) if (!B.alive[b]) freeBrood[freeBroodTop++] = b;

    for (const nest of AF.nests.list) {
      if (nest.queen >= 0 && (!A.alive[nest.queen] || A.nest[nest.queen] !== nest.id)) {
        nest.queen = -1;
      }
      nest.hungryLarvae.length = 0;
      nest.looseEggs.length = 0;
    }

    colony.piles = s.piles || [];
    colony.puddles = s.puddles || [];
    // Food and water sit on the ground, wherever the ground is now.
    for (const p of colony.piles) p.y = W.surfaceAt(p.x) - 0.6;
    for (const p of colony.puddles) p.y = W.surfaceAt(p.x) - 0.4;
    colony.intruders = [];
  };

  // ------------------------------------------------------------------- setup

  colony.reset = function (queens) {
    colony.initPool();
    colony.piles.length = 0;
    colony.puddles.length = 0;
    colony.intruders.length = 0;
    colony.corpses.length = 0;
    colony.tick = 0;
    colony.lifeTick = 0;
    colony.names = {};
    for (let i = 0; i < N; i++) A.body[i] = null;

    AF.nests.reset(queens == null ? 1 : queens);

    for (const nest of AF.nests.list) {
      const q = nest.founding;
      colony.spawnAnt(nest, CASTE.QUEEN, q.x, q.y, true);

      const ex = nest.entrance.x, ey = nest.entrance.y;
      for (let i = 0; i < C.START_WORKERS; i++) {
        const caste = i % 6 === 0 ? CASTE.SOLDIER
          : i % 5 === 0 ? CASTE.UNDERTAKER
          : i % 3 === 0 ? CASTE.NURSE
          : i % 2 === 0 ? CASTE.DIGGER : CASTE.FORAGER;
        colony.spawnAnt(nest, caste, ex + (Math.random() - 0.5) * 2, ey + Math.random() * 2, true);
      }

      // A starter kit outside each entrance, then it is on the caretaker.
      colony.addPile(ex - 26, W.surfaceAt(ex - 26) - 0.6);
      colony.addPile(ex + 30, W.surfaceAt(ex + 30) - 0.6);
      colony.addPuddle(ex + 14, W.surfaceAt(ex + 14) - 0.4);
    }
  };
})();
