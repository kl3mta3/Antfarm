// Drawing the farm.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, col = AF.colony;
  const T = AF.T, CASTE = AF.CASTE, CARRY = AF.CARRY;
  const A = col.A, B = col.B;

  const R = {
    cam: { x: 0, y: 0, zoom: 1 },
    showPheromones: false,
    showPlan: false,
    selected: -1,
    follow: false,
  };
  AF.render = R;

  let canvas, ctx, terrCanvas, terrCtx, terrData, phCanvas, phCtx, phData;
  let phFrame = 0;

  R.init = function (cv) {
    canvas = cv;
    ctx = cv.getContext('2d', { alpha: false });

    terrCanvas = document.createElement('canvas');
    terrCanvas.width = C.W; terrCanvas.height = C.H;
    terrCtx = terrCanvas.getContext('2d');
    terrData = terrCtx.createImageData(C.W, C.H);

    phCanvas = document.createElement('canvas');
    phCanvas.width = C.W; phCanvas.height = C.H;
    phCtx = phCanvas.getContext('2d');
    phData = phCtx.createImageData(C.W, C.H);

    R.fit();
  };

  // The farm got bigger: rebuild the raster caches at the new size. If the
  // view was showing the whole farm, keep showing the whole farm — that is the
  // slow zoom-out as the colony spreads. Otherwise hold the view still.
  R.worldResized = function (shiftX) {
    const wasFitted = Math.abs(R.cam.zoom - canvas.width / (terrCanvas.width * C.TILE)) < 0.02;

    terrCanvas.width = C.W; terrCanvas.height = C.H;
    terrData = terrCtx.createImageData(C.W, C.H);
    phCanvas.width = C.W; phCanvas.height = C.H;
    phData = phCtx.createImageData(C.W, C.H);
    W.dirty = true;

    if (wasFitted) R.fit();
    else R.cam.x += shiftX || 0;
    clampCam();
  };

  // The drawing surface changed size (window, pane, sidebar). Keep whatever the
  // viewer was looking at: if they were showing the whole farm, keep showing
  // the whole farm; otherwise hold the zoom and just re-clamp.
  R.viewportChanged = function () {
    const fitZoom = canvas.width / (C.W * C.TILE);
    const wasFitted = Math.abs(R.cam.zoom - fitZoom) < 0.02;
    R.resize();
    if (wasFitted) R.fit();
    clampCam();
  };

  R.resize = function () {
    const rect = canvas.parentElement.getBoundingClientRect();
    // A hidden or collapsed pane reports 0×0. Sizing to that would divide the
    // zoom to nothing and leave the view broken once it comes back.
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    R.dpr = dpr;
  };

  R.fit = function () {
    if (!canvas.width || !canvas.height) return;
    const z = canvas.width / (C.W * C.TILE);
    R.cam.zoom = z;
    R.cam.x = 0;
    R.cam.y = Math.max(0, (C.H - canvas.height / (z * C.TILE)) * 0.15);
  };

  const scale = () => R.cam.zoom * C.TILE;
  R.screenToWorld = function (sx, sy) {
    const s = scale();
    return { x: R.cam.x + sx * R.dpr / s, y: R.cam.y + sy * R.dpr / s };
  };

  // ------------------------------------------------------------ terrain cache

  function rebuildTerrain() {
    const d = terrData.data;
    const tiles = W.tiles, shade = W.shade;
    for (let y = 0; y < C.H; y++) {
      const above = y;
      for (let x = 0; x < C.W; x++) {
        const i = y * C.W + x;
        const p = i * 4;
        const t = tiles[i];
        const v = shade[i];
        let r, g, b;
        if (t === T.AIR) {
          if (above < W.surfY[x]) {           // open sky above the soil line
            const k = y / Math.max(1, W.surfY[x]);
            r = 22 + k * 14; g = 27 + k * 16; b = 38 + k * 14;
          } else {                              // excavated tunnel
            r = 20; g = 15; b = 12;
          }
        } else if (t === T.SOIL) {
          const depth = Math.min(1, (y - C.SKY) / (C.H - C.SKY));
          r = 104 - depth * 34 + v - 12;
          g = 74 - depth * 26 + v * 0.8 - 10;
          b = 48 - depth * 18 + v * 0.5 - 6;
        } else if (t === T.MOUND) {
          r = 132 + v - 12; g = 100 + v * 0.8 - 10; b = 66 + v * 0.5 - 6;
        } else if (t === T.CACHE) {              // something edible, buried
          r = 96 + v * 0.5; g = 118 + v * 0.7; b = 52 + v * 0.4;
        } else {                                 // rock
          r = 72 + v * 0.6; g = 74 + v * 0.6; b = 84 + v * 0.6;
        }
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    terrCtx.putImageData(terrData, 0, 0);
    W.dirty = false;
  }

  // Each nest's trail is drawn in that nest's own colour, so at a glance you
  // can see whose ground is whose — and where two colonies overlap.
  function rebuildPheromones() {
    const d = phData.data;
    const al = W.alarm;
    const list = AF.nests.list;
    const rgb = list.map(n => hexToRgb(n.colors.tint));

    for (let i = 0; i < al.length; i++) {
      const p = i * 4;
      let r = 0, g = 0, b = 0, strength = 0;
      for (let k = 0; k < list.length; k++) {
        const t = Math.min(1, list[k].trail[i] / 2.2);
        if (t < 0.01) continue;
        r += rgb[k][0] * t; g += rgb[k][1] * t; b += rgb[k][2] * t;
        strength += t;
      }
      const a = Math.min(1, al[i] / 2.2);
      if (strength < 0.01 && a < 0.01) { d[p + 3] = 0; continue; }
      if (strength > 0) { r /= strength; g /= strength; b /= strength; }
      d[p] = Math.min(255, r + a * 215);
      d[p + 1] = Math.min(255, g * (1 - a * 0.6));
      d[p + 2] = Math.min(255, b * (1 - a * 0.6));
      d[p + 3] = Math.min(210, (strength + a) * 170);
    }
    phCtx.putImageData(phData, 0, 0);
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ------------------------------------------------------------------ drawing

  R.draw = function () {
    const s = scale();
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (R.follow && R.selected >= 0 && A.alive[R.selected]) {
      const viewW = canvas.width / s, viewH = canvas.height / s;
      R.cam.x = A.x[R.selected] - viewW / 2;
      R.cam.y = A.y[R.selected] - viewH / 2;
      clampCam();
    }

    if (W.dirty) rebuildTerrain();

    ctx.save();
    ctx.setTransform(s, 0, 0, s, -R.cam.x * s, -R.cam.y * s);
    ctx.imageSmoothingEnabled = false;

    ctx.drawImage(terrCanvas, 0, 0, C.W, C.H);

    if (R.showPheromones) {
      if (phFrame++ % 4 === 0) rebuildPheromones();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(phCanvas, 0, 0, C.W, C.H);
      ctx.globalAlpha = 1;
    }

    if (R.showPlan) drawPlan();
    drawStores();
    drawPiles();
    drawPuddles();
    drawBrood();
    drawCorpses();
    drawAnts(s);
    drawIntruders();
    drawSelection(s);

    ctx.restore();
  };

  function clampCam() {
    const s = scale();
    const viewW = canvas.width / s, viewH = canvas.height / s;
    R.cam.x = Math.max(-2, Math.min(C.W - viewW + 2, R.cam.x));
    R.cam.y = Math.max(-2, Math.min(C.H - viewH + 2, R.cam.y));
    if (viewW > C.W) R.cam.x = (C.W - viewW) / 2;
    if (viewH > C.H) R.cam.y = (C.H - viewH) / 2;
  }
  R.clampCam = clampCam;

  function drawPlan() {
    ctx.lineWidth = 0.25;
    for (const nest of AF.nests.list) {
      for (const n of nest.plan) {
        const prog = W.nodeProgress(n);
        ctx.strokeStyle = n.abandoned ? 'rgba(120,120,130,0.35)'
          : n.built >= 1 ? 'rgba(90,200,140,0.5)' : 'rgba(240,200,90,0.55)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.stroke();
        if (n.built < 1) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * Math.max(0.05, prog), 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(240,200,90,0.25)';
          ctx.stroke();
        }
      }
    }
  }

  // Each nest's larder, drawn as a heap that grows with its stockpile.
  function drawStores() {
    for (const nest of AF.nests.list) {
      if (!nest.alive) continue;
      const st = AF.nests.store(nest);
      const food = Math.min(260, nest.res.food);
      const water = Math.min(260, nest.res.water);
      const n = Math.floor(food / 6);
      ctx.fillStyle = '#8fbf4a';
      for (let k = 0; k < n; k++) {
        const a = (k * 2.399) % (Math.PI * 2);
        const rr = st.r * 0.78 * Math.sqrt(k / Math.max(1, n));
        ctx.fillRect(st.x + Math.cos(a) * rr - 0.25, st.y + Math.sin(a) * rr - 0.25, 0.55, 0.55);
      }
      const nw = Math.floor(water / 8);
      ctx.fillStyle = 'rgba(90,170,230,0.85)';
      for (let k = 0; k < nw; k++) {
        const a = (k * 2.399 + 1.2) % (Math.PI * 2);
        const rr = st.r * 0.55 * Math.sqrt(k / Math.max(1, nw));
        ctx.beginPath();
        ctx.arc(st.x + Math.cos(a) * rr, st.y + Math.sin(a) * rr + 0.6, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawPiles() {
    for (const p of col.piles) {
      const n = Math.max(1, Math.min(70, Math.floor(p.amount / 2)));
      ctx.fillStyle = '#9ed14f';
      for (let k = 0; k < n; k++) {
        const a = (k * 2.399 + p.seed) % (Math.PI * 2);
        const rr = 2.4 * Math.sqrt(k / n);
        ctx.fillRect(p.x + Math.cos(a) * rr - 0.3, p.y + Math.sin(a) * rr * 0.45 - 0.3, 0.62, 0.62);
      }
    }
  }

  function drawPuddles() {
    for (const p of col.puddles) {
      const w = 1.2 + 3.2 * (p.amount / Math.max(1, p.max));
      ctx.fillStyle = 'rgba(70,150,225,0.75)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 0.35, w, 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(160,215,255,0.5)';
      ctx.beginPath();
      ctx.ellipse(p.x - w * 0.25, p.y + 0.15, w * 0.35, 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The dead, in the colours of whoever they belonged to, drained and pale.
  // A body being carried is drawn under its bearer.
  function drawCorpses() {
    for (const c of col.corpses) {
      const nest = AF.nests.get(c.nest);
      ctx.fillStyle = nest ? nest.colors.undertaker : '#6b6470';
      ctx.globalAlpha = c.held >= 0 ? 0.95 : Math.max(0.35, 1 - c.age / C.CORPSE_ROT);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 0.55, 0.32, 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawBrood() {
    for (let b = 0; b < C.MAX_BROOD; b++) {
      if (!B.alive[b]) continue;
      const st = B.stage[b];
      if (st === 0) {
        ctx.fillStyle = '#f0ead6';
        ctx.beginPath();
        ctx.ellipse(B.x[b], B.y[b], 0.42, 0.28, 0.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (st === 1) {
        const grow = 0.45 + 0.35 * Math.min(1, B.t[b] / C.LARVA_T);
        ctx.fillStyle = B.fed[b] > 20 ? '#f6e7bd' : '#cdbd95';
        ctx.beginPath();
        ctx.ellipse(B.x[b], B.y[b], grow, grow * 0.62, 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#d9c49a';
        ctx.beginPath();
        ctx.ellipse(B.x[b], B.y[b], 0.85, 0.5, 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(120,95,60,0.8)';
        ctx.lineWidth = 0.12;
        ctx.stroke();
      }
    }
  }

  // Ants are batched into one path per caste — thousands of tiny fills would
  // otherwise spend all the frame time on state changes.
  // One bucket per nest per caste: every colony has its own palette, so you can
  // tell at a glance whose ants are standing where.
  const buckets = [];

  function drawAnts(s) {
    const nests = AF.nests.list;
    while (buckets.length < nests.length) {
      buckets.push(Array.from({ length: AF.NCASTE }, () => []));
    }
    for (const nb of buckets) for (const b of nb) b.length = 0;

    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      const nb = buckets[A.nest[i]];
      if (nb) nb[A.caste[i]].push(i);
    }

    // Close enough that one art pixel covers at least a screen pixel.
    const detailed = s > 5;
    const CASTE_KEY = AF.CASTE_KEY;

    for (let n = 0; n < nests.length; n++) {
      const palette = nests[n].colors;
      for (let c = 0; c < AF.NCASTE; c++) {
        const bucket = buckets[n][c];
        if (!bucket.length) continue;
        ctx.fillStyle = palette[CASTE_KEY[c]];

        if (!detailed) {
          const sz = c === CASTE.QUEEN ? 1.5 : 0.85;
          ctx.beginPath();
          for (const i of bucket) ctx.rect(A.x[i] - sz / 2, A.y[i] - sz / 2, sz, sz);
          ctx.fill();
        } else {
          const kind = c === CASTE.QUEEN ? 'queen' : c === CASTE.SOLDIER ? 'soldier' : 'worker';
          const hex = palette[CASTE_KEY[c]];
          const colors = antColors(hex);
          for (const i of bucket) {
            blit(kind, hex, colors, A.x[i], A.y[i], A.hd[i], (A.x[i] + A.y[i]) * 2.5);
          }
        }
      }
    }

    // what everyone is carrying
    ctx.save();
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i] || A.carry[i] === CARRY.NONE) continue;
      const cy = A.carry[i];
      ctx.fillStyle = cy === CARRY.FOOD ? '#9ed14f'
        : cy === CARRY.WATER ? '#5aaee6'
        : cy === CARRY.EGG ? '#f0ead6' : '#8a6a48';
      // Held in the mandibles, on the same pixel grid as the ant.
      const q = SPRITES.worker.px;
      const hx = Math.round((A.x[i] + Math.cos(A.hd[i]) * 0.9) / q) * q;
      const hy = Math.round((A.y[i] + Math.sin(A.hd[i]) * 0.9) / q) * q;
      ctx.fillRect(hx - q, hy - q, q * 2, q * 2);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ pixel sprites
  //
  // Up close, ants and beetles are pixel art, to match the soil. Each sprite is
  // a little grid drawn facing right, baked into small canvases for 16 headings
  // by rotating pixel by pixel — so a turned ant is still made of square
  // pixels rather than a smoothed, rotated picture. Two frames alternate as it
  // walks, keyed to where it is, so legs move only when the ant does. Baked on
  // first use for each colour and cached.
  //
  // '#' body   '+' legs and antennae (a shade darker)
  // beetle: '*' sheen   '=' wing-case seam   'o' thorax and head   'm' mandibles
  const DIRS = 16;
  const SPRITES = {
    worker: { px: 0.2, frames: [
      ['..+..+.+.',
       '.##.++##+',
       '###.#####',
       '.##.++##+',
       '...+..+..'],
      ['...+..+..',
       '.##.++##+',
       '###.#####',
       '.##.++##+',
       '..+..+.+.'],
    ] },
    soldier: { px: 0.2, frames: [
      ['..+..+.+..',
       '.##.++###+',
       '###.######',
       '.##.++###+',
       '...+..+...'],
      ['...+..+...',
       '.##.++###+',
       '###.######',
       '.##.++###+',
       '..+..+.+..'],
    ] },
    queen: { px: 0.2, frames: [
      ['.....+..+.+..',
       '.###..+.+..+.',
       '#####.######.',
       '#####.#######',
       '#####.######.',
       '.###..+.+..+.',
       '....+..+..+..'],
      ['....+..+..+..',
       '.###..+.+..+.',
       '#####.######.',
       '#####.#######',
       '#####.######.',
       '.###..+.+..+.',
       '.....+..+.+..'],
    ] },
    beetle: { px: 0.25, frames: [
      ['...+....+.......',
       '....+...+...+...',
       '..#######..+...+',
       '.#**######oo..+.',
       '.#*#######oooom.',
       '.=========oooo..',
       '.#########oooom.',
       '.#########oo..+.',
       '..#######..+...+',
       '....+...+...+...',
       '...+....+.......'],
      ['....+...+.......',
       '....+...+...+...',
       '..#######..+...+',
       '.#**######oo..+.',
       '.#*#######oooom.',
       '.=========oooo..',
       '.#########oooom.',
       '.#########oo..+.',
       '..#######..+...+',
       '....+...+...+...',
       '..+.....+.......'],
    ] },
  };

  const BEETLE_COLORS = {
    '#': [43, 37, 49], '*': [112, 102, 140], '=': [20, 18, 23],
    // Legs well lighter than the shell: against a dark tunnel they are what
    // makes it read as an insect rather than a lump.
    'o': [35, 30, 40], '+': [122, 110, 136], 'm': [150, 116, 72],
  };

  const antPalettes = new Map();
  function antColors(hex) {
    let c = antPalettes.get(hex);
    if (!c) {
      const rgb = hexToRgb(hex);
      c = { '#': rgb, '+': rgb.map(v => Math.round(v * 0.62)) };
      antPalettes.set(hex, c);
    }
    return c;
  }

  function bakeSprite(frame, colors, dir) {
    const h = frame.length, w = frame[0].length;
    const n = Math.ceil(Math.hypot(w, h)) + 1;
    const cv = document.createElement('canvas');
    cv.width = n; cv.height = n;
    const g = cv.getContext('2d');
    const img = g.createImageData(n, n);
    const a = dir / DIRS * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let oy = 0; oy < n; oy++) {
      for (let ox = 0; ox < n; ox++) {
        // Where this output pixel came from, un-rotated.
        const px = ox + 0.5 - n / 2, py = oy + 0.5 - n / 2;
        const sx = Math.floor(px * ca + py * sa + w / 2);
        const sy = Math.floor(-px * sa + py * ca + h / 2);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const rgb = colors[frame[sy][sx]];
        if (!rgb) continue;
        const p = (oy * n + ox) * 4;
        img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  const spriteCache = new Map();
  function blit(kind, colorKey, colors, x, y, hd, stride) {
    const def = SPRITES[kind];
    const dir = ((Math.round(hd / (Math.PI * 2) * DIRS) % DIRS) + DIRS) % DIRS;
    const frame = Math.floor(stride) & 1;
    const key = kind + '|' + colorKey + '|' + frame + '|' + dir;
    let cv = spriteCache.get(key);
    if (!cv) {
      cv = bakeSprite(def.frames[frame], colors, dir);
      spriteCache.set(key, cv);
    }
    const size = cv.width * def.px;
    // On the art-pixel grid, so it doesn't shimmer as it moves.
    const sx = Math.round(x / def.px) * def.px, sy = Math.round(y / def.px) * def.px;
    ctx.drawImage(cv, sx - size / 2, sy - size / 2, size, size);
  }

  // A ground beetle, about four times an ant's length, as a pixel sprite facing
  // its heading like the ants. Legs step as it walks, not on a clock.
  function drawIntruders() {
    for (const t of col.intruders) {
      blit('beetle', 'beetle', BEETLE_COLORS, t.x, t.y, t.hd || 0,
        (Math.abs(t.x) + Math.abs(t.y)) * 1.6);

      // health, kept level above it whichever way it faces
      const f = t.hp / t.max;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(t.x - 1.7, t.y - 2.4, 3.4, 0.45);
      ctx.fillStyle = '#c7553f';
      ctx.fillRect(t.x - 1.7, t.y - 2.4, 3.4 * Math.max(0, f), 0.45);
    }
  }

  function drawSelection(s) {
    const i = R.selected;
    if (i < 0 || !A.alive[i]) return;
    const t = (performance.now() / 500) % (Math.PI * 2);
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = Math.max(0.1, 1.5 / s);
    ctx.beginPath();
    ctx.arc(A.x[i], A.y[i], 2.2 + Math.sin(t) * 0.25, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(A.x[i] - 4, A.y[i]); ctx.lineTo(A.x[i] - 2.8, A.y[i]);
    ctx.moveTo(A.x[i] + 2.8, A.y[i]); ctx.lineTo(A.x[i] + 4, A.y[i]);
    ctx.moveTo(A.x[i], A.y[i] - 4); ctx.lineTo(A.x[i], A.y[i] - 2.8);
    ctx.moveTo(A.x[i], A.y[i] + 2.8); ctx.lineTo(A.x[i], A.y[i] + 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ picking

  R.pickAnt = function (wx, wy) {
    let best = -1, bestD = 9;
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      const dx = A.x[i] - wx, dy = A.y[i] - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
})();
