// Nests.
//
// Each nest is a separate colony: its own entrance, its own chambers, its own
// larder, and its own trail pheromone. Ants belong to exactly one. A trail laid
// by another nest is still detectable — it just smells wrong, which is how a
// colony learns it has neighbours.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, T = AF.T;

  const COLORS = [
    { queen: '#f2c14e', forager: '#d98b3a', digger: '#a9713f', nurse: '#8fb8c9', soldier: '#c7553f', undertaker: '#8d8596', tint: '#e0a33c' },
    { queen: '#8fd2f2', forager: '#57a8d8', digger: '#4d7fa8', nurse: '#a7d8e8', soldier: '#3f7fc7', undertaker: '#7d8f9c', tint: '#57a8d8' },
    { queen: '#c9a0e8', forager: '#a97fd0', digger: '#7f5fa8', nurse: '#d5bde8', soldier: '#8a4fc7', undertaker: '#8e849c', tint: '#a97fd0' },
    { queen: '#9ee07a', forager: '#6fbf4f', digger: '#54914a', nurse: '#c2e3ad', soldier: '#3f9c55', undertaker: '#7f9080', tint: '#6fbf4f' },
    { queen: '#f28fb4', forager: '#d8619a', digger: '#a8507a', nurse: '#f0bdd4', soldier: '#c73f7f', undertaker: '#9c8490', tint: '#d8619a' },
    { queen: '#e8d9a0', forager: '#c9b46b', digger: '#97854c', nurse: '#efe7c8', soldier: '#a89334', undertaker: '#948f7c', tint: '#c9b46b' },
  ];

  const MAX_NESTS = COLORS.length;
  AF.MAX_NESTS = MAX_NESTS;

  const nests = { list: [], ready: false };
  AF.nests = nests;

  let nodeSeq = 0;

  // ---------------------------------------------------------------- creation

  function makeNest(id, start) {
    const n = {
      id,
      alive: true,
      colors: COLORS[id % COLORS.length],
      // The first way in. A growing nest cuts more of them, and `entrance`
      // stays as the original for anything that wants one fixed reference.
      entrance: { x: start.entrance.x, y: start.entrance.y },
      entrances: [{ x: start.entrance.x, y: start.entrance.y }],
      founding: { x: start.founding.x, y: start.founding.y, r: start.founding.r },
      plan: [],
      storeNode: null, broodNode: null, queenNode: null,
      _store: null, _brood: null, _queen: null,

      trail: null,
      fHome: null, fStore: null, fBrood: null, fQueen: null,

      res: { food: 70, water: 70, biomass: 120 },
      count: 0, broodCount: 0,
      castePop: new Array(AF.NCASTE).fill(0),
      broodPop: [0, 0, 0],
      queen: -1,
      pendingSpoil: 0,
      hungryLarvae: [],
      looseEggs: [],

      // What the queen is currently investing in. The only place in the whole
      // simulation where anything makes a decision rather than following a rule.
      policy: { mode: 'grow', timer: 0, threat: 0, lastThreat: 0 },

      stats: {
        births: 0, deaths: 0, recycled: 0, foodGathered: 0, waterGathered: 0,
        dirtMoved: 0, tilesDug: 0, spoilDumped: 0, eggsLaid: 0, larvaeFed: 0,
        starved: 0, dehydrated: 0, killed: 0, stolen: 0, raidsLost: 0,
        // the war ledger
        kills: 0,      // enemy ants this nest has killed
        captives: 0,   // enemy brood carried off and raised as ours
        conquests: 0,  // whole nests absorbed
        bodiesCleared: 0,
        bodiesEaten: 0, // strangers' bodies brought home as protein
        cacheFound: 0, // food dug out of the ground
        breaches: 0,   // galleries cut through into a neighbour's nest
      },
    };
    allocFor(n, AF.CFG.W, AF.CFG.H);
    buildInitialPlan(n);
    return n;
  }

  function allocFor(n, w, h) {
    n.trail = new Float32Array(w * h);
    n.fHome = new Int32Array(w * h);
    n.fStore = new Int32Array(w * h);
    n.fBrood = new Int32Array(w * h);
    n.fQueen = new Int32Array(w * h);
  }

  nests.reset = function (howMany) {
    nodeSeq = 0;
    nests.list = [];
    const starts = W.starts || [];
    const n = Math.max(0, Math.min(starts.length, howMany == null ? 1 : howMany));
    for (let i = 0; i < n; i++) nests.list.push(makeNest(i, starts[i]));
    nests.ready = true;
    W.fieldsStale = true;
    nests.rebuildFields();
  };

  // Found a nest on a farm that is already running. The existing colonies
  // carry on untouched; this one arrives as a stranger with a queen, a handful
  // of workers and nothing dug.
  nests.canFound = function (x) {
    if (nests.list.length >= MAX_NESTS) return 'The farm has as many nests as it can hold.';
    const col = Math.round(x);
    if (col < 30 || col > AF.CFG.W - 30) return 'Too close to the edge of the farm.';
    for (const n of nests.list) {
      if (!n.alive) continue;
      if (Math.abs(n.entrance.x - x) < 55) return 'Too close to an existing nest.';
    }
    return null;
  };

  nests.found = function (x) {
    const why = nests.canFound(x);
    if (why) return { ok: false, error: why };

    const start = W.carveStart(Math.round(x));
    // The start list isn't saved, so a farm that was reloaded has none yet.
    (W.starts || (W.starts = [])).push(start);
    const nest = makeNest(nests.list.length, start);
    nests.list.push(nest);

    W.dirty = true;
    W.fieldsStale = true;
    nests.rebuildFields();

    // A founding queen and the first workers, on the house — same as the ones
    // the farm started with.
    const colony = AF.colony;
    colony.spawnAnt(nest, AF.CASTE.QUEEN, nest.founding.x, nest.founding.y, true);
    for (let i = 0; i < AF.CFG.START_WORKERS; i++) {
      const caste = i % 6 === 0 ? AF.CASTE.SOLDIER
        : i % 5 === 0 ? AF.CASTE.UNDERTAKER
        : i % 3 === 0 ? AF.CASTE.NURSE
        : i % 2 === 0 ? AF.CASTE.DIGGER : AF.CASTE.FORAGER;
      colony.spawnAnt(nest, caste,
        nest.entrance.x + (Math.random() - 0.5) * 2,
        nest.entrance.y + Math.random() * 2, true);
    }
    return { ok: true, nest };
  };

  nests.get = function (i) { return nests.list[i]; };
  nests.count = function () { return nests.list.length; };
  nests.living = function () { return nests.list.filter(n => n.alive); };

  // Grids are sized to the world, so a farm that grows takes them with it.
  nests.allocate = function (w, h) {
    for (const n of nests.list) allocFor(n, w, h);
  };
  nests.takeTrails = function () { return nests.list.map(n => n.trail); };
  nests.restoreTrails = function (old, oldW, oldH, addLeft) {
    const w = AF.CFG.W;
    for (let k = 0; k < nests.list.length; k++) {
      const src = old[k], dst = nests.list[k].trail;
      if (!src || !dst) continue;
      for (let y = 0; y < oldH; y++) {
        const s = y * oldW, d = y * w + addLeft;
        for (let x = 0; x < oldW; x++) dst[d + x] = src[s + x];
      }
    }
  };

  // ------------------------------------------------------------- blueprints

  function addNode(nest, x, y, r, type) {
    const node = { id: nodeSeq++, x, y, r, type, built: 0, claims: 0, fails: 0 };
    nest.plan.push(node);
    return node;
  }

  function buildInitialPlan(nest) {
    const ex = nest.entrance.x - 0.5;
    const sy = W.surfaceAt(nest.entrance.x);
    addNode(nest, ex + 0.5, sy + 8, 2.0, 'shaft');
    addNode(nest, ex + 0.5, sy + 18, 2.0, 'shaft');
    nest.storeNode = addNode(nest, ex - 11, sy + 22, 4.0, 'store');
    nest.broodNode = addNode(nest, ex + 12, sy + 30, 4.2, 'nursery');
    addNode(nest, ex + 0.5, sy + 34, 2.0, 'shaft');
    nest.queenNode = addNode(nest, ex - 2, sy + 46, 4.4, 'queen');
  }

  // Where to sink another entrance, or null if the colony doesn't need one.
  // It goes above ground the nest has already opened — you cut a shaft up from
  // your own tunnels, not a hole in a random field.
  function entranceSite(nest) {
    // A ratio to the colony, uncapped. Space is the limit, enforced below.
    const wanted = 1 + Math.floor(nest.count / C.ANTS_PER_ENTRANCE);
    if (nest.entrances.length >= wanted) return null;

    // One at a time, and that means any shaft still outstanding — including one
    // the diggers finished that never actually broke through. Missing that case
    // queued a fresh shaft every time, and they stacked up by the dozen.
    for (const n of nest.plan) {
      if (n.type === 'entrance' && !n.adopted && !n.abandoned) return null;
    }

    const rooms = nest.plan.filter(n => n.built >= 1 && !n.abandoned);
    if (!rooms.length) return null;

    // Sited by distance from the doors the nest already has, not by how far its
    // rooms have spread. Tying it to room spread meant a crowded but compact
    // nest — 150 ants in rooms all within 15 tiles of the hole — could never get
    // a second way in. Diggers tunnel out to the new shaft from the nearest
    // room, the way a real colony pushes a gallery out to a new opening.
    // Furthest a new shaft's opening may sit from the edge of an existing room,
    // measured as a real 2D distance. Measured sideways only, a room forty
    // tiles down counted as "within reach" of a point on the surface, and the
    // shaft ended up somewhere no gallery would ever get to.
    const REACH = 34;
    // Spots a shaft was already tried at and given up on — usually stone just
    // under the turf. Re-siting there repeats the failure; one nest tried the
    // same column three times running.
    const tried = nest.plan.filter(n => n.type === 'entrance' && n.abandoned);
    let best = null, bestScore = -Infinity;
    for (const e of nest.entrances) {
      for (const side of [-1, 1]) {
        for (let d = C.ENTRANCE_MIN_GAP; d <= C.ENTRANCE_MIN_GAP + 18; d += 3) {
          const x = Math.round(e.x + side * d);
          if (x < 10 || x > AF.CFG.W - 10) continue;
          if (tried.some(t => Math.abs(t.x - (x + 0.5)) < 8)) continue;

          let gap = Infinity;
          for (const other of nest.entrances) gap = Math.min(gap, Math.abs(other.x - x));
          if (gap < C.ENTRANCE_MIN_GAP) continue;

          // Measured to real rooms only. Another shaft's mouth is on the
          // surface too, and "near" one says nothing about reaching the nest.
          const groundY = W.surfaceAt(x);
          let reach = Infinity, room = null;
          for (const r of rooms) {
            if (r.type === 'entrance' || r.type === 'breach') continue;
            const toRoom = Math.hypot(r.x - x, r.y - groundY) - r.r;
            if (toRoom < reach) { reach = toRoom; room = r; }
          }
          if (reach > REACH) continue;

          // Stone at the ground line means the shaft could never open.
          if (W.tileAt(x, W.surfaceAt(x)) === T.ROCK) continue;

          // Don't open a door beside a neighbour's.
          let crowded = false;
          for (const o of nests.list) {
            if (o === nest || !o.alive) continue;
            for (const oe of o.entrances) {
              if (Math.abs(oe.x - x) < C.ENTRANCE_MIN_GAP) { crowded = true; break; }
            }
            if (crowded) break;
          }
          if (crowded) continue;

          // Through the spoil heap is allowed — mound-building ants put their
          // extra entrances straight through the mound. Nearer the nest and a
          // shallower cut are preferred, with a little randomness so every
          // colony doesn't open its second door in the same place.
          const score = -reach * 1.2 - d * 0.3 - W.spoilDepth(x) * 0.3 + Math.random() * 3;
          if (score > bestScore) { bestScore = score; best = { x, lx: room.x, ly: room.y }; }
        }
      }
    }
    return best;
  }

  // Is a shaft being cut up through this column right now? Spoil must not land
  // on one — a load tipped over an unfinished shaft buries it before it opens.
  nests.shaftGuarded = function (x) {
    for (const nest of nests.list) {
      for (const n of nest.plan) {
        if (n.type !== 'entrance' || n.adopted || n.abandoned) continue;
        if (Math.abs(n.x - x) <= n.r + 1) return true;
      }
    }
    return false;
  };

  // Does the shaft in this column actually lead into the nest? Searched through
  // open ground below the surface line only: through the sky every hole joins
  // every other, and a two-tile dimple in the turf was being counted as a door.
  let seen = null, queue = null, seenGen = 0;
  nests.shaftConnected = function (nest, x) {
    const cw = AF.CFG.W, ch = AF.CFG.H, size = cw * ch;
    const top = W.surfaceAt(x);
    if (!W.passable(x, top)) return false;
    const rooms = nest.plan.filter(n =>
      n.built >= 1 && !n.abandoned && n.type !== 'entrance' && n.type !== 'breach');
    if (!rooms.length) return false;

    if (!seen || seen.length !== size) {
      seen = new Int32Array(size); queue = new Int32Array(size); seenGen = 0;
    }
    seenGen++;
    let head = 0, tail = 0;
    queue[tail++] = top * cw + x;
    seen[top * cw + x] = seenGen;
    const LIMIT = 12000;
    while (head < tail && head < LIMIT) {
      const k = queue[head++], cx = k % cw, cy = (k / cw) | 0;
      for (const r of rooms) {
        if (Math.abs(cx + 0.5 - r.x) < r.r && Math.hypot(cx + 0.5 - r.x, cy + 0.5 - r.y) < r.r) return true;
      }
      const around = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (const [nx, ny] of around) {
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const nk = ny * cw + nx;
        if (seen[nk] === seenGen || !W.passable(nx, ny) || ny < W.surfaceAt(nx)) continue;
        seen[nk] = seenGen;
        queue[tail++] = nk;
      }
    }
    return false;
  };

  // A shaft that is open to the sky AND leads down into the nest is a way in.
  nests.checkEntrances = function (nest) {
    for (const n of nest.plan) {
      if (n.type !== 'entrance' || n.adopted || n.abandoned) continue;
      // The node sits mid-tile at column + 0.5. Rounding that checked the
      // column next door, which is still capped, and abandoned shafts that had
      // opened and connected perfectly well.
      const x = Math.floor(n.x);
      const top = W.surfaceAt(x);

      if (W.passable(x, top) && nests.shaftConnected(nest, x)) {
        n.adopted = true;
        n.built = 1;
        nest.entrances.push({ x: x + 0.5, y: top + 1.5 });
        W.fieldsStale = true;
        continue;
      }
      // Finished but capped, or open but leading nowhere. Give it up rather
      // than leaving it blocking the next attempt.
      if (n.built >= 1) n.abandoned = true;
    }
  };

  // A way through into a neighbour. Nests left alone grow away from each other
  // — toward whichever side is free, and a farm that keeps adding ground at its
  // edges never runs out of free sides — so meeting underground has to be
  // deliberate. Two triggers, both about need rather than spite: a colony set on
  // raiding, or one with no ground left to grow into. The gallery is aimed at
  // the rim of the rival's nearest room, so once it is cut the two tunnel
  // systems are one, and raiders — whose route is always the shortest open
  // path — start going underground without being told the tunnel exists.
  function breachTarget(nest) {
    for (const n of nest.plan) {
      if (n.type === 'breach' && n.built < 1 && !n.abandoned) return null;
    }
    const pressed = nest.policy.mode === 'raid' || (nest.boxedIn || 0) >= 3;
    if (!pressed) return null;

    // Real rooms only. A finished breach sits right against the rival's room,
    // and counted as one of ours it became the origin of another breach at the
    // same spot — five in a row in one test.
    const ours = nest.plan.filter(n =>
      n.built >= 1 && !n.abandoned && n.type !== 'entrance' && n.type !== 'breach');
    if (!ours.length) return null;
    const through = nest.plan.filter(n => n.type === 'breach' && n.built >= 1 && !n.abandoned);

    // Spots a gallery was already driven at and given up on. Aiming at the same
    // one again just repeats the failure.
    const tried = nest.plan.filter(n => n.type === 'breach' && n.abandoned);

    let best = null, bd = Infinity;
    for (const other of nests.list) {
      if (other === nest || !other.alive || other.count === 0) continue;
      // Already through to this one: the way in exists.
      const joined = through.some(b => other.plan.some(t =>
        t.built >= 1 && !t.abandoned && Math.hypot(t.x - b.x, t.y - b.y) < t.r + 3));
      if (joined) continue;
      for (const theirs of other.plan) {
        if (theirs.built < 1 || theirs.abandoned ||
            theirs.type === 'entrance' || theirs.type === 'breach') continue;
        for (const mine of ours) {
          const d = Math.hypot(theirs.x - mine.x, theirs.y - mine.y);
          // Two rooms in the same place — an inherited chamber, say — give no
          // direction to dig in. Dividing by that distance produced a gallery
          // aimed at NaN, which sat "open" forever and blocked every other.
          if (d < 1 || d >= bd || d > C.BREACH_RANGE) continue;
          const tx = theirs.x + (mine.x - theirs.x) / d * theirs.r;
          const ty = theirs.y + (mine.y - theirs.y) / d * theirs.r;
          if (!isFinite(tx) || !isFinite(ty)) continue;
          if (tried.some(n => Math.hypot(n.x - tx, n.y - ty) < 3)) continue;
          bd = d;
          best = { x: tx, y: ty, mx: mine.x, my: mine.y };
        }
      }
    }
    return best;
  }

  // The nearest cache this colony can smell from ground it has already opened,
  // and which nobody has started cutting into yet. Two nests can both pick the
  // same one — which is the point of putting food between them.
  function cacheTarget(nest) {
    const rooms = nest.plan.filter(n => n.built >= 1 && !n.abandoned);
    if (!rooms.length) return null;

    // One prize at a time. Several open spurs split the diggers between them
    // and the nest stops getting built at all.
    for (const n of nest.plan) if (n.type === 'cache' && n.built < 1) return null;

    let best = null, bestD = Infinity;
    for (const c of W.caches) {
      if (c.tiles <= 0) continue;
      let claimed = false;
      for (const n of nest.plan) {
        if (Math.hypot(n.x - c.x, n.y - c.y) < c.r + 3) { claimed = true; break; }
      }
      if (claimed) continue;
      for (const r of rooms) {
        const d = Math.hypot(c.x - r.x, c.y - r.y);
        if (d < bestD && d < C.CACHE_SCENT_RANGE) { bestD = d; best = c; }
      }
    }
    return best;
  }

  // As a colony grows it wants more room. New chambers branch off one already
  // dug, so the nest spreads into a network instead of one long shaft.
  nests.expandPlan = function (nest) {
    // Book any breach that has been cut through since last time.
    for (const n of nest.plan) {
      // A node with no real position can never be dug, and would sit "open"
      // forever, blocking the next of its kind. Write it off and pin it to a
      // harmless finite spot so nothing downstream does arithmetic on NaN.
      if (!isFinite(n.x) || !isFinite(n.y)) {
        n.x = isFinite(n.x) ? n.x : 0;
        n.y = isFinite(n.y) ? n.y : 0;
        n.built = 1;
        n.abandoned = true;
        continue;
      }
      if (n.type === 'breach' && n.built >= 1 && !n.abandoned && !n.counted) {
        n.counted = true;
        nest.stats.breaches++;
      }
    }

    // Only ever keep a couple of faces open at once. Queueing rooms faster than
    // the diggers can cut them makes them thrash between sites.
    // Cache spurs don't count as open faces. They are an errand off the side of
    // the nest, and letting one block the normal building programme freezes a
    // colony's growth for as long as it takes to cut the food out.
    let unbuilt = 0, active = 0, digging = 0;
    for (const n of nest.plan) {
      if (n.built < 1) { unbuilt++; if (!n.opportunistic) digging++; }
      if (!n.abandoned) active++;
    }
    // Entrances and food spurs are side errands, so they are considered before
    // the open-face limit rather than after. Checked after, a busy colony —
    // one that always has a couple of rooms on the go — never reached them at
    // all, and a nest of 140 ants went on using a single hole.

    // A crowded nest cuts another way in. One hole for hundreds of ants is a
    // queue, not an entrance.
    const site = entranceSite(nest);
    if (site) {
      // Centred ON the ground line, so excavating it opens the column to the
      // sky. Sunk below it, the shaft is finished and still capped by a tile of
      // soil, and the way in never opens. It remembers the room it was sited
      // against: that is where its gallery has to end up.
      const node = addNode(nest, site.x + 0.5, W.surfaceAt(site.x), 2.6, 'entrance');
      node.lx = site.lx;
      node.ly = site.ly;
      node.opportunistic = true;
      return;
    }

    const breach = breachTarget(nest);
    if (breach) {
      const node = addNode(nest, breach.x, breach.y, 2.2, 'breach');
      // The room it is driven from. The gallery is bored from there.
      node.mx = breach.mx;
      node.my = breach.my;
      node.opportunistic = true;
      return;
    }

    // Buried food within reach of ground the colony has already opened gets
    // dug for deliberately. Leaning the nest's growth toward the smell walks it
    // close but never the last step — chambers can't overlap, so it circles the
    // prize forever. This is the colony deciding the food is worth a spur.
    const prize = cacheTarget(nest);
    if (prize) {
      // Sized to the food itself, not to a room — they are cutting it out, not
      // moving in.
      const node = addNode(nest, prize.x, prize.y, prize.r, 'cache');
      node.opportunistic = true;
      return;
    }

    if (digging >= 2) return;

    // A colony digs as much room as it has ants to need it, and keeps going for
    // as long as there is ground to dig. No ceiling on the number of chambers:
    // what stops a nest is running out of space it can reach, or dying.
    const wanted = 8 + Math.floor(nest.count / 8);
    if (active >= wanted) return;

    const built = nest.plan.filter(n => n.built >= 1 && !n.abandoned);
    let anchor;
    if (!built.length) {
      anchor = nest.plan.reduce((a, b) => (b.y > a.y ? b : a));
    } else if (Math.random() < 0.55) {
      anchor = built.reduce((a, b) =>
        Math.hypot(b.x - nest.entrance.x, b.y - nest.entrance.y) >
        Math.hypot(a.x - nest.entrance.x, a.y - nest.entrance.y) ? b : a);
    } else {
      anchor = built[(Math.random() * built.length) | 0];
    }
    const outward = anchor.x >= nest.entrance.x ? 1 : -1;

    // Try a few spots and keep the one that smells best. The colony does not
    // know where the food is — it just prefers to open ground that smells of
    // something, which is enough to make nests grow toward buried caches.
    const r = 3.2 + Math.random() * 1.8;
    let bestSpot = null, bestScent = -1;

    for (let attempt = 0; attempt < 14; attempt++) {
      const side = Math.random() < 0.7 ? outward : -outward;
      const nx = anchor.x + side * (7 + Math.random() * 9);
      const ny = anchor.y + (Math.random() * 13 - 3);
      if (nx < 12 || nx > AF.CFG.W - 12) continue;
      if (ny < C.SKY + 14 || ny > AF.CFG.H - 12) continue;

      // Never stack a chamber on one of our own. A neighbour's is different:
      // keep off the room itself, but allow the nest to build right up against
      // theirs. Colonies really do crowd each other, and holding everyone at
      // arm's length meant two nests never met underground at all.
      // A written-off room is not in the way. Most were never dug at all, and
      // letting them block placement boxed a nest in behind its own failures.
      let clash = false;
      for (const other of nests.list) {
        const margin = other === nest ? r + 4 : 1;
        for (const n of other.plan) {
          if (n.abandoned) continue;
          if (Math.hypot(n.x - nx, n.y - ny) < n.r + margin) { clash = true; break; }
        }
        if (clash) break;
      }
      if (clash) continue;

      const scent = W.sampleCache(nx, ny) + Math.random() * 0.08;
      if (scent > bestScent) { bestScent = scent; bestSpot = { x: nx, y: ny }; }
    }

    if (bestSpot) {
      const roll = Math.random();
      const type = roll < 0.3 ? 'nursery' : roll < 0.58 ? 'store'
                 : roll < 0.78 ? 'waste' : 'chamber';
      addNode(nest, bestSpot.x, bestSpot.y, r, type);
      nest.boxedIn = 0;
    } else {
      // Nowhere left to put a room. A few of these in a row and the colony
      // starts looking at its neighbour's ground instead.
      nest.boxedIn = (nest.boxedIn || 0) + 1;
    }
  };

  // ----------------------------------------------------------------- fields

  // A chamber only counts once it is dug AND reachable from its own entrance.
  function pickChamber(nest, node, minProgress) {
    if (!node || W.nodeProgress(node) < minProgress) return nest.founding;
    const seeds = W.seedsFor(node);
    for (let k = 0; k < seeds.length; k++) {
      if (nest.fHome[seeds[k]] >= 0) return node;
    }
    return nest.founding;
  }

  // The nearest way in from where an ant is standing.
  nests.nearestEntrance = function (nest, x, y) {
    let best = nest.entrances[0], bd = Infinity;
    for (const e of nest.entrances) {
      const d = Math.abs(e.x - x) + Math.abs(e.y - (y || e.y)) * 0.4;
      if (d < bd) { bd = d; best = e; }
    }
    return best || nest.entrance;
  };

  nests.rebuildFields = function () {
    for (const nest of nests.list) {
      // Seeded from every entrance at once, so the field routes each ant to
      // whichever one is nearest without anybody having to choose.
      let seeds = [];
      for (const e of nest.entrances) seeds = seeds.concat(W.entranceSeeds(e));
      W.bfs(nest.fHome, seeds);
      nest._store = pickChamber(nest, nest.storeNode, 0.35);
      nest._brood = pickChamber(nest, nest.broodNode, 0.35);
      nest._queen = pickChamber(nest, nest.queenNode, 0.5);
      W.bfs(nest.fStore, W.seedsFor(nest._store));
      W.bfs(nest.fBrood, W.seedsFor(nest._brood));
      W.bfs(nest.fQueen, W.seedsFor(nest._queen));
    }
    W.fieldsStale = false;
  };

  nests.store = function (nest) { return nest._store || nest.founding; };
  nests.brood = function (nest) { return nest._brood || nest.founding; };
  nests.royal = function (nest) { return nest._queen || nest.founding; };

  // ------------------------------------------------------------- pheromone

  nests.depositTrail = function (nest, fx, fy, amt) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!W.inb(x, y)) return;
    const i = W.idx(x, y);
    nest.trail[i] = Math.min(C.PH_MAX, nest.trail[i] + amt);
  };

  nests.sampleTrail = function (nest, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!W.inb(x, y)) return 0;
    return nest.trail[W.idx(x, y)];
  };

  // The strongest scent here that belongs to somebody else. This is all an ant
  // needs to know that another colony works this ground.
  nests.sampleForeign = function (nest, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!W.inb(x, y)) return 0;
    const i = W.idx(x, y);
    let worst = 0;
    for (const other of nests.list) {
      if (other === nest || !other.alive) continue;
      if (other.trail[i] > worst) worst = other.trail[i];
    }
    return worst;
  };

  nests.foreignOwner = function (nest, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!W.inb(x, y)) return null;
    const i = W.idx(x, y);
    let worst = 0, who = null;
    for (const other of nests.list) {
      if (other === nest || !other.alive) continue;
      if (other.trail[i] > worst) { worst = other.trail[i]; who = other; }
    }
    return worst > C.FOREIGN_SENSE ? who : null;
  };

  nests.decayTrails = function (big, skip, tickCount) {
    if (skip) return;
    const d = big ? C.PH_DECAY * C.PH_DECAY : C.PH_DECAY;
    const diffuse = tickCount % C.PH_DIFFUSE_EVERY === 0;
    for (const nest of nests.list) {
      const t = nest.trail;
      for (let i = 0; i < t.length; i++) {
        t[i] *= d;
        if (t[i] < 0.002) t[i] = 0;
      }
      if (diffuse) W.blur(t, 0.14);
    }
  };

  // ------------------------------------------------------------ save / load

  nests.saveState = function () {
    return nests.list.map(n => ({
      id: n.id, alive: n.alive,
      entrance: n.entrance, entrances: n.entrances, founding: n.founding,
      // Everything a node needs to carry on where it left off. Dropping
      // `adopted` made every open shaft look outstanding after a reload, and
      // each was pushed onto the entrance list a second time.
      plan: n.plan.map(p => ({
        id: p.id, x: p.x, y: p.y, r: p.r, type: p.type,
        built: p.built, fails: p.fails, abandoned: !!p.abandoned,
        adopted: !!p.adopted, opportunistic: !!p.opportunistic, counted: !!p.counted,
        lx: p.lx, ly: p.ly, mx: p.mx, my: p.my, bored: p.bored || 0,
      })),
      storeIdx: n.plan.indexOf(n.storeNode),
      broodIdx: n.plan.indexOf(n.broodNode),
      queenIdx: n.plan.indexOf(n.queenNode),
      res: n.res, stats: n.stats, queen: n.queen,
      pendingSpoil: n.pendingSpoil, policy: n.policy,
    }));
  };

  nests.loadState = function (saved) {
    nests.list = [];
    nodeSeq = 0;
    for (const s of saved) {
      const nest = makeNest(s.id, { entrance: s.entrance, founding: s.founding });
      nest.alive = s.alive !== false;
      if (s.entrances && s.entrances.length) {
        nest.entrances = s.entrances.map(e => ({ x: e.x, y: e.y }));
      }
      // If the ground under a door was lowered on load (see lowerEdgePlateaus),
      // bring the door down with it rather than leave it hanging in the air.
      for (const e of [nest.entrance, ...nest.entrances]) {
        const ground = W.surfaceAt(e.x) + 1.5;
        if (e.y < ground - 1) e.y = ground;
      }
      nest.plan = s.plan.map(p => {
        const node = {
          id: p.id, x: p.x, y: p.y, r: p.r, type: p.type, built: p.built,
          claims: 0, fails: p.fails || 0, abandoned: !!p.abandoned,
          adopted: !!p.adopted, opportunistic: !!p.opportunistic, counted: !!p.counted,
          bored: p.bored || 0,
        };
        if (p.lx != null) { node.lx = p.lx; node.ly = p.ly; }
        if (p.mx != null) { node.mx = p.mx; node.my = p.my; }
        return node;
      });
      // Saves from before `adopted` was kept: a shaft whose column is already
      // one of the nest's doors is that door.
      for (const p of nest.plan) {
        if (p.type !== 'entrance' || p.adopted || p.abandoned) continue;
        if (nest.entrances.some(e => Math.floor(e.x) === Math.floor(p.x))) p.adopted = true;
      }
      nodeSeq = nest.plan.reduce((m, p) => Math.max(m, p.id + 1), nodeSeq);
      nest.storeNode = nest.plan[s.storeIdx] || null;
      nest.broodNode = nest.plan[s.broodIdx] || null;
      nest.queenNode = nest.plan[s.queenIdx] || null;
      nest.res.food = s.res.food; nest.res.water = s.res.water;
      nest.res.biomass = s.res.biomass;
      for (const k in nest.stats) if (s.stats[k] != null) nest.stats[k] = s.stats[k];
      nest.queen = s.queen;
      nest.pendingSpoil = s.pendingSpoil || 0;
      if (s.policy) nest.policy = s.policy;
      nests.list.push(nest);
    }
    nests.ready = true;
    W.fieldsStale = true;
    nests.rebuildFields();
  };
})();
