// A coarse spatial index over living ants.
//
// Ants meeting other ants — avoiding a stranger, biting one, defending a
// larder — needs "who is near me", and asking that of three thousand ants
// pairwise every tick is not affordable. One pass to bucket them, then each
// lookup only walks a handful of cells.
(function () {
  const AF = window.AF, C = AF.CFG;
  const CELL = 4;                       // tiles per bucket

  let gw = 0, gh = 0;
  let head = null;                      // bucket -> first ant index
  let next = new Int32Array(C.MAX_ANTS); // ant -> next ant in the same bucket

  const grid = { CELL };
  AF.grid = grid;

  grid.rebuild = function () {
    const A = AF.colony.A;
    const nw = Math.ceil(C.W / CELL), nh = Math.ceil(C.H / CELL);
    if (nw !== gw || nh !== gh || !head) {
      gw = nw; gh = nh;
      head = new Int32Array(gw * gh);
    }
    head.fill(-1);
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      const cx = Math.min(gw - 1, Math.max(0, (A.x[i] / CELL) | 0));
      const cy = Math.min(gh - 1, Math.max(0, (A.y[i] / CELL) | 0));
      const c = cy * gw + cx;
      next[i] = head[c];
      head[c] = i;
    }
  };

  // Call fn(antIndex) for every living ant within `radius` tiles of (x, y).
  // Returns early if fn returns true.
  grid.near = function (x, y, radius, fn) {
    if (!head) return;
    const A = AF.colony.A;
    const r2 = radius * radius;
    const x0 = Math.max(0, ((x - radius) / CELL) | 0);
    const x1 = Math.min(gw - 1, ((x + radius) / CELL) | 0);
    const y0 = Math.max(0, ((y - radius) / CELL) | 0);
    const y1 = Math.min(gh - 1, ((y + radius) / CELL) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let i = head[cy * gw + cx]; i !== -1; i = next[i]) {
          if (!A.alive[i]) continue;
          const dx = A.x[i] - x, dy = A.y[i] - y;
          if (dx * dx + dy * dy > r2) continue;
          if (fn(i)) return;
        }
      }
    }
  };

  // Nearest ant belonging to a different nest, or -1.
  grid.nearestStranger = function (x, y, radius, myNest) {
    const A = AF.colony.A;
    let best = -1, bestD = radius * radius;
    grid.near(x, y, radius, i => {
      if (A.nest[i] === myNest) return false;
      const dx = A.x[i] - x, dy = A.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
      return false;
    });
    return best;
  };
})();
