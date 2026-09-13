// The soil, the air, the smells, and the nest blueprint.
(function () {
  const AF = window.AF, C = AF.CFG, T = AF.T;

  // Dimensions are mutable: the farm grows outward as the nest reaches its
  // edges, which reallocates every grid below.
  let W = C.W, H = C.H;
  const BASE_W = C.W, BASE_H = C.H;   // size a brand new farm starts at

  let tiles, shade, alarm, surfY, baseY, bfsQueue, scratch, cacheScent;

  function allocate(w, h) {
    W = w; H = h;
    C.W = w; C.H = h;
    tiles = new Uint8Array(w * h);
    shade = new Uint8Array(w * h);      // per-tile texture noise, cosmetic
    alarm = new Float32Array(w * h);    // "danger here" — every nest smells it
    surfY = new Int16Array(w);          // ground line per column
    baseY = new Int16Array(w);          // where the ground was before any spoil

    bfsQueue = new Int32Array(w * h);
    scratch = new Float32Array(w * h);
    cacheScent = new Float32Array(w * h);   // static: rebuilt only when mined

    // Trail pheromone and navigation fields belong to individual nests, since
    // each colony lays and follows only its own. They reallocate themselves.
    if (AF.nests) AF.nests.allocate(w, h);
    if (AF.world) publish();
  }

  // Re-point the exported handles after a reallocation.
  function publish() {
    const o = AF.world;
    o.W = W; o.H = H;
    o.tiles = tiles; o.shade = shade; o.alarm = alarm;
    o.surfY = surfY; o.baseY = baseY; o.cacheScent = cacheScent;
  }

  allocate(C.W, C.H);

  const world = {
    W, H, tiles, shade, alarm, surfY, baseY, cacheScent,
    allocate,
    starts: [],          // where each nest was founded
    caches: [],          // buried food, and how much of each is left
    dirty: true,         // terrain changed -> fields & render cache stale
    fieldsStale: true,
  };
  AF.world = world;

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  world.idx = idx;
  world.inb = inb;

  world.tileAt = function (x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return T.ROCK;
    return tiles[y * W + x];
  };
  world.passable = function (x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return tiles[y * W + x] === T.AIR;
  };
  world.passableAt = function (fx, fy) {
    return world.passable(Math.floor(fx), Math.floor(fy));
  };
  world.setTile = function (x, y, v) {
    if (!inb(x, y)) return;
    tiles[y * W + x] = v;
    world.dirty = true;
    world.fieldsStale = true;
  };

  // ---------------------------------------------------------------- terrain

  function fbm(x, seed) {
    return Math.sin(x * 0.045 + seed) * 3.2
         + Math.sin(x * 0.11 + seed * 2.3) * 1.7
         + Math.sin(x * 0.27 + seed * 5.1) * 0.8;
  }

  // Carve one founding site: a shaft from the surface down to a small chamber.
  // A real founding queen digs this herself before any workers exist.
  function carveStart(ex) {
    const sy = surfY[ex];
    const fc = { x: ex + 0.5, y: sy + 11, r: 3.6 };
    for (let y = sy - 1; y <= fc.y; y++) {
      tiles[idx(ex, y)] = T.AIR;
      tiles[idx(ex + 1, y)] = T.AIR;
    }
    for (let y = Math.floor(fc.y - fc.r); y <= fc.y + fc.r; y++) {
      for (let x = Math.floor(fc.x - fc.r); x <= fc.x + fc.r; x++) {
        if (Math.hypot(x - fc.x, y - fc.y) <= fc.r && inb(x, y)) tiles[idx(x, y)] = T.AIR;
      }
    }
    return { entrance: { x: ex + 0.5, y: sy + 1.5 }, founding: fc, surface: sy };
  }

  world.carveStart = carveStart;

  world.generate = function (nests) {
    const seed = Math.random() * 100;
    // 0 is allowed: bare ground, with queens placed by hand afterwards.
    nests = Math.max(0, Math.min(3, nests == null ? 1 : Math.round(nests)));
    if (W !== BASE_W || H !== BASE_H) {
      allocate(BASE_W, BASE_H);        // a new farm starts small again
      if (AF.render && AF.render.worldResized) AF.render.worldResized(0);
    }
    tiles.fill(T.AIR);

    for (let x = 0; x < W; x++) {
      const top = Math.round(C.SKY + fbm(x, seed));
      surfY[x] = top;
      for (let y = top; y < H; y++) tiles[idx(x, y)] = T.SOIL;
    }

    // Bedrock floor and side walls so nobody digs off the edge.
    for (let x = 0; x < W; x++) {
      tiles[idx(x, H - 1)] = T.ROCK;
      tiles[idx(x, H - 2)] = T.ROCK;
    }
    for (let y = 0; y < H; y++) {
      tiles[idx(0, y)] = T.ROCK;
      tiles[idx(1, y)] = T.ROCK;
      tiles[idx(W - 1, y)] = T.ROCK;
      tiles[idx(W - 2, y)] = T.ROCK;
    }

    // Scattered stones the diggers have to route around, in proportion to the
    // ground — a wider farm with a fixed count reads as empty.
    const stones = Math.round(26 * (W / 240) * (H / 150));
    for (let n = 0; n < stones; n++) {
      const cx = 6 + Math.random() * (W - 12);
      const cy = C.SKY + 14 + Math.random() * (H - C.SKY - 20);
      const r = 2 + Math.random() * 4;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < r && inb(x, y) && tiles[idx(x, y)] === T.SOIL) tiles[idx(x, y)] = T.ROCK;
        }
      }
    }

    for (let i = 0; i < shade.length; i++) shade[i] = (Math.random() * 24) | 0;
    baseY.set(surfY);   // remember the untouched ground line

    // As far apart as the farm allows: one queen in the middle, two at
    // opposite ends, three at both ends and the middle. They start as
    // strangers with the whole farm between them.
    world.starts = [];
    const span = W - 80;
    for (let k = 0; k < nests; k++) {
      const frac = nests === 1 ? 0.5 : k / (nests - 1);
      const ex = Math.round(40 + span * frac);
      world.starts.push(carveStart(ex));
    }

    // Buried food, scattered after the shafts are cut so none of it is carved
    // away, and after the stones so none of it lands inside one.
    world.caches = [];
    const clusters = Math.round(C.CACHE_CLUSTERS * (W / 400) * (H / 200));
    world.scatterCaches(clusters, 20, W - 20, C.SKY + C.CACHE_MIN_DEPTH, H - 10);

    // Give every colony something it can actually find. Left purely to chance,
    // whether a nest ever strikes buried food is a lottery, and a mechanic
    // nobody ever sees may as well not exist.
    for (const start of world.starts) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = start.entrance.x + side * (24 + Math.random() * 14);
      world.scatterCaches(1, x - 6, x + 6,
        start.surface + 22, start.surface + 48);
    }

    // And put something worth having in the ground between neighbours. A fixed
    // prize both colonies can reach is the cleanest reason for them to meet —
    // better than waiting for one of them to get hungry enough. Set in from the
    // midpoint so it is inside each nest's digging reach, not beyond both.
    for (let k = 1; k < world.starts.length; k++) {
      const a = world.starts[k - 1].entrance.x, b = world.starts[k].entrance.x;
      for (const f of [0.38, 0.62]) {
        const x = a + (b - a) * f;
        world.scatterCaches(1, x - 8, x + 8,
          C.SKY + C.CACHE_MIN_DEPTH + 8, C.SKY + (H - C.SKY) * 0.5);
      }
    }

    // NOTE: surfY is the *terrain* profile, set above before any carving.
    // Do not rescan it from "first air tile" — a vertical shaft would then read
    // as open sky all the way down and ants inside it would think they were
    // outdoors.
    world.dirty = true;
    world.fieldsStale = true;
  };

  world.nodeProgress = function (n) {
    let total = 0, open = 0;
    const r = n.r;
    for (let y = Math.floor(n.y - r); y <= n.y + r; y++) {
      for (let x = Math.floor(n.x - r); x <= n.x + r; x++) {
        if (Math.hypot(x - n.x, y - n.y) > r) continue;
        const t = world.tileAt(x, y);
        if (t === T.ROCK) continue;
        total++;
        if (t === T.AIR) open++;
      }
    }
    return total === 0 ? 1 : open / total;
  };

  // Find a soil tile inside a chamber node that still needs removing.
  // Scored from the digger's own position when one is given, so it works the
  // face in front of it instead of crossing the room to a "better" tile.
  world.diggableInNode = function (n, ax, ay) {
    const r = n.r;
    const fromX = ax != null ? ax : n.x;
    const fromY = ay != null ? ay : n.y;
    let best = -1, bestD = 1e9;
    for (let y = Math.floor(n.y - r); y <= n.y + r; y++) {
      for (let x = Math.floor(n.x - r); x <= n.x + r; x++) {
        if (Math.hypot(x - n.x, y - n.y) > r) continue;
        const t = world.tileAt(x, y);
        if (!world.isDiggable(t)) continue;
        // prefer tiles already touching open air — chambers grow from the inside out
        const exposed = world.passable(x - 1, y) || world.passable(x + 1, y) ||
                        world.passable(x, y - 1) || world.passable(x, y + 1);
        const score = Math.hypot(x - fromX, y - fromY) - (exposed ? 4 : 0);
        if (score < bestD) { bestD = score; best = idx(x, y); }
      }
    }
    return best;
  };

  // ------------------------------------------------------------- surface line

  // Keep the ground line in step with local edits only. Spoil dumped on top
  // raises it; soil dug away just below it lowers it by a row or two. The
  // search is deliberately capped so a deep shaft never drags the "surface"
  // down with it.
  world.refreshColumn = function (x) {
    if (x < 1 || x >= W - 1) return;
    // Spoil raises the ground line; digging NEVER lowers it. If a tunnel that
    // breaks the surface were allowed to drag "ground level" down with it, the
    // line would walk deeper with every cut and diggers would start dumping
    // their spoil inside the chambers — sealing tunnels and burying ants.
    while (surfY[x] > 1 && tiles[idx(x, surfY[x] - 1)] !== T.AIR) surfY[x]--;
  };

  world.refreshSurface = function () {
    for (let x = 1; x < W - 1; x++) world.refreshColumn(x);
  };

  // ------------------------------------------------------------- buried food
  //
  // Caches of something edible, sealed in the soil. They give digging a payoff
  // and a direction, and — being fixed and finite — something two colonies can
  // want at the same time.
  //
  // The smell they give off is a static field: it only changes when a cache is
  // mined out, so unlike the trail pheromones it is computed on change rather
  // than diffused every tick, and costs essentially nothing to keep.

  world.isDiggable = function (t) {
    return t === T.SOIL || t === T.MOUND || t === T.CACHE;
  };

  world.scatterCaches = function (count, x0, x1, y0, y1) {
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const cx = x0 + Math.random() * (x1 - x0);
        const cy = y0 + Math.random() * (y1 - y0);
        if (cy < C.SKY + C.CACHE_MIN_DEPTH) continue;
        if (cy > H - 8) continue;
        if (tiles[idx(Math.floor(cx), Math.floor(cy))] !== T.SOIL) continue;

        const r = C.CACHE_RADIUS * (0.7 + Math.random() * 0.8);
        let placed = 0;
        for (let y = Math.floor(cy - r); y <= cy + r; y++) {
          for (let x = Math.floor(cx - r); x <= cx + r; x++) {
            if (!inb(x, y)) continue;
            if (Math.hypot(x - cx, y - cy) > r) continue;
            if (tiles[idx(x, y)] !== T.SOIL) continue;
            tiles[idx(x, y)] = T.CACHE;
            placed++;
          }
        }
        if (placed) world.caches.push({ x: cx, y: cy, r, tiles: placed });
        break;
      }
    }
    world.rebuildCacheScent();
  };

  // Splat a falloff around every cache that still has tiles left. Called when
  // the ground changes, not on a timer.
  world.rebuildCacheScent = function () {
    cacheScent.fill(0);
    const R = C.CACHE_SCENT_RANGE;
    for (const c of world.caches) {
      if (c.tiles <= 0) continue;
      const strength = Math.min(1, c.tiles / 14);
      for (let y = Math.floor(c.y - R); y <= c.y + R; y++) {
        for (let x = Math.floor(c.x - R); x <= c.x + R; x++) {
          if (!inb(x, y)) continue;
          const d = Math.hypot(x - c.x, y - c.y);
          if (d > R) continue;
          const v = strength * (1 - d / R);
          const i = idx(x, y);
          if (v > cacheScent[i]) cacheScent[i] = v;
        }
      }
    }
    world.cacheScent = cacheScent;
  };

  world.sampleCache = function (fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return 0;
    return cacheScent[y * W + x];
  };

  // Which way does the buried food smell strongest from here?
  world.cacheUphill = function (fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return NaN;
    let best = cacheScent[y * W + x], bx = 0, by = 0, found = false;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx * 2, ny = y + dy * 2;
        if (!inb(nx, ny)) continue;
        const v = cacheScent[ny * W + nx];
        if (v > best) { best = v; bx = dx; by = dy; found = true; }
      }
    }
    return found ? Math.atan2(by, bx) : NaN;
  };

  // A digger cut into one. Book the loss against the cluster so the smell fades
  // as it is worked out.
  world.mineCache = function (x, y) {
    let nearest = null, bd = Infinity;
    for (const c of world.caches) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bd) { bd = d; nearest = c; }
    }
    if (nearest && bd < nearest.r + 2) {
      nearest.tiles--;
      if (nearest.tiles <= 0 || Math.random() < 0.25) world.rebuildCacheScent();
    }
    return C.CACHE_YIELD;
  };

  // ---------------------------------------------------------------- spoil
  // Loose soil behaves like loose soil: tip it on a heap and it slides down the
  // sides. Without this, ants dumping in one spot raise a sheer tower, because
  // nothing ever tells a stack of tiles that it is too steep to stand up.

  function canRest(x, y) {
    if (y < C.SPOIL_CEILING || tiles[idx(x, y)] !== T.AIR ||
        tiles[idx(x, y + 1)] === T.AIR) return false;
    // Never onto a shaft that is still being cut. One check here covers
    // dumping, sliding and weathering alike.
    if (AF.nests && AF.nests.shaftGuarded(x)) return false;
    // Loose soil can't sit on a spike. Beside a guarded shaft a grain had
    // nowhere to slide, so each load stacked on the last into a one-tile tower
    // 25 high. It has to find somewhere with shoulders instead.
    if (x > 0 && x < W - 1 &&
        surfY[x - 1] - y > C.SPOIL_STEP + 1 && surfY[x + 1] - y > C.SPOIL_STEP + 1) return false;
    return true;
  }

  // Let one grain roll downhill until the slope everywhere it passes is gentle
  // enough to hold it. Classic sandpile relaxation — the mound shape and its
  // maximum height for a given base both fall out of this one rule.
  function settle(x) {
    let cx = x;
    for (let step = 0; step < 80; step++) {
      const top = surfY[cx];
      if (top < 1 || tiles[idx(cx, top)] !== T.MOUND) break;   // only spoil slides

      const lDrop = cx > 2 ? surfY[cx - 1] - top : -1;
      const rDrop = cx < W - 3 ? surfY[cx + 1] - top : -1;
      if (lDrop <= C.SPOIL_STEP && rDrop <= C.SPOIL_STEP) break;

      let target;
      if (lDrop === rDrop) target = Math.random() < 0.5 ? cx - 1 : cx + 1;
      else target = lDrop > rDrop ? cx - 1 : cx + 1;

      const dropY = surfY[target] - 1;
      if (!canRest(target, dropY)) break;

      tiles[idx(cx, top)] = T.AIR;
      surfY[cx] = top + 1;
      tiles[idx(target, dropY)] = T.MOUND;
      surfY[target] = dropY;
      cx = target;
    }
  }

  // How thick the spoil lies over the original ground at this column.
  world.spoilDepth = function (fx) {
    const x = Math.max(0, Math.min(W - 1, Math.floor(fx)));
    return baseY[x] - surfY[x];
  };

  // Weathering. Rain and wind work a heap down: grains creep from high ground
  // to low, so the peak never climbs away — it flattens and spreads instead.
  // Nothing is destroyed, only moved, so the soil still balances. Only loose
  // spoil weathers; the original ground stays where it is.
  let erodeCursor = 0;
  world.erode = function (samples) {
    for (let k = 0; k < samples; k++) {
      erodeCursor = (erodeCursor + 7919) % W;   // stride coprime with most widths
      const x = erodeCursor;
      if (x < 3 || x >= W - 3) continue;

      const top = surfY[x];
      if (top < 1 || tiles[idx(x, top)] !== T.MOUND) continue;

      // Old spoil underneath consolidates into ordinary ground, which is how
      // the heap stops reading as a pile and starts reading as new surface.
      if (top + 2 < H && tiles[idx(x, top + 2)] === T.MOUND &&
          Math.random() < C.COMPACT_CHANCE) {
        tiles[idx(x, top + 2)] = T.SOIL;
        world.dirty = true;
      }

      // Creep downhill on any drop at all — gentler than the avalanche rule,
      // which only fires on a step steeper than the soil can hold.
      const l = surfY[x - 1], r = surfY[x + 1];
      let target = -1;
      if (l > top && r > top) target = l > r ? x - 1 : x + 1;
      else if (l > top) target = x - 1;
      else if (r > top) target = x + 1;
      if (target < 0) continue;   // flat ground is stable; only slopes creep

      const dropY = surfY[target] - 1;
      if (!canRest(target, dropY)) continue;

      tiles[idx(x, top)] = T.AIR;
      surfY[x] = top + 1;
      tiles[idx(target, dropY)] = T.MOUND;
      surfY[target] = dropY;
      world.dirty = true;
      world.fieldsStale = true;
    }
  };

  // Drop one load of spoil near a column, then let it find its own level.
  world.placeSpoil = function (nearX) {
    for (let d = 0; d <= 12; d++) {
      const a = d === 0 ? [nearX] : [nearX - d, nearX + d];
      for (let k = 0; k < a.length; k++) {
        const cx = a[k];
        if (cx < 2 || cx >= W - 2) continue;
        const ty = surfY[cx] - 1;
        if (!canRest(cx, ty)) continue;
        tiles[idx(cx, ty)] = T.MOUND;
        surfY[cx] = ty;
        settle(cx);
        world.dirty = true;
        world.fieldsStale = true;
        return true;
      }
    }
    return false;
  };
  world.surfaceAt = function (fx) {
    const x = Math.max(0, Math.min(W - 1, Math.floor(fx)));
    return surfY[x];
  };
  world.isAboveGround = function (fx, fy) {
    return fy < world.surfaceAt(fx) - 0.5;
  };

  // ------------------------------------------------------------- pheromones

  world.depositAlarm = function (fx, fy, amt) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return;
    const i = idx(x, y);
    alarm[i] = Math.min(C.PH_MAX, alarm[i] + amt);
  };
  world.sampleAlarm = function (fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return 0;
    return alarm[idx(x, y)];
  };

  let diffuseTick = 0;

  // Alarm is shared ground truth — a fight smells the same to everyone. Trail
  // is private to each nest and decays with it.
  world.decayPheromones = function () {
    // On a big farm the decay sweep is the most expensive thing in the tick, so
    // run it half as often and square the factor to keep the same curve.
    const big = W * H > 90000;
    const skip = big && (diffuseTick & 1);
    diffuseTick++;
    if (!skip) {
      const da = big ? 0.985 * 0.985 : 0.985;
      for (let i = 0; i < alarm.length; i++) {
        alarm[i] *= da;
        if (alarm[i] < 0.002) alarm[i] = 0;
      }
      if (diffuseTick % C.PH_DIFFUSE_EVERY === 0) blur(alarm, 0.22);
    }
    if (AF.nests) AF.nests.decayTrails(big, skip, diffuseTick);
  };

  world.blur = blur;
  world.bigWorld = function () { return W * H > 90000; };

  function blur(f, k) {
    scratch.set(f);
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (tiles[i] !== T.AIR) { f[i] = 0; continue; }
        const s = scratch[i - 1] + scratch[i + 1] + scratch[i - W] + scratch[i + W];
        f[i] = scratch[i] * (1 - k) + (s * 0.25) * k;
      }
    }
  }

  // --------------------------------------------------------- navigation fields

  function bfs(field, seedTiles) {
    field.fill(-1);
    let qt = 0, qh = 0;
    for (let s = 0; s < seedTiles.length; s++) {
      const t = seedTiles[s];
      if (t < 0 || field[t] === 0) continue;
      field[t] = 0;
      bfsQueue[qt++] = t;
    }
    while (qh < qt) {
      const c = bfsQueue[qh++];
      const d = field[c] + 1;
      const cx = c % W;
      // 4-neighbour flood; gradient descent later reads 8 neighbours
      if (cx > 0)     tryPush(field, c - 1, d, qt) && (bfsQueue[qt++] = c - 1);
      if (cx < W - 1) tryPush(field, c + 1, d, qt) && (bfsQueue[qt++] = c + 1);
      if (c >= W)     tryPush(field, c - W, d, qt) && (bfsQueue[qt++] = c - W);
      if (c < W * H - W) tryPush(field, c + W, d, qt) && (bfsQueue[qt++] = c + W);
    }
  }

  function tryPush(field, n, d) {
    if (field[n] !== -1) return false;
    if (tiles[n] !== T.AIR) return false;
    field[n] = d;
    return true;
  }

  // Seeds = the open tiles inside a chamber (or the centre, if still solid).
  function seedsFor(node) {
    const out = [];
    if (!node) return out;
    const r = node.r;
    for (let y = Math.floor(node.y - r); y <= node.y + r; y++) {
      for (let x = Math.floor(node.x - r); x <= node.x + r; x++) {
        if (Math.hypot(x - node.x, y - node.y) > r) continue;
        if (world.passable(x, y)) out.push(idx(x, y));
      }
    }
    return out;
  }

  // Navigation primitives. Each nest owns its own set of fields and floods them
  // from its own chambers; the world just supplies the machinery.
  world.bfs = bfs;
  world.seedsFor = seedsFor;

  world.entranceSeeds = function (entrance) {
    const ex = Math.floor(entrance.x), ey = Math.floor(entrance.y);
    const seeds = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        if (world.passable(ex + dx, ey + dy)) seeds.push(idx(ex + dx, ey + dy));
      }
    }
    if (!seeds.length) seeds.push(idx(ex, ey));
    return seeds;
  };

  world.fieldAt = function (field, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return -1;
    return field[y * W + x];
  };

  // ------------------------------------------------------------- expansion
  // The farm grows outward as the nest approaches its edges. Everything that
  // holds a coordinate has to shift when we add ground on the left.

  world.expand = function (addLeft, addRight, addDown) {
    addLeft = Math.max(0, addLeft | 0);
    addRight = Math.max(0, addRight | 0);
    addDown = Math.max(0, addDown | 0);
    if (!addLeft && !addRight && !addDown) return 0;

    const newW = Math.min(C.MAX_W, W + addLeft + addRight);
    const newH = Math.min(C.MAX_H, H + addDown);
    if (newW === W && newH === H) return 0;
    if (newW < W + addLeft + addRight) { addRight = newW - W - addLeft; }
    if (addRight < 0) { addLeft = newW - W; addRight = 0; }
    addDown = newH - H;

    const oldW = W, oldH = H, oldTiles = tiles, oldSurf = surfY, oldBase = baseY;
    const oldAlarm = alarm;
    const oldTrails = AF.nests ? AF.nests.takeTrails() : [];

    allocate(newW, newH);

    // 1. the old farm, shifted right by however much ground we added on the left
    for (let y = 0; y < oldH; y++) {
      const src = y * oldW, dst = y * newW + addLeft;
      for (let x = 0; x < oldW; x++) {
        tiles[dst + x] = oldTiles[src + x];
        alarm[dst + x] = oldAlarm[src + x];
      }
    }
    if (AF.nests) AF.nests.restoreTrails(oldTrails, oldW, oldH, addLeft);
    for (let x = 0; x < oldW; x++) {
      surfY[x + addLeft] = oldSurf[x];
      baseY[x + addLeft] = oldBase[x];
    }

    // 2. new ground to the sides, continuing the profile at the edge
    // Continue from the first real ground in from each wall. The wall columns
    // themselves are pinned to row 1 (see rim), and continuing from those put
    // the new ground almost at the top of the jar — a sheer wall at each edge.
    const leftBase = oldBase[2], rightBase = oldBase[oldW - 3];
    for (let x = 0; x < addLeft; x++) fillColumn(x, leftBase, addLeft - x);
    for (let x = 0; x < addRight; x++) fillColumn(newW - addRight + x, rightBase, x + 1);

    // 3. new ground underneath
    for (let y = oldH; y < newH; y++) {
      for (let x = 0; x < newW; x++) tiles[y * newW + x] = T.SOIL;
    }

    // 4. the old bedrock rim is interior ground now — it must be diggable, or
    //    the colony stays walled inside its original box
    if (addLeft) for (let k = 0; k < 2; k++) openWall(addLeft + k);
    if (addRight) for (let k = 0; k < 2; k++) openWall(addLeft + oldW - 1 - k);
    if (addDown) {
      for (let k = 0; k < 2; k++) {
        const y = oldH - 1 - k;
        for (let x = 0; x < newW; x++) {
          if (tiles[y * newW + x] === T.ROCK) tiles[y * newW + x] = T.SOIL;
        }
      }
    }

    // 5. stones in the new ground, then a fresh rim around everything
    scatterStones(addLeft, addRight, oldH, addDown, newW, newH);

    // Buried food in the new ground too, or expanding would open up a barren
    // frontier the diggers have no reason to go near.
    for (const c of world.caches) c.x += addLeft;
    const fresh = Math.round(C.CACHE_CLUSTERS *
      ((addLeft + addRight) * newH + newW * addDown) / (400 * 200));
    if (addLeft) world.scatterCaches(fresh, 12, addLeft + 8, C.SKY + C.CACHE_MIN_DEPTH, newH - 10);
    if (addRight) world.scatterCaches(fresh, newW - addRight - 8, newW - 12, C.SKY + C.CACHE_MIN_DEPTH, newH - 10);
    if (addDown) world.scatterCaches(fresh, 20, newW - 20, oldH, newH - 10);
    for (let i = 0; i < shade.length; i++) shade[i] = (Math.random() * 24) | 0;
    rim();

    world.dirty = true;
    world.fieldsStale = true;
    world.refreshSurface();
    return addLeft;
  };

  function fillColumn(x, base, dist) {
    const top = Math.max(6, Math.min(H - 20,
      Math.round(base + Math.sin(dist * 0.21) * 2.4 + (Math.random() - 0.5) * 1.4)));
    surfY[x] = top;
    baseY[x] = top;
    for (let y = 0; y < top; y++) tiles[y * W + x] = T.AIR;
    for (let y = top; y < H; y++) tiles[y * W + x] = T.SOIL;
  }

  function openWall(x) {
    if (x < 0 || x >= W) return;
    for (let y = 0; y < H; y++) {
      if (tiles[y * W + x] !== T.ROCK) continue;
      tiles[y * W + x] = y < surfY[x] ? T.AIR : T.SOIL;
    }
  }

  function scatterStones(addLeft, addRight, oldH, addDown, newW, newH) {
    const blobs = Math.round((addLeft + addRight) * 0.35 + addDown * 1.2);
    for (let n = 0; n < blobs; n++) {
      let cx, cy;
      if (addDown && (n % 2 || !(addLeft + addRight))) {
        cx = 6 + Math.random() * (newW - 12);
        cy = oldH + Math.random() * addDown;
      } else {
        cx = addLeft ? (Math.random() < 0.5 ? Math.random() * addLeft
                                            : newW - Math.random() * Math.max(1, addRight))
                     : newW - Math.random() * Math.max(1, addRight);
        cy = C.SKY + 14 + Math.random() * (newH - C.SKY - 20);
      }
      const r = 2 + Math.random() * 4;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          if (!inb(x, y)) continue;
          if (Math.hypot(x - cx, y - cy) >= r) continue;
          if (tiles[y * W + x] === T.SOIL) tiles[y * W + x] = T.ROCK;
        }
      }
    }
  }

  function rim() {
    for (let x = 0; x < W; x++) {
      tiles[(H - 1) * W + x] = T.ROCK;
      tiles[(H - 2) * W + x] = T.ROCK;
    }
    for (let y = 0; y < H; y++) {
      tiles[y * W] = T.ROCK;
      tiles[y * W + 1] = T.ROCK;
      tiles[y * W + W - 1] = T.ROCK;
      tiles[y * W + W - 2] = T.ROCK;
    }
    // The side walls are solid to the top. Keep their ground line and original
    // ground line equal, or they read as an enormous heap of spoil.
    for (const x of [0, 1, W - 2, W - 1]) { surfY[x] = 1; baseY[x] = 1; }
  }

  // Farms that widened before that fix have a slab of ground at each edge
  // standing almost to the top of the jar. Natural ground never rises more
  // than a few rows above the sky line, so anything far above it is one of
  // those slabs: lower it to the nearest real ground. Only solid ground above
  // that height goes; tunnels are left alone.
  function lowerEdgePlateaus() {
    const ceiling = C.SKY - 12;
    let fixed = 0;
    for (let x = 2; x < W - 2; x++) {
      if (baseY[x] >= ceiling) continue;
      let target = -1;
      for (let d = 1; d < W && target < 0; d++) {
        for (const nx of [x - d, x + d]) {
          if (nx < 2 || nx >= W - 2 || baseY[nx] < ceiling) continue;
          target = baseY[nx];
          break;
        }
      }
      if (target < 0) target = C.SKY;
      for (let y = 0; y < target; y++) tiles[y * W + x] = T.AIR;
      surfY[x] = target;
      baseY[x] = target;
      fixed++;
    }
    return fixed;
  }
  world.lowerEdgePlateaus = lowerEdgePlateaus;

  // ------------------------------------------------------------ save / load

  function toB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function fromB64(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  world.toB64 = toB64;
  world.fromB64 = fromB64;

  world.saveState = function () {
    return {
      w: W, h: H,
      tiles: toB64(tiles),
      surfY: Array.from(surfY),
      baseY: Array.from(baseY),
      // The cache tiles are already in the tile blob; this is just how much of
      // each cluster is left, so the smell can be rebuilt.
      caches: world.caches.map(c => ({ x: c.x, y: c.y, r: c.r, tiles: c.tiles })),
    };
  };

  world.loadState = function (s) {
    // A saved farm may have grown past the starting size.
    if (s.w && s.h && (s.w !== W || s.h !== H)) {
      allocate(s.w, s.h);
      if (AF.render && AF.render.worldResized) AF.render.worldResized(0);
    }
    tiles.set(fromB64(s.tiles));
    for (let i = 0; i < surfY.length; i++) {
      surfY[i] = s.surfY[i];
      baseY[i] = s.baseY ? s.baseY[i] : s.surfY[i];
    }
    // shade is cosmetic noise; regenerate rather than store 36KB of it
    for (let i = 0; i < shade.length; i++) shade[i] = (Math.random() * 24) | 0;

    lowerEdgePlateaus();

    world.caches = (s.caches || []).map(c => ({ x: c.x, y: c.y, r: c.r, tiles: c.tiles }));
    world.rebuildCacheScent();

    world.dirty = true;
    world.fieldsStale = true;
  };

  // Direction that steps downhill on `field` (i.e. toward its source).
  // Returns an angle, or NaN when the ant has no reading to go on.
  world.downhill = function (field, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return NaN;
    const here = field[y * W + x];
    let best = here < 0 ? Infinity : here, bx = 0, by = 0, found = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const v = field[ny * W + nx];
        if (v < 0) continue;
        // don't cut diagonal corners through solid rock
        if (dx && dy && !(world.passable(x + dx, y) || world.passable(x, y + dy))) continue;
        if (v < best) { best = v; bx = dx; by = dy; found = true; }
      }
    }
    if (!found) return NaN;
    return Math.atan2(by + 0.5 - 0.5, bx);
  };

  // Direction that steps uphill — used for "get away from home".
  world.uphill = function (field, fx, fy) {
    const x = Math.floor(fx), y = Math.floor(fy);
    if (!inb(x, y)) return NaN;
    const here = field[y * W + x];
    if (here < 0) return NaN;
    let best = here, bx = 0, by = 0, found = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const v = field[ny * W + nx];
        if (v < 0) continue;
        if (dx && dy && !(world.passable(x + dx, y) || world.passable(x, y + dy))) continue;
        if (v > best) { best = v; bx = dx; by = dy; found = true; }
      }
    }
    if (!found) return NaN;
    return Math.atan2(by, bx);
  };
})();
