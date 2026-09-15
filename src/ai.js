// Ant minds and the simulation tick.
//
// Every ant runs the same tiny loop: sense a couple of local things (its own
// nest's pheromone, a distance field, whatever is within a few tiles), pick a
// state, act. No ant knows the plan. The nest is what happens when a few
// hundred of these run at once — that's the whole point of the design.
//
// With more than one colony on the ground, the only thing that changes is that
// an ant can now smell a trail that is not its own. Everything that follows
// from that — avoidance, competition, raids — is built out of that one signal.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, col = AF.colony, NS = AF.nests;
  const T = AF.T, ST = AF.ST, CASTE = AF.CASTE, CARRY = AF.CARRY;
  const A = col.A, B = col.B;
  const TAU = Math.PI * 2;

  const sim = { paused: false, speed: 1 };

  // How far colony time moves per tick. Fixed: DAY_TICKS of colony time take
  // a real day of ticks at 1×. The speed slider doesn't touch this — it runs
  // more ticks a second, so everything (walking, digging, ageing) speeds up
  // together and a colony day at 24× really is a day's worth of everything.
  sim.lifeRate = function () {
    return C.DAY_TICKS / (86400 * C.BASE_HZ);
  };
  let LIFE = sim.lifeRate();      // refreshed every tick
  let lifeBefore = 0;

  // True on the tick the life clock passes a multiple of n, however slowly
  // it's moving. Life-paced schedules use this instead of `tick % n`.
  function lifeEvery(n) {
    return Math.floor(col.lifeTick / n) !== Math.floor(lifeBefore / n);
  }

  // How long one cut takes, in ticks. Slow and deliberate (see DIG_SLOW); the
  // speed slider speeds it up along with everything else.
  function digTicks() {
    return Math.round(C.DIG_TICKS * C.DIG_SLOW);
  }
  AF.sim = sim;

  const nestOf = i => NS.get(A.nest[i]);

  // ------------------------------------------------------------- math helpers

  // Constant time however large the angle. This used to step a full turn at a
  // time, and headings that were never wrapped grew into the millions over
  // days of running, so every steer spun that loop millions of times: it came
  // to most of a tick's cost on a long-lived farm.
  function wrapAngle(a) {
    if (a > Math.PI || a < -Math.PI) {
      a = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (!Number.isFinite(a)) a = 0;
    }
    return a;
  }
  function steer(i, desired, rate) {
    const d = wrapAngle(desired - A.hd[i]);
    A.hd[i] = wrapAngle(A.hd[i] + Math.max(-rate, Math.min(rate, d)));
  }
  function dist2(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  // --------------------------------------------------------------- movement
  // Two modes. Above ground an ant is glued to the terrain profile and walks
  // left/right. Underground it moves freely through open tiles, the way ants
  // do on the glass of a real farm.

  function aboveGround(i) {
    return A.y[i] < W.surfaceAt(A.x[i]) - 0.25;
  }

  function surfaceStep(i, dirWanted) {
    if (dirWanted) A.hd[i] = dirWanted > 0 ? 0 : Math.PI;
    else if (Math.random() < 0.012) A.hd[i] = Math.random() < 0.5 ? 0 : Math.PI;

    const dir = Math.cos(A.hd[i]) >= 0 ? 1 : -1;
    let nx = A.x[i] + dir * A.spd[i] * C.WALK_PACE;
    if (nx < 3) { nx = 3; A.hd[i] = 0; }
    if (nx > C.W - 3) { nx = C.W - 3; A.hd[i] = Math.PI; }
    A.sDist[i] += Math.abs(nx - A.x[i]);
    A.x[i] = nx;
    A.y[i] = W.surfaceAt(nx) - 0.5;
  }

  function tunnelStep(i) {
    const s = A.spd[i] * C.WALK_PACE;
    const nx = A.x[i] + Math.cos(A.hd[i]) * s;
    const ny = A.y[i] + Math.sin(A.hd[i]) * s;
    if (W.passableAt(nx, ny)) {
      A.sDist[i] += s;
      A.x[i] = nx; A.y[i] = ny;
      return true;
    }
    if (W.passableAt(nx, A.y[i])) {
      A.sDist[i] += Math.abs(nx - A.x[i]);
      A.x[i] = nx; A.hd[i] += (Math.random() - 0.5) * 0.8; return true;
    }
    if (W.passableAt(A.x[i], ny)) {
      A.sDist[i] += Math.abs(ny - A.y[i]);
      A.y[i] = ny; A.hd[i] += (Math.random() - 0.5) * 0.8; return true;
    }
    A.hd[i] += (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random());
    return false;
  }

  // An ant with nothing to do mostly stands still — real ants spend a great
  // deal of their time motionless, grooming — and now and then ambles a few
  // steps in one direction before stopping again. Nudging its heading at random
  // every tick instead made idle ants shiver on the spot, and in a tight corner
  // spin, since a blocked step swings the heading too. Stand-or-stroll comes
  // from the clock, so no extra state per ant is needed. With an anchor, an ant
  // that has drifted too far strolls back toward it.
  const lastLoiter = new Int32Array(C.MAX_ANTS).fill(-100);

  function loiter(i, anchorX, anchorY, radius) {
    lastLoiter[i] = col.tick;
    const period = 180 + (i % 7) * 30;
    const t = col.tick + i * 53;
    if (t % period < period * 0.65) return;                // standing, grooming

    const seg = Math.floor(t / period);
    const h = Math.sin(seg * 12.9898 + i * 78.233) * 43758.5453;
    let want = (h - Math.floor(h)) * TAU;
    if (anchorX !== undefined && dist2(A.x[i], A.y[i], anchorX, anchorY) > radius * radius) {
      want = Math.atan2(anchorY - A.y[i], anchorX - A.x[i]);
    }
    A.hd[i] += wrapAngle(want - A.hd[i]) * 0.08;

    // A slow amble. Blocked ahead? Then it simply stays put.
    const s = A.spd[i] * C.WALK_PACE * 0.4;
    const nx = A.x[i] + Math.cos(A.hd[i]) * s, ny = A.y[i] + Math.sin(A.hd[i]) * s;
    if (W.passableAt(nx, ny)) {
      A.x[i] = nx; A.y[i] = ny;
      A.sDist[i] += s;
    }
  }

  // A purposeless walk that doesn't twitch. Rather than stepping and letting a
  // blocked step fling the heading somewhere random (which, in a cramped
  // chamber, happened every other tick), it looks for the open way nearest to
  // where it is already facing — always checking the same side first, so it
  // turns steadily round an obstacle instead of flicking back and forth — and
  // swings toward it a little at a time. Nothing open at all: it waits.
  const STROLL_PROBES = [0, 0.5, -0.5, 1.1, -1.1, 1.8, -1.8, Math.PI];

  function stroll(i, speedScale) {
    let chosen = null;
    for (const off of STROLL_PROBES) {
      const a = A.hd[i] + off;
      if (W.passableAt(A.x[i] + Math.cos(a) * 1.2, A.y[i] + Math.sin(a) * 1.2)) { chosen = off; break; }
    }
    // Waiting for a way through is on purpose, not stuck: without this the
    // watchdog flagged it, and a long enough wait had the ant dig itself out.
    if (chosen === null) { lastLoiter[i] = col.tick; return; }
    A.hd[i] += chosen * 0.15 + (Math.random() - 0.5) * 0.04;
    const s = A.spd[i] * C.WALK_PACE * (speedScale || 0.7);
    const nx = A.x[i] + Math.cos(A.hd[i]) * s, ny = A.y[i] + Math.sin(A.hd[i]) * s;
    if (W.passableAt(nx, ny)) {
      A.x[i] = nx; A.y[i] = ny;
      A.sDist[i] += s;
    } else {
      lastLoiter[i] = col.tick;
    }
  }

  // Moving on the spot: a sway side to side and a turn of the head, with no
  // net travel — each tick applies only the change in a sine, so the ant
  // always swings back to where it started. What an ant busy at something
  // looks like, rather than a frozen one.
  function fidget(i, amp, rate) {
    lastLoiter[i] = col.tick;              // standing still here is on purpose
    const t = col.tick + i * 7;
    const d = Math.sin(t * rate) - Math.sin((t - 1) * rate);
    const nx = A.x[i] - Math.sin(A.hd[i]) * amp * d;
    const ny = A.y[i] + Math.cos(A.hd[i]) * amp * d;
    if (W.passableAt(nx, ny)) { A.x[i] = nx; A.y[i] = ny; }
    A.hd[i] += (Math.cos(t * rate * 1.7) - Math.cos((t - 1) * rate * 1.7)) * 0.35;
  }

  // A larder three times the size auto-tend aims for is plenty: foraging can
  // wait until it's eaten down.
  function storesFull(nest) {
    return nest.res.food > 3 * (70 + nest.count * 2.6) &&
           nest.res.water > 3 * (70 + nest.count * 2.2);
  }

  // Does the queen need food or water brought to her, with nobody already on
  // the way? One nurse at a time does the run.
  function queenWantsFeeding(nest) {
    const q = nest.queen;
    if (q < 0 || !A.alive[q]) return false;
    if (A.energy[q] > 65 && A.hydration[q] > 65) return false;
    const f = nest.queenFeeder;
    if (f >= 0 && A.alive[f] && A.nest[f] === nest.id &&
        (A.state[f] === ST.FETCH_ROYAL || A.state[f] === ST.TO_QUEEN || A.state[f] === ST.FEED_QUEEN)) {
      return false;
    }
    return true;
  }

  // A free place on the nursery floor for a piece of brood: the candidate
  // furthest from anything already lying there, settled onto the floor. Each
  // egg, larva and pupa gets its own spot instead of landing on the last one.
  function broodSpot(bc) {
    // Everything already taking up room: brood lying there, and the spots
    // other nurses are on their way to. Without the second, two nurses
    // carrying brood at once picked the same place.
    const taken = [];
    const r2 = (bc.r + 1) * (bc.r + 1);
    for (let b = 0; b < C.MAX_BROOD; b++) {
      if (B.alive[b] && B.held[b] < 0 && dist2(B.x[b], B.y[b], bc.x, bc.y) < r2) {
        taken.push(B.x[b], B.y[b]);
      }
    }
    for (let j = 0; j < C.MAX_ANTS; j++) {
      if (A.alive[j] && A.state[j] === ST.HAUL_EGG && A.carry[j] === CARRY.EGG &&
          A.memx[j] >= 0 && dist2(A.memx[j], A.memy[j], bc.x, bc.y) < r2) {
        taken.push(A.memx[j], A.memy[j]);
      }
    }
    const gapAt = (x, y) => {
      let g = 81;
      for (let k = 0; k < taken.length; k += 2) g = Math.min(g, dist2(x, y, taken[k], taken[k + 1]));
      return g;
    };

    let best = null, bestGap = -1;
    for (let k = 0; k < 28; k++) {
      const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * bc.r * 0.8;
      const x = bc.x + Math.cos(a) * r, y = bc.y + Math.sin(a) * r;
      if (!W.passableAt(x, y)) continue;
      // Prefer the floor of the chamber. A small chamber's floor fills up
      // fast, though, so if the floor there is crowded the brood goes on the
      // pile instead — the way real brood heaps up — rather than on top of
      // another piece.
      let fy = Math.floor(y);
      while (fy + 1 < bc.y + bc.r && W.passable(Math.floor(x), fy + 1)) fy++;
      const floorY = fy + 0.6;
      const onFloor = gapAt(x, floorY);
      const spot = onFloor >= 0.8 ? { x, y: floorY, g: onFloor } : { x, y, g: gapAt(x, y) };
      if (spot.g > bestGap) { bestGap = spot.g; best = { x: spot.x, y: spot.y }; }
      if (bestGap >= 1.3) break;
    }
    return best;
  }

  // A nurse with nothing urgent does rounds of the nursery: walks to a brood
  // item, stops to fuss over it for a little while, then on to the next. Real
  // nurses keep circulating among the brood rather than standing about.
  function tendRound(i, nest, bc) {
    if (A.timer[i] > 0) { A.timer[i]--; fidget(i, 0.12, 0.18); return; }

    const gx = A.memx[i], gy = A.memy[i];
    const arrived = gx >= 0 && dist2(A.x[i], A.y[i], gx, gy) < 0.8;
    const stale = gx < 0 || dist2(gx, gy, bc.x, bc.y) > bc.r * bc.r * 1.5;
    if (arrived || stale) {
      if (arrived) A.timer[i] = 40 + ((Math.random() * 110) | 0);

      // Next stop: one of our brood in the chamber, or else a spot on its floor.
      const here = [];
      for (let b = 0; b < C.MAX_BROOD; b++) {
        if (B.alive[b] && B.nest[b] === nest.id && B.held[b] < 0 &&
            dist2(B.x[b], B.y[b], bc.x, bc.y) < (bc.r + 1) * (bc.r + 1)) here.push(b);
      }
      let px = -1, py = -1;
      if (here.length) {
        const b = here[(Math.random() * here.length) | 0];
        px = B.x[b] + (Math.random() - 0.5) * 1.2;
        py = B.y[b] + (Math.random() - 0.5) * 1.2;
      }
      if (px < 0 || !W.passableAt(px, py)) {
        for (let k = 0; k < 10; k++) {
          const a = Math.random() * TAU, r = Math.random() * bc.r * 0.8;
          const tx = bc.x + Math.cos(a) * r, ty = bc.y + Math.sin(a) * r;
          if (W.passableAt(tx, ty)) { px = tx; py = ty; break; }
        }
      }
      A.memx[i] = px;
      A.memy[i] = px < 0 ? -1 : py;
      if (px < 0) fidget(i, 0.12, 0.18);
      return;
    }

    // Unhurried walk to the next stop. Blocked: pick another.
    steer(i, Math.atan2(gy - A.y[i], gx - A.x[i]), 0.25);
    const s = A.spd[i] * C.WALK_PACE * 0.6;
    const nx = A.x[i] + Math.cos(A.hd[i]) * s, ny = A.y[i] + Math.sin(A.hd[i]) * s;
    if (W.passableAt(nx, ny)) {
      A.x[i] = nx; A.y[i] = ny;
      A.sDist[i] += s;
    } else {
      A.memx[i] = -1;
    }
  }

  // If a dumped mound buries an ant, shove it to the nearest open tile.
  function unstick(i) {
    if (W.passableAt(A.x[i], A.y[i]) || aboveGround(i)) return;
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.floor(A.x[i]) + dx, ny = Math.floor(A.y[i]) + dy;
          if (W.passable(nx, ny)) { A.x[i] = nx + 0.5; A.y[i] = ny + 0.5; return; }
        }
      }
    }
  }

  // Walk downhill on a distance field. Falls back to steering straight at the
  // target when the ant has no field reading (chamber not dug through yet).
  function navDown(i, field, tx, ty) {
    const ang = W.downhill(field, A.x[i], A.y[i]);
    if (isNaN(ang)) steer(i, Math.atan2(ty - A.y[i], tx - A.x[i]), 0.28);
    else steer(i, ang, 0.35);
    A.hd[i] += (Math.random() - 0.5) * 0.12;
    tunnelStep(i);
  }

  function atField(i, field, thresh) {
    const v = W.fieldAt(field, A.x[i], A.y[i]);
    return v >= 0 && v <= thresh;
  }

  // Underground ant heading for an exit, then popping out onto the surface.
  // The home field is seeded from every entrance the nest has, so walking
  // downhill on it already leads to the nearest one — the ant surfaces at
  // whichever it actually reached.
  function headOutside(i, nest, field) {
    if (aboveGround(i)) return true;
    const ent = NS.nearestEntrance(nest, A.x[i], A.y[i]);
    navDown(i, field, ent.x, ent.y);
    if (atField(i, field, 2)) {
      const here = NS.nearestEntrance(nest, A.x[i], A.y[i]);
      A.x[i] = here.x + (Math.random() - 0.5);
      A.y[i] = W.surfaceAt(A.x[i]) - 0.5;
      A.hd[i] = Math.random() < 0.5 ? 0 : Math.PI;
      return true;
    }
    for (const e of nest.entrances) {
      if (dist2(A.x[i], A.y[i], e.x, e.y) < 4) {
        A.x[i] = e.x + (Math.random() - 0.5);
        A.y[i] = W.surfaceAt(A.x[i]) - 0.5;
        A.hd[i] = Math.random() < 0.5 ? 0 : Math.PI;
        return true;
      }
    }
    return false;
  }

  // Surface ant walking to a hole and dropping in — the closest one it has.
  function headInside(i, nestOrEntrance) {
    if (!aboveGround(i)) return true;
    const ent = nestOrEntrance.entrances
      ? NS.nearestEntrance(nestOrEntrance, A.x[i], A.y[i])
      : nestOrEntrance;
    const dx = ent.x - A.x[i];
    surfaceStep(i, dx > 0 ? 1 : -1);
    if (Math.abs(dx) < 1.1) {
      A.x[i] = ent.x;
      A.y[i] = ent.y + 0.5;
      A.hd[i] = Math.PI / 2;
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- sensing

  function nearestPile(i, list, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      if (p.amount <= 0) continue;
      const d = dist2(A.x[i], A.y[i], p.x, p.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // Follow our own trail along the surface: sniff left, sniff right, go toward
  // the stronger side. Two samples is all a real ant gets — two antennae.
  function followTrailSurface(i, nest) {
    const yL = W.surfaceAt(A.x[i] - 4) - 0.5, yR = W.surfaceAt(A.x[i] + 4) - 0.5;
    const l = NS.sampleTrail(nest, A.x[i] - 4, yL) + NS.sampleTrail(nest, A.x[i] - 8, yL);
    const r = NS.sampleTrail(nest, A.x[i] + 4, yR) + NS.sampleTrail(nest, A.x[i] + 8, yR);
    if (l + r < C.TRAIL_SENSE) return false;
    if (Math.abs(r - l) < 0.06) {
      surfaceStep(i, Math.cos(A.hd[i]) >= 0 ? 1 : -1);
      return true;
    }
    surfaceStep(i, r > l ? 1 : -1);
    return true;
  }

  // How far this colony searches. A big nest strips the ground near home and
  // has to push further out — real colonies work larger territories for exactly
  // that reason.
  function forageRange(nest) {
    return Math.min(C.FORAGE_RANGE_MAX,
      C.FORAGE_RANGE + Math.sqrt(nest.count) * C.FORAGE_PER_ANT);
  }
  AF.forageRange = forageRange;

  // Can this ant still get home on the water it has? Widening the search range
  // without asking that question just means dying further from the nest.
  function canGetHome(i, nest) {
    const away = Math.abs(A.x[i] - nest.entrance.x);
    const ticksHome = away / Math.max(0.01, A.spd[i] * C.WALK_PACE);
    const needed = ticksHome * C.THIRST_DRAIN * LIFE * C.RETURN_MARGIN + C.RETURN_RESERVE;
    return A.hydration[i] > needed;
  }

  // Sweep, don't mill. Left to drift, an ant reverses every ten tiles or so and
  // never gets clear of its own doorstep — food a hundred tiles out simply
  // never gets found. A searching ant commits to a direction and holds it until
  // it reaches the edge of the colony's range.
  function wanderSurface(i, nest) {
    const dx = A.x[i] - nest.entrance.x;
    if (Math.abs(dx) > forageRange(nest)) surfaceStep(i, dx > 0 ? -1 : 1);
    else surfaceStep(i, Math.cos(A.hd[i]) >= 0 ? 1 : -1);
  }

  // ------------------------------------------------------- meeting strangers
  //
  // The default response to another colony's scent is to go the other way.
  // Avoidance is cheap; a brawl costs workers that nobody can spare. Only a
  // nest under real pressure — an empty larder, or nowhere left to dig —
  // treats a stranger as something to attack.

  function hostile(nest) {
    if (nest.policy.mode === 'raid') return true;
    if (nest.res.food < C.HOSTILE_FOOD || nest.res.water < C.HOSTILE_FOOD) return true;
    return false;
  }

  // Whose ground is this? Every nest's distance field covers the whole farm —
  // the tunnels all open onto the same sky, so the floods join up there. What
  // still means something is which entrance is *nearer* through the tunnels,
  // and that is a perfectly local thing for an ant to know.
  function onHomeGround(i, nest) {
    if (aboveGround(i)) return false;
    const mine = W.fieldAt(nest.fHome, A.x[i], A.y[i]);
    if (mine < 0) return false;
    for (const other of NS.list) {
      if (other === nest || !other.alive) continue;
      const d = W.fieldAt(other.fHome, A.x[i], A.y[i]);
      if (d >= 0 && d < mine) return false;
    }
    return true;
  }

  // Register that we have smelled someone else. This is the only way a queen
  // ever learns she has neighbours.
  function noteForeign(nest, strength) {
    nest.policy.threat = Math.min(12, nest.policy.threat + C.THREAT_PER_SIGHTING * strength);
  }

  // Returns true if the ant reacted to a stranger and should not do anything
  // else this tick.
  function handleStrangers(i, nest) {
    if (NS.count() < 2) return false;

    // A raider with its arms full runs for home and takes the hits. Stopping to
    // brawl every few tiles is why the loot never used to arrive.
    const st = A.state[i];
    const raiding = st === ST.RAID_OUT || st === ST.RAID_TAKE || st === ST.RAID_HOME;
    if (raiding && A.carry[i] !== CARRY.NONE) return false;

    if ((col.tick + i) % 4 !== 0) return false;

    const foreignScent = NS.sampleForeign(nest, A.x[i], A.y[i]);
    if (foreignScent > C.FOREIGN_SENSE) noteForeign(nest, 0.05);

    const other = AF.grid.nearestStranger(A.x[i], A.y[i], 3.2, nest.id);
    if (other < 0) {
      // No one in sight, but the ground smells of them: edge away from it.
      if (foreignScent > C.FOREIGN_SENSE * 3 && !hostile(nest)) {
        const owner = NS.foreignOwner(nest, A.x[i], A.y[i]);
        if (owner) {
          const away = Math.atan2(A.y[i] - owner.entrance.y, A.x[i] - owner.entrance.x);
          steer(i, away, C.AVOID_TURN * 0.4);
        }
      }
      return false;
    }

    noteForeign(nest, 0.5);

    const mine = A.caste[i], theirs = A.caste[other];
    const willing = hostile(nest) || onHomeGround(i, nest) || raiding;
    const iFight = willing &&
      (mine === CASTE.SOLDIER || raiding || theirs === CASTE.QUEEN);

    if (!iFight) {
      // Back off. Carrying ants especially: the load is worth more than the
      // argument.
      const away = Math.atan2(A.y[i] - A.y[other], A.x[i] - A.x[other]);
      if (aboveGround(i)) surfaceStep(i, Math.cos(away) >= 0 ? 1 : -1);
      else { steer(i, away, C.AVOID_TURN); tunnelStep(i); }
      return true;
    }

    // Fighting. Both sides get hurt; soldiers are simply better at it.
    const d = Math.hypot(A.x[other] - A.x[i], A.y[other] - A.y[i]);
    W.depositAlarm(A.x[i], A.y[i], C.ALARM_DROP);
    if (d < 1.3) {
      const power = mine === CASTE.SOLDIER ? C.FIGHT_DAMAGE : C.FIGHT_DAMAGE * 0.45;
      A.health[other] -= power;
      A.sHits[i]++;
      if (col.tick % 40 === 0) { col.log(i, 8); col.log(other, 9); }
      if (A.health[other] <= 0) {
        nest.stats.kills++;          // their loss is on our ledger
        col.killAnt(other, 'killed');
      }
    } else {
      steer(i, Math.atan2(A.y[other] - A.y[i], A.x[other] - A.x[i]), 0.45);
      if (aboveGround(i)) surfaceStep(i, A.x[other] > A.x[i] ? 1 : -1);
      else tunnelStep(i);
    }
    return true;
  }

  // ------------------------------------------------------------ needs & death

  function metabolism(i) {
    const caste = A.caste[i];
    // All on the life clock: an ant walks at the same pace at any speed, but
    // ages, tires and thirsts by colony time.
    const rate = (caste === CASTE.QUEEN ? 0.55 : 1) * LIFE;
    A.age[i] += LIFE;
    A.energy[i] -= C.ENERGY_DRAIN * rate;
    A.hydration[i] -= C.THIRST_DRAIN * rate;

    if (A.energy[i] <= 0) {
      A.energy[i] = 0;
      A.health[i] -= 0.085 * LIFE;
      if (col.tick % 240 === 0) col.log(i, 14);
    }
    if (A.hydration[i] <= 0) {
      A.hydration[i] = 0;
      A.health[i] -= C.DEHYDRATION_DAMAGE * LIFE;
      if (col.tick % 240 === 0) col.log(i, 18);
    }
    if (A.energy[i] > 60 && A.hydration[i] > 60 && A.health[i] < 100) A.health[i] += 0.02 * LIFE;

    if (A.health[i] <= 0) {
      col.killAnt(i, A.hydration[i] <= 0 ? 'thirst' : A.energy[i] <= 0 ? 'starve' : 'killed');
      return false;
    }
    if (A.age[i] > A.life[i]) { col.killAnt(i, 'age'); return false; }
    return true;
  }

  // Hunger and thirst interrupt whatever the ant was doing — but not while it
  // is already carrying something home, so cargo doesn't get abandoned.
  function needsInterrupt(i, nest) {
    const st = A.state[i];
    if (st === ST.EATING || st === ST.DRINKING || st === ST.GO_EAT || st === ST.GO_DRINK) return false;
    if (A.caste[i] === CASTE.QUEEN) return false;
    const carrying = A.carry[i] !== CARRY.NONE;

    if (A.hydration[i] < C.THIRSTY_AT && nest.res.water > C.SIP_COST && (!carrying || A.hydration[i] < 18)) {
      setState(i, ST.GO_DRINK); return true;
    }
    if (A.energy[i] < C.HUNGRY_AT && nest.res.food > C.MEAL_COST && (!carrying || A.energy[i] < 15)) {
      setState(i, ST.GO_EAT); return true;
    }
    return false;
  }

  function setState(i, s) { A.state[i] = s; A.timer[i] = 0; }

  // --------------------------------------------------------------- the castes

  function stepForager(i, nest) {
    // Out too far to make it back on the water it is carrying? Turn for home
    // now, whatever it was doing. An empty-handed ant that survives is worth
    // more than a load nobody ever delivers.
    const st0 = A.state[i];
    const searching = st0 === ST.SEEK_FOOD || st0 === ST.SEEK_WATER ||
                      st0 === ST.TO_FOOD || st0 === ST.TO_WATER;
    if (searching && aboveGround(i) && !canGetHome(i, nest)) {
      if (headInside(i, nest)) setState(i, ST.GO_DRINK);
      else col.log(i, 25);
      return;
    }
    // The larder is full: stop searching and come home.
    if (searching && (col.tick + i) % 30 === 0 && storesFull(nest)) { setState(i, ST.IDLE); return; }

    switch (A.state[i]) {
      case ST.IDLE:
      case ST.LEAVE_NEST: {
        // A colony with a full larder doesn't keep foraging: its foragers stay
        // in and loaf near the stores, and food left out on the surface stays
        // where it is until it's wanted.
        if (storesFull(nest)) {
          if (aboveGround(i)) { headInside(i, nest); break; }
          const s = NS.store(nest);
          if (dist2(A.x[i], A.y[i], s.x, s.y) > 20 * 20) navDown(i, nest.fStore, s.x, s.y);
          else if ((col.tick + i * 13) % 360 < 120) fidget(i, 0.12, 0.15);
          else stroll(i, 0.5);
          break;
        }
        if (headOutside(i, nest, nest.fHome)) {
          const wantWater = nest.res.water < nest.res.food * 0.85 && col.puddles.length > 0;
          setState(i, wantWater ? ST.SEEK_WATER : ST.SEEK_FOOD);
        }
        break;
      }

      case ST.SEEK_FOOD: {
        if ((col.tick + i) % 5 === 0) {
          const p = nearestPile(i, col.piles, C.PILE_SENSE);
          if (p) { A.tx[i] = p.x; A.ty[i] = p.y; setState(i, ST.TO_FOOD); break; }
        }
        if (A.memx[i] >= 0) {
          surfaceStep(i, A.memx[i] > A.x[i] ? 1 : -1);
          if (Math.abs(A.memx[i] - A.x[i]) < 1.5) { A.memx[i] = -1; col.log(i, 11); }
        } else if (!followTrailSurface(i, nest)) {
          wanderSurface(i, nest);
        }
        if (col.puddles.length > 0 && (col.piles.length === 0 ||
            nest.res.water < nest.res.food * 0.6)) setState(i, ST.SEEK_WATER);
        break;
      }

      case ST.TO_FOOD: {
        const p = nearestPile(i, col.piles, 40);
        if (!p) { col.log(i, 11); setState(i, ST.SEEK_FOOD); break; }
        surfaceStep(i, p.x > A.x[i] ? 1 : -1);
        if (Math.abs(p.x - A.x[i]) < 1.0) {
          const take = Math.min(C.FOOD_PER_TRIP, p.amount);
          p.amount -= take;
          A.carry[i] = CARRY.FOOD; A.carryAmt[i] = take;
          A.memx[i] = p.x; A.memy[i] = p.y;
          col.log(i, 1);
          setState(i, ST.HAUL_FOOD);
        }
        break;
      }

      case ST.SEEK_WATER: {
        if ((col.tick + i) % 5 === 0) {
          const p = nearestPile(i, col.puddles, C.PILE_SENSE);
          if (p) { A.tx[i] = p.x; A.ty[i] = p.y; setState(i, ST.TO_WATER); break; }
        }
        if (!followTrailSurface(i, nest)) wanderSurface(i, nest);
        if (col.piles.length > 0 && (col.puddles.length === 0 ||
            nest.res.food < nest.res.water * 0.6)) setState(i, ST.SEEK_FOOD);
        break;
      }

      case ST.TO_WATER: {
        const p = nearestPile(i, col.puddles, 48);
        if (!p) { col.log(i, 11); setState(i, ST.SEEK_WATER); break; }
        surfaceStep(i, p.x > A.x[i] ? 1 : -1);
        if (Math.abs(p.x - A.x[i]) < 1.0) {
          const take = Math.min(C.WATER_PER_TRIP, p.amount);
          p.amount -= take;
          A.carry[i] = CARRY.WATER; A.carryAmt[i] = take;
          col.log(i, 15);
          setState(i, ST.HAUL_FOOD);
        }
        break;
      }

      case ST.HAUL_FOOD: {
        // Laying trail is the whole trick: a loaded ant marks the way back, and
        // other foragers amplify whichever path keeps paying off.
        NS.depositTrail(nest, A.x[i], A.y[i], C.TRAIL_DROP);
        if (headInside(i, nest)) {
          const s = NS.store(nest);
          navDown(i, nest.fStore, s.x, s.y);
          if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r)
            setState(i, ST.STORE_FOOD);
        }
        break;
      }

      case ST.STORE_FOOD: {
        if (A.carry[i] === CARRY.WATER) {
          nest.res.water += A.carryAmt[i];
          nest.stats.waterGathered += A.carryAmt[i];
          A.sFood[i]++;
          col.log(i, 16);
        } else {
          nest.res.food += A.carryAmt[i];
          nest.stats.foodGathered += A.carryAmt[i];
          A.sFood[i]++;
          col.log(i, 2);
        }
        A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0;
        A.stuck[i] = 0;
        setState(i, ST.LEAVE_NEST);
        break;
      }

      default: setState(i, ST.LEAVE_NEST);
    }
  }

  // ------------------------------------------------------------------ digging

  function pickDigNode(i, nest) {
    let best = null, bestScore = Infinity, full = null, fullScore = Infinity;
    for (let k = 0; k < nest.plan.length; k++) {
      const n = nest.plan[k];
      if (n.built >= 1) continue;
      const d = Math.hypot(n.x - A.x[i], n.y - A.y[i]);
      const score = d * 0.5 + n.claims * 6 + n.y * 0.35 + n.fails * 14;
      // A site with a full crew is only an option when every site is full.
      // Without this, diggers sent away from a crowded room walked straight
      // back to it — nearness outweighed the crowding penalty.
      if (n.claims >= MAX_CREW) {
        if (score < fullScore) { fullScore = score; full = n; }
        continue;
      }
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (!best) best = full;
    if (!best) return -1;
    best.claims++;
    return nest.plan.indexOf(best);
  }

  function releaseNode(i, nest) {
    if (A.node[i] >= 0 && nest.plan[A.node[i]]) nest.plan[A.node[i]].claims--;
    A.node[i] = -1;
  }

  // Soil touching the tile the ant stands in, preferring the chamber centre.
  function adjacentDiggable(i, n) {
    const ax = Math.floor(A.x[i]), ay = Math.floor(A.y[i]);
    let best = -1, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const tx = ax + dx, ty = ay + dy;
        if (Math.hypot(tx + 0.5 - n.x, ty + 0.5 - n.y) > n.r) continue;
        const t = W.tileAt(tx, ty);
        if (!W.isDiggable(t)) continue;
        const d = Math.hypot(tx - n.x, ty - n.y);
        if (d < bestD) { bestD = d; best = ty * C.W + tx; }
      }
    }
    return best;
  }

  // Tip one load where the ant stands and let it avalanche into shape.
  function dumpOne(i) {
    return W.placeSpoil(Math.floor(A.x[i]));
  }

  // A new way in. Opened at the turf, then bored straight down to the room the
  // shaft was sited against. Approached from below, diggers wandered whatever
  // air pocket sat under the cap and never cut it; cut from above with nothing
  // linking it down, it was a dimple in the ground that never reached the nest.
  // A straight bore — dig the next tile on the line, or step if it's open — is
  // what makes it reliable.
  const BORE = [0, 0.6, -0.6, 1.2, -1.2];

  function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }

  function startBore(i, tile, n) {
    n.bored = (n.bored || 0) + 1;
    A.digTile[i] = tile;
    setState(i, ST.DIGGING);
    A.timer[i] = digTicks();
    col.log(i, 3);
  }

  function digShaft(i, nest, n) {
    const x = Math.floor(n.x);
    const top = W.surfaceAt(x);

    // Shafts queued before they remembered their room: pick the nearest one.
    if (n.lx === undefined) {
      let bd = Infinity;
      for (const r of nest.plan) {
        if (r.built < 1 || r.abandoned || r.type === 'entrance' || r.type === 'breach') continue;
        const d = Math.hypot(r.x - n.x, r.y - top);
        if (d < bd) { bd = d; n.lx = r.x; n.ly = r.y; }
      }
      if (n.lx === undefined) { n.built = 1; n.abandoned = true; releaseNode(i, nest); return; }
    }

    const above = aboveGround(i);
    // In the gallery, but not already in the room it leads to: from there,
    // "bore toward the room" means jitter on the spot forever. Those go out
    // and start from the top like everyone else.
    const inBore = !above &&
      Math.hypot(A.x[i] - n.lx, A.y[i] - n.ly) > 4.5 &&
      distToSegment(A.x[i], A.y[i], x + 0.5, top + 0.5, n.lx, n.ly) < 3.5;

    // Out through a door we already have, then along the surface to the spot.
    if (!above && !inBore) { headOutside(i, nest, nest.fHome); return; }
    if (above) {
      const dx = x + 0.5 - A.x[i];
      if (Math.abs(dx) > 0.6) { surfaceStep(i, dx > 0 ? 1 : -1); return; }
      if (!W.passable(x, top)) {
        if (!W.isDiggable(W.tileAt(x, top))) {   // stone at the turf
          n.built = 1; n.abandoned = true; releaseNode(i, nest); return;
        }
        startBore(i, top * C.W + x, n);
        return;
      }
    }

    // Broken through into the nest? Checked every so often — it's a search.
    if (col.tick - (n.connAt === undefined ? -1e9 : n.connAt) >= 20) {
      n.connAt = col.tick;
      n.conn = NS.shaftConnected(nest, x);
    }
    if (n.conn) { n.built = 1; col.log(i, 13); releaseNode(i, nest); return; }

    boreStep(i, n, n.lx, n.ly);
  }

  // One step of a straight gallery: cut the next tile on the line, or walk on
  // if it's already open, edging round stone.
  function boreStep(i, n, tx, ty) {
    const want = Math.atan2(ty - A.y[i], tx - A.x[i]);
    for (const off of BORE) {
      const a = want + off;
      const fx = Math.floor(A.x[i] + Math.cos(a)), fy = Math.floor(A.y[i] + Math.sin(a));
      if (fy < W.surfaceAt(fx)) continue;          // never back out into the sky
      const t = W.tileAt(fx, fy);
      if (W.isDiggable(t)) { startBore(i, fy * C.W + fx, n); return; }
      if (W.passable(fx, fy)) { A.hd[i] = a; tunnelStep(i); return; }
    }
    // Stone all round the face.
    n.fails = (n.fails || 0) + 1;
    A.hd[i] += Math.PI;
    tunnelStep(i);
  }

  // A gallery into a neighbour, bored the same way: from our own room, in a
  // straight line at the rim of theirs. Left to the general digger — which
  // walks through any open air before it will cut — a breach sixty tiles
  // through solid ground sat at a third dug until it timed out.
  function digBreach(i, nest, n) {
    if (aboveGround(i)) { headInside(i, nest); return; }
    if (Math.hypot(A.x[i] - n.x, A.y[i] - n.y) < n.r) {
      n.built = 1;                                  // through: their rim is open air
      col.log(i, 13);
      releaseNode(i, nest);
      return;
    }
    if (distToSegment(A.x[i], A.y[i], n.mx, n.my, n.x, n.y) >= 3.5) {
      digToward(i, n.mx, n.my);                     // get to our end of it first
      return;
    }
    boreStep(i, n, n.x, n.y);
  }

  function stepDigger(i, nest) {
    switch (A.state[i]) {
      case ST.IDLE:
      case ST.TO_DIG: {
        if (A.node[i] < 0 || !nest.plan[A.node[i]] || nest.plan[A.node[i]].built >= 1) {
          releaseNode(i, nest);
          A.node[i] = pickDigNode(i, nest);
          if (A.node[i] < 0) { setState(i, ST.REST); break; }
        }
        A.state[i] = ST.TO_DIG;
        const n = nest.plan[A.node[i]];
        if (n.type === 'entrance') { digShaft(i, nest, n); break; }
        if (n.type === 'breach' && n.mx !== undefined) { digBreach(i, nest, n); break; }
        if (aboveGround(i)) { headInside(i, nest); break; }

        const d = Math.hypot(n.x - A.x[i], n.y - A.y[i]);
        if (d < n.r) {
          // Cut whatever is within reach first. Walking across a chamber to a
          // "better" tile makes a digger oscillate and never touch soil.
          let tile = adjacentDiggable(i, n);
          if (tile < 0) {
            const far = W.diggableInNode(n, A.x[i], A.y[i]);
            if (far < 0) {
              n.built = 1;
              col.log(i, 13);
              releaseNode(i, nest);
              break;
            }
            digToward(i, (far % C.W) + 0.5, ((far / C.W) | 0) + 0.5);
            break;
          }
          A.digTile[i] = tile;
          setState(i, ST.DIGGING);
          A.timer[i] = digTicks();
          col.log(i, 3);
        } else {
          digToward(i, n.x, n.y);
        }
        break;
      }

      case ST.DIGGING: {
        // Working the face. A cut takes a while, so rather than stand frozen
        // the ant faces the soil, rocks side to side and nods into it. It
        // always swings back to where it started (only the change in a sine
        // is applied), so it never drifts off the tile it's cutting.
        if (A.digTile[i] >= 0) {
          const tile = A.digTile[i];
          const face = Math.atan2(((tile / C.W) | 0) + 0.5 - A.y[i], (tile % C.W) + 0.5 - A.x[i]);
          const t = col.tick + i * 7, rate = 0.2;
          const d = Math.sin(t * rate) - Math.sin((t - 1) * rate);
          const nx = A.x[i] - Math.sin(face) * 0.25 * d;
          const ny = A.y[i] + Math.cos(face) * 0.25 * d;
          if (W.passableAt(nx, ny)) { A.x[i] = nx; A.y[i] = ny; }
          A.hd[i] = face + Math.sin(t * rate * 1.6) * 0.35;
        }
        A.timer[i]--;
        if (A.timer[i] <= 0) {
          const tile = A.digTile[i];
          if (tile >= 0) {
            const tx = tile % C.W, ty = (tile / C.W) | 0;
            const t = W.tileAt(tx, ty);
            if (W.isDiggable(t)) {
              const struckFood = t === T.CACHE;
              W.setTile(tx, ty, T.AIR);
              W.refreshColumn(tx);
              nest.stats.tilesDug++;
              A.stuck[i] = 0;
              // Every cut counts as work on the room this digger is headed for,
              // including the tunnel it cuts to reach it. Only tiles inside a
              // room used to count, so with slow cuts a room timed out while
              // its digger was still tunnelling toward it: 9 of 11 rooms were
              // written off, most with nothing dug, and the larder never moved.
              const site = A.node[i] >= 0 ? nest.plan[A.node[i]] : null;
              if (site) site.bored = (site.bored || 0) + 1;

              if (struckFood) {
                // Broke into something worth eating. Spoil can wait — this
                // goes home first.
                const yield_ = W.mineCache(tx + 0.5, ty + 0.5);
                nest.stats.cacheFound += yield_;
                A.carry[i] = CARRY.FOOD;
                A.carryAmt[i] = yield_;
                col.log(i, 24);
                setState(i, ST.HAUL_FOOD);
              } else {
                A.carry[i] = CARRY.DIRT;
                A.carryAmt[i] += 1;
                setState(i, A.carryAmt[i] >= C.DIG_LOAD ? ST.HAUL_DIRT : ST.TO_DIG);
              }
            } else {
              setState(i, ST.TO_DIG);
            }
          } else setState(i, ST.TO_DIG);
          A.digTile[i] = -1;
        }
        break;
      }

      case ST.HAUL_DIRT: {
        if (headOutside(i, nest, nest.fHome)) {
          A.timer[i]++;
          surfaceStep(i, A.x[i] < nest.entrance.x ? -1 : 1);
          const clear = W.spoilDepth(A.x[i]) <= C.SPOIL_EDGE;
          const far = A.timer[i] > 25 + (i % 25);
          if ((far && clear) || A.timer[i] > C.SPOIL_WALK_MAX) setState(i, ST.DUMP_DIRT);
        }
        break;
      }

      case ST.DUMP_DIRT: {
        let placed = 0;
        while (A.carryAmt[i] > 0 && dumpOne(i)) { A.carryAmt[i]--; placed++; }
        let extra = 0;
        while (nest.pendingSpoil > 0 && extra < 2 && dumpOne(i)) {
          nest.pendingSpoil--; placed++; extra++;
        }
        if (placed) {
          A.sDirt[i] += placed;
          nest.stats.dirtMoved += placed;
          nest.stats.spoilDumped += placed;
          A.stuck[i] = 0;
          A.y[i] = W.surfaceAt(A.x[i]) - 0.5;
        }
        if (A.carryAmt[i] > 0) {
          surfaceStep(i, A.x[i] < nest.entrance.x ? -1 : 1);
          break;
        }
        A.carry[i] = CARRY.NONE;
        col.log(i, 4);
        setState(i, ST.TO_DIG);
        break;
      }

      // A digger that struck buried food carries it home itself rather than
      // handing it off — same route a forager takes, different origin.
      case ST.HAUL_FOOD: {
        if (headInside(i, nest)) {
          const s = NS.store(nest);
          navDown(i, nest.fStore, s.x, s.y);
          if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r) {
            nest.res.food += A.carryAmt[i];
            nest.stats.foodGathered += A.carryAmt[i];
            A.sFood[i]++;
            A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0;
            A.stuck[i] = 0;
            col.log(i, 2);
            setState(i, ST.TO_DIG);
          }
        }
        break;
      }

      case ST.REST: {
        if (Math.random() < 0.004) setState(i, ST.TO_DIG);
        if (!aboveGround(i)) loiter(i);
        break;
      }

      default: setState(i, ST.TO_DIG);
    }
  }

  // Prefer walking through existing tunnels; only cut new soil when the way
  // toward the goal is genuinely blocked.
  const PROBES = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05];
  const SKIRT = [1.4, -1.4, 1.75, -1.75, 2.1, -2.1, 2.6, -2.6];
  // How close each digger has got to where it is headed. The probes walk any
  // open way pointing roughly at the goal, and along a chamber wall there
  // nearly always is one: five diggers slid up and down the same wall for
  // hours and never cut a tile toward a room buried 13 tiles away. Once the
  // goal stops getting closer, the digger cuts straight at it instead.
  const DIG_STALL = 120;
  const digBest = new Float32Array(C.MAX_ANTS);
  const digGoal = new Float32Array(C.MAX_ANTS * 2).fill(-1);
  const digStall = new Int32Array(C.MAX_ANTS);
  function digToward(i, gx, gy) {
    const nest = nestOf(i);
    let want = Math.atan2(gy - A.y[i], gx - A.x[i]);

    const dGoal = Math.hypot(gx - A.x[i], gy - A.y[i]);
    if (Math.abs(digGoal[i * 2] - gx) + Math.abs(digGoal[i * 2 + 1] - gy) > 1.5) {
      digGoal[i * 2] = gx; digGoal[i * 2 + 1] = gy;
      digBest[i] = dGoal; digStall[i] = 0;
    } else if (dGoal < digBest[i] - 0.25) {
      digBest[i] = dGoal; digStall[i] = 0;
    } else {
      digStall[i]++;
    }
    const cutStraight = digStall[i] >= DIG_STALL;
    const goal = want;

    // Lean toward buried food if any is close enough to smell. Kept slight on
    // purpose: let it pull hard and colonies beeline for caches and stop
    // building nests, which is a worse thing to watch. It only steers which way
    // new soil is cut. Walking open tunnel it used to steer too, and standing
    // right at a peak of the smell, where "uphill" points a different way at
    // every step, diggers walked tiny circles on the spot for hours.
    const scent = W.sampleCache(A.x[i], A.y[i]);
    if (scent > 0.05) {
      const toward = W.cacheUphill(A.x[i], A.y[i]);
      if (!isNaN(toward)) {
        want += wrapAngle(toward - want) * C.CACHE_SCENT_BIAS * Math.min(1, scent * 2);
      }
    }
    // Open ground is walked toward the goal itself. Stalled: only the way
    // straight ahead counts; if that is soil, it is cut.
    const probes = cutStraight ? 1 : PROBES.length;
    for (let k = 0; k < probes; k++) {
      const a = goal + PROBES[k];
      const nx = A.x[i] + Math.cos(a) * 1.2, ny = A.y[i] + Math.sin(a) * 1.2;
      if (W.passableAt(nx, ny)) {
        steer(i, a, 0.4);
        tunnelStep(i);
        return;
      }
    }
    const fx = Math.floor(A.x[i] + Math.cos(want)), fy = Math.floor(A.y[i] + Math.sin(want));
    const t = W.tileAt(fx, fy);
    if (W.isDiggable(t)) {
      A.digTile[i] = fy * C.W + fx;
      setState(i, ST.DIGGING);
      A.timer[i] = digTicks();
      col.log(i, 3);
      return;
    }
    // Stone. It cannot be cut, so skirt around it.
    for (let k = 0; k < SKIRT.length; k++) {
      const a = want + SKIRT[k];
      const nx = A.x[i] + Math.cos(a) * 1.2, ny = A.y[i] + Math.sin(a) * 1.2;
      if (W.passableAt(nx, ny)) {
        steer(i, a, 0.5);
        tunnelStep(i);
        return;
      }
      const sx = Math.floor(A.x[i] + Math.cos(a)), sy = Math.floor(A.y[i] + Math.sin(a));
      const st = W.tileAt(sx, sy);
      if (W.isDiggable(st)) {
        A.digTile[i] = sy * C.W + sx;
        setState(i, ST.DIGGING);
        A.timer[i] = digTicks();
        col.log(i, 3);
        return;
      }
    }
    A.hd[i] += (Math.random() - 0.5) * 1.5;
    tunnelStep(i);
  }

  // ------------------------------------------------------------------- nurses

  function stepNurse(i, nest) {
    const bc = NS.brood(nest);
    switch (A.state[i]) {
      case ST.IDLE:
      case ST.TEND: {
        if (aboveGround(i)) { headInside(i, nest); break; }
        const inChamber = dist2(A.x[i], A.y[i], bc.x, bc.y) < bc.r * bc.r * 1.4;

        // Still holding the queen's food (interrupted on the way): carry on.
        if (A.carry[i] === CARRY.FOOD && nest.queen >= 0) {
          nest.queenFeeder = i;
          setState(i, ST.TO_QUEEN);
          break;
        }

        if ((col.tick + i) % 20 === 0) {
          if (queenWantsFeeding(nest)) { nest.queenFeeder = i; setState(i, ST.FETCH_ROYAL); break; }
          if (nest.looseEggs.length && Math.random() < 0.6) {
            const b = nest.looseEggs[(Math.random() * nest.looseEggs.length) | 0];
            if (B.alive[b] && B.held[b] < 0) { A.target[i] = b; setState(i, ST.HAUL_EGG); break; }
          }
          if (nest.hungryLarvae.length && nest.res.food > C.FEED_RESERVE) {
            const b = nest.hungryLarvae[(Math.random() * nest.hungryLarvae.length) | 0];
            if (B.alive[b] && B.stage[b] === 1) { A.target[i] = b; setState(i, ST.TO_LARVA); break; }
          }
        }
        if (!inChamber) navDown(i, nest.fBrood, bc.x, bc.y);
        else tendRound(i, nest, bc);
        break;
      }

      case ST.TO_LARVA: {
        const b = A.target[i];
        if (b < 0 || !B.alive[b] || B.stage[b] !== 1) { A.target[i] = -1; setState(i, ST.TEND); break; }
        const d = dist2(A.x[i], A.y[i], B.x[b], B.y[b]);
        if (d < 1.2) { setState(i, ST.FEEDING); A.timer[i] = 45; break; }
        if (d > 36) navDown(i, nest.fBrood, B.x[b], B.y[b]);
        else { steer(i, Math.atan2(B.y[b] - A.y[i], B.x[b] - A.x[i]), 0.3); tunnelStep(i); }
        break;
      }

      case ST.FEEDING: {
        A.timer[i]--;
        if (A.timer[i] <= 0) {
          const b = A.target[i];
          // Brood is fed from surplus only — never down to the last scraps.
          if (b >= 0 && B.alive[b] && nest.res.food > C.FEED_RESERVE &&
              nest.res.water > C.FEED_RESERVE * 0.7) {
            nest.res.food -= C.FEED_COST;
            nest.res.water -= C.FEED_COST * 0.6;
            // What the larva eats becomes the body it will emerge with.
            nest.res.biomass += C.FEED_COST * 0.75;
            B.fed[b] += C.FEED_VALUE;
            A.sFed[i]++;
            A.stuck[i] = 0;
            nest.stats.larvaeFed++;
            col.log(i, 6);
          }
          A.target[i] = -1;
          setState(i, ST.TEND);
        }
        break;
      }

      case ST.HAUL_EGG: {
        // Eggs, larvae and pupae alike: anything lying outside the nursery
        // (including when the nursery moves deeper) is carried in and set down
        // in a free spot of its own.
        const b = A.target[i];
        if (b < 0 || !B.alive[b]) { A.target[i] = -1; setState(i, ST.TEND); break; }
        if (A.carry[i] === CARRY.EGG) {
          B.x[b] = A.x[i]; B.y[b] = A.y[i];
          // In the nursery by distance, or by its route map: the map counts
          // every open tile of the room, and a nurse just past the radius but
          // already "there" on the map had nowhere left to walk and circled.
          const inside = dist2(A.x[i], A.y[i], bc.x, bc.y) < bc.r * bc.r || atField(i, nest.fBrood, 0);
          const gx = A.memx[i], gy = A.memy[i];
          if (inside && (gx < 0 || dist2(A.x[i], A.y[i], gx, gy) < 0.35)) {
            B.held[b] = -1;
            A.carry[i] = CARRY.NONE; A.target[i] = -1; A.memx[i] = -1;
            col.log(i, 7);
            setState(i, ST.TEND);
          } else if (inside) {
            steer(i, Math.atan2(gy - A.y[i], gx - A.x[i]), 0.35);
            if (!tunnelStep(i)) A.memx[i] = -1;       // can't get there: set it down here
          } else navDown(i, nest.fBrood, bc.x, bc.y);
        } else {
          if (B.held[b] >= 0) { A.target[i] = -1; setState(i, ST.TEND); break; }
          const d = dist2(A.x[i], A.y[i], B.x[b], B.y[b]);
          if (d < 1.2) {
            B.held[b] = i; A.carry[i] = CARRY.EGG; A.carryAmt[i] = 1;
            const spot = broodSpot(bc);
            A.memx[i] = spot ? spot.x : -1;
            A.memy[i] = spot ? spot.y : -1;
          }
          else if (d > 36) navDown(i, nest.fQueen, B.x[b], B.y[b]);
          else { steer(i, Math.atan2(B.y[b] - A.y[i], B.x[b] - A.x[i]), 0.3); tunnelStep(i); }
        }
        break;
      }

      // ---- feeding the queen ----
      // She never leaves her chamber. A nurse collects food and water from the
      // larder and carries it down to her.
      case ST.FETCH_ROYAL: {
        if (aboveGround(i)) { headInside(i, nest); break; }
        const s = NS.store(nest);
        navDown(i, nest.fStore, s.x, s.y);
        if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r) {
          const food = Math.min(3, Math.max(0, nest.res.food - 1));
          const water = Math.min(3, Math.max(0, nest.res.water - 1));
          if (food + water < 0.5) { nest.queenFeeder = -1; setState(i, ST.TEND); break; }
          nest.res.food -= food;
          nest.res.water -= water;
          A.carry[i] = CARRY.FOOD;
          A.carryAmt[i] = food;
          A.ty[i] = water;                 // the water, carried with it
          setState(i, ST.TO_QUEEN);
        }
        break;
      }

      case ST.TO_QUEEN: {
        const q = nest.queen;
        if (q < 0 || !A.alive[q]) {
          nest.res.food += A.carryAmt[i];      // no queen to feed: back to the larder
          nest.res.water += A.ty[i];
          A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0; A.ty[i] = 0;
          nest.queenFeeder = -1;
          setState(i, ST.TEND);
          break;
        }
        if (aboveGround(i)) { headInside(i, nest); break; }
        const d = dist2(A.x[i], A.y[i], A.x[q], A.y[q]);
        if (d < 2.2) { setState(i, ST.FEED_QUEEN); A.timer[i] = 60; break; }
        if (d > 25) navDown(i, nest.fQueen, A.x[q], A.y[q]);
        else { steer(i, Math.atan2(A.y[q] - A.y[i], A.x[q] - A.x[i]), 0.3); tunnelStep(i); }
        break;
      }

      case ST.FEED_QUEEN: {
        const q = nest.queen;
        const alive = q >= 0 && A.alive[q];
        if (alive) A.hd[i] = Math.atan2(A.y[q] - A.y[i], A.x[q] - A.x[i]);
        A.timer[i]--;
        if (A.timer[i] > 0) break;
        // Same exchange rate she used to bill the larder at: 0.08 food per
        // point of energy, and the same for water.
        if (alive) {
          A.energy[q] = Math.min(C.ENERGY_MAX, A.energy[q] + A.carryAmt[i] / 0.08);
          A.hydration[q] = Math.min(C.HYDRATION_MAX, A.hydration[q] + A.ty[i] / 0.08);
          col.log(i, 26);
        } else {
          nest.res.food += A.carryAmt[i];
          nest.res.water += A.ty[i];
        }
        A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0; A.ty[i] = 0;
        nest.queenFeeder = -1;
        setState(i, ST.TEND);
        break;
      }

      default: setState(i, ST.TEND);
    }
  }

  // ----------------------------------------------------------------- soldiers

  function nearestRival(nest) {
    let best = null, bd = Infinity;
    for (const other of NS.list) {
      if (other === nest || !other.alive || other.count === 0) continue;
      const d = Math.abs(other.entrance.x - nest.entrance.x);
      if (d < bd) { bd = d; best = other; }
    }
    return best;
  }

  function stepSoldier(i, nest) {
    switch (A.state[i]) {
      case ST.IDLE:
      case ST.PATROL: {
        if (col.intruders.length) {
          const t = nearestIntruder(A.x[i], A.y[i], 26);
          if (t) { A.target[i] = col.intruders.indexOf(t); setState(i, ST.FIGHT); break; }
        }
        // A raiding colony sends its soldiers out to someone else's larder.
        if (nest.policy.mode === 'raid' && A.carry[i] === CARRY.NONE &&
            (col.tick + i) % 60 === 0 && Math.random() < 0.35) {
          const rival = nearestRival(nest);
          if (rival) { A.target[i] = rival.id; setState(i, ST.RAID_OUT); break; }
        }
        const al = W.sampleAlarm(A.x[i], A.y[i]);
        if (al > 0.08) { setState(i, ST.RESPOND); break; }

        if (aboveGround(i)) {
          surfaceStep(i, 0);
          if (Math.abs(A.x[i] - nest.entrance.x) > 22) {
            surfaceStep(i, A.x[i] < nest.entrance.x ? 1 : -1);
          }
        } else {
          // Soldiers stand guard for a spell, then walk a beat. The walk holds
          // a line with a gentle drift; a fresh random turn every tick made
          // them jitter in place.
          if ((col.tick + i * 7) % 420 < 180) loiter(i);
          else stroll(i);
          if ((col.tick + i) % 120 === 0 && W.fieldAt(nest.fHome, A.x[i], A.y[i]) > 60) {
            navDown(i, nest.fHome, nest.entrance.x, nest.entrance.y);
          }
        }
        break;
      }

      case ST.RESPOND: {
        const t = nearestIntruder(A.x[i], A.y[i], 30);
        if (t) { A.target[i] = col.intruders.indexOf(t); setState(i, ST.FIGHT); break; }
        const ang = aboveGround(i) ? NaN : alarmUphill(i);
        if (isNaN(ang)) {
          if (W.sampleAlarm(A.x[i], A.y[i]) < 0.02) setState(i, ST.PATROL);
          else if (aboveGround(i)) surfaceStep(i, 0); else tunnelStep(i);
        } else { steer(i, ang, 0.4); tunnelStep(i); }
        break;
      }

      case ST.FIGHT: {
        const t = col.intruders[A.target[i]];
        if (!t || t.hp <= 0) { A.target[i] = -1; setState(i, ST.PATROL); break; }
        const d = Math.hypot(t.x - A.x[i], t.y - A.y[i]);
        W.depositAlarm(A.x[i], A.y[i], C.ALARM_DROP);
        if (d < 1.4) {
          t.hp -= 0.85;
          A.sHits[i]++;
          if (col.tick % 60 === 0) col.log(i, 8);
        } else if (d < 30) {
          if (aboveGround(i) && Math.abs(t.y - A.y[i]) < 2) surfaceStep(i, t.x > A.x[i] ? 1 : -1);
          else { steer(i, Math.atan2(t.y - A.y[i], t.x - A.x[i]), 0.45); tunnelStep(i); }
        } else { A.target[i] = -1; setState(i, ST.PATROL); }
        break;
      }

      // ---- raiding a neighbour ----
      // Heading for their larder. Their own store field routes the whole way,
      // so if the two nests have dug into each other the raid simply goes
      // underground — the shortest path through open air is the tunnel, and
      // nobody had to be told it exists.
      case ST.RAID_OUT: {
        const rival = NS.get(A.target[i]);
        if (!rival || !rival.alive) { setState(i, ST.PATROL); break; }
        A.timer[i]++;
        if (A.timer[i] > 6000) { setState(i, ST.PATROL); break; }   // gave up

        if (aboveGround(i)) { headInside(i, rival); break; }
        const s = NS.store(rival);
        navDown(i, rival.fStore, s.x, s.y);
        if (atField(i, rival.fStore, 2) ||
            dist2(A.x[i], A.y[i], s.x, s.y) < (s.r + C.RAID_RANGE) * (s.r + C.RAID_RANGE)) {
          setState(i, ST.RAID_TAKE);
        }
        break;
      }

      case ST.RAID_TAKE: {
        const rival = NS.get(A.target[i]);
        if (!rival || !rival.alive) { setState(i, ST.RAID_HOME); break; }
        const s = NS.store(rival);
        navDown(i, rival.fStore, s.x, s.y);
        if (atField(i, rival.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < C.RAID_RANGE * C.RAID_RANGE) {
          // Take whichever they have more of. Stealing is cheaper than foraging
          // and that is exactly why hungry colonies do it.
          if (rival.res.food >= rival.res.water && rival.res.food > 1) {
            const take = Math.min(C.RAID_CARRY, rival.res.food);
            rival.res.food -= take;
            rival.stats.raidsLost += take;
            A.carry[i] = CARRY.FOOD; A.carryAmt[i] = take;
          } else if (rival.res.water > 1) {
            const take = Math.min(C.RAID_CARRY, rival.res.water);
            rival.res.water -= take;
            rival.stats.raidsLost += take;
            A.carry[i] = CARRY.WATER; A.carryAmt[i] = take;
          }
          col.log(i, 20);
          setState(i, ST.RAID_HOME);
        }
        break;
      }

      case ST.RAID_HOME: {
        // Our own store field routes home from anywhere — up out of their
        // shaft, across the surface, down ours. No special cases needed.
        if (aboveGround(i)) { headInside(i, nest); break; }
        const s = NS.store(nest);
        navDown(i, nest.fStore, s.x, s.y);
        if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r) {
          if (A.carry[i] === CARRY.WATER) nest.res.water += A.carryAmt[i];
          else nest.res.food += A.carryAmt[i];
          nest.stats.stolen += A.carryAmt[i];
          A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0;
          A.target[i] = -1;
          setState(i, ST.PATROL);
        }
        break;
      }

      default: setState(i, ST.PATROL);
    }
  }

  // --------------------------------------------------------- the clean-up crew
  //
  // Ants carry their dead out of the nest — necrophoresis, triggered in real
  // ants by the acids a body gives off after a few hours. Here an undertaker
  // simply looks for the nearest body nobody else has claimed. Its own dead go
  // to the waste chamber or the surface; a stranger's body is protein, and goes
  // to the larder.

  // Walk to an arbitrary spot, crossing between the surface and the tunnels as
  // needed. There is no distance field to a body — it can be anywhere — so this
  // is plain steering, the same way a nurse crosses a chamber to reach a larva.
  function approach(i, nest, tx, ty) {
    const targetAbove = ty < W.surfaceAt(tx) - 0.25;
    const meAbove = aboveGround(i);

    if (meAbove && targetAbove) { surfaceStep(i, tx > A.x[i] ? 1 : -1); return; }
    if (meAbove && !targetAbove) { headInside(i, nest); return; }
    if (!meAbove && targetAbove) { headOutside(i, nest, nest.fHome); return; }

    steer(i, Math.atan2(ty - A.y[i], tx - A.x[i]), 0.3);
    tunnelStep(i);
  }

  function nearestBody(i, nest, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    for (const c of col.corpses) {
      if (c.held >= 0) continue;
      const d = dist2(A.x[i], A.y[i], c.x, c.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // Where the dead are laid: a waste chamber if the colony has dug one,
  // otherwise out of the entrance and onto the midden like the spoil.
  function wasteSite(nest) {
    for (const n of nest.plan) {
      if (n.type === 'waste' && n.built >= 1 && !n.abandoned) return n;
    }
    return null;
  }

  function stepUndertaker(i, nest) {
    switch (A.state[i]) {
      case ST.IDLE:
      case ST.SEEK_BODY: {
        A.state[i] = ST.SEEK_BODY;
        if ((col.tick + i) % 12 === 0) {
          const c = nearestBody(i, nest, 140);
          if (c) { A.body[i] = c; setState(i, ST.TO_BODY); break; }
        }
        // Nothing to do: drift around the nest rather than stand still.
        if (aboveGround(i)) headInside(i, nest);
        else {
          // No bodies to deal with: walk the tunnels on the lookout, stopping
          // now and then, and never wandering far from home.
          const s = NS.store(nest);
          if (dist2(A.x[i], A.y[i], s.x, s.y) > 28 * 28) navDown(i, nest.fStore, s.x, s.y);
          else if ((col.tick + i * 11) % 320 < 70) fidget(i, 0.12, 0.15);
          else stroll(i, 0.5);
        }
        break;
      }

      case ST.TO_BODY: {
        const c = A.body[i];
        if (!c || c.held >= 0 || col.corpses.indexOf(c) < 0) {
          A.body[i] = null; setState(i, ST.SEEK_BODY); break;
        }
        if (dist2(A.x[i], A.y[i], c.x, c.y) < 1.4) {
          c.held = i;
          A.carry[i] = CARRY.CORPSE;
          A.carryAmt[i] = 1;
          setState(i, ST.HAUL_BODY);
          break;
        }
        approach(i, nest, c.x, c.y);
        break;
      }

      case ST.HAUL_BODY: {
        const c = A.body[i];
        if (!c) { A.carry[i] = CARRY.NONE; setState(i, ST.SEEK_BODY); break; }
        c.x = A.x[i]; c.y = A.y[i];

        // A stranger's body is food. Ours is refuse.
        if (c.nest !== nest.id) {
          const s = NS.store(nest);
          if (aboveGround(i)) { headInside(i, nest); break; }
          navDown(i, nest.fStore, s.x, s.y);
          if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r) {
            setState(i, ST.DUMP_BODY);
          }
          break;
        }

        const waste = wasteSite(nest);
        if (waste) {
          if (dist2(A.x[i], A.y[i], waste.x, waste.y) < (waste.r + 1) * (waste.r + 1)) {
            setState(i, ST.DUMP_BODY);
          } else approach(i, nest, waste.x, waste.y);
          break;
        }
        // No waste chamber yet: out of the front door.
        if (headOutside(i, nest, nest.fHome)) {
          A.timer[i]++;
          surfaceStep(i, A.x[i] < nest.entrance.x ? -1 : 1);
          if (A.timer[i] > 25 + (i % 20)) setState(i, ST.DUMP_BODY);
        }
        break;
      }

      case ST.DUMP_BODY: {
        const c = A.body[i];
        if (c) {
          const stranger = c.nest !== nest.id;
          nest.res.biomass += c.biomass;
          nest.res.food += stranger ? C.CORPSE_PROTEIN : c.food;
          nest.stats.bodiesCleared++;
          if (stranger) nest.stats.bodiesEaten++;
          const k = col.corpses.indexOf(c);
          if (k >= 0) col.corpses.splice(k, 1);
          col.log(i, stranger ? 23 : 22);
        }
        A.body[i] = null;
        A.carry[i] = CARRY.NONE; A.carryAmt[i] = 0;
        A.stuck[i] = 0;
        setState(i, ST.SEEK_BODY);
        break;
      }

      default: setState(i, ST.SEEK_BODY);
    }
  }

  function alarmUphill(i) {
    const x = Math.floor(A.x[i]), y = Math.floor(A.y[i]);
    let best = W.sampleAlarm(A.x[i], A.y[i]), bx = 0, by = 0, found = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!W.passable(x + dx, y + dy)) continue;
        const v = W.sampleAlarm(x + dx + 0.5, y + dy + 0.5);
        if (v > best) { best = v; bx = dx; by = dy; found = true; }
      }
    }
    return found ? Math.atan2(by, bx) : NaN;
  }

  // ------------------------------------------------------------------- queen

  function stepQueen(i, nest) {
    const q = NS.royal(nest);
    const d = dist2(A.x[i], A.y[i], q.x, q.y);
    if (d > q.r * q.r * 0.5) {
      navDown(i, nest.fQueen, q.x, q.y);
      A.state[i] = ST.IDLE;
    } else {
      loiter(i, q.x, q.y, q.r * 0.5);
      A.state[i] = ST.LAY;
    }

    // Her nurses bring her food and water (see FETCH_ROYAL); she never goes to
    // the larder. Only with no nurse left to bring anything does she live off
    // the stores and her body reserves directly, the way a founding queen
    // sealed in her chamber does.
    if (nest.castePop[CASTE.NURSE] === 0) {
      if (A.energy[i] < 70) {
        if (nest.res.food > 2) { nest.res.food -= 0.02 * LIFE; A.energy[i] += 0.25 * LIFE; }
        else if (nest.res.biomass > 5) { nest.res.biomass -= 0.05 * LIFE; A.energy[i] += 0.25 * LIFE; }
      }
      if (A.hydration[i] < 70) {
        if (nest.res.water > 2) { nest.res.water -= 0.02 * LIFE; A.hydration[i] += 0.25 * LIFE; }
        else if (nest.res.biomass > 5) { nest.res.biomass -= 0.05 * LIFE; A.hydration[i] += 0.25 * LIFE; }
      }
    }

    A.timer[i] += LIFE;                  // laying keeps colony time
    const plenty = nest.res.food > 70 && nest.res.water > 50;
    const rebuilding = nest.count < 16;
    const interval = C.EGG_INTERVAL * (plenty || rebuilding ? 1 : 2.5);
    const minFood = rebuilding ? 18 : Math.min(130, 30 + nest.count * 0.9);
    const minWater = rebuilding ? 14 : Math.min(95, 20 + nest.count * 0.65);

    // What the foragers can keep supplying, plus what the larder can raise
    // outright: an adult costs about 12 food all told (egg, then ~5.5 feedings
    // over the larval stage). Stores used to count one brood per 60 food, so a
    // colony in a defensive stance — soldiers up, foragers down to 3 of 18 —
    // capped out at 9 brood with 419 food in the larder, and aged to death.
    // Bounded by colony size so a handful of nurses isn't handed forty larvae.
    const fromStores = Math.floor(Math.max(0, nest.res.food - C.FEED_RESERVE) / 12);
    const broodCap = Math.max(3, Math.min(nest.count + 4,
      Math.round(nest.castePop[CASTE.FORAGER] * C.BROOD_PER_FORAGER) + fromStores));

    const stocked = nest.res.food >= minFood && nest.res.water >= minWater;
    const onReserves = rebuilding && nest.res.biomass > 30;

    if (A.timer[i] >= interval && (stocked || onReserves) &&
        nest.broodCount < broodCap &&
        col.freeBroodSlots() > 0 && col.count < C.MAX_ANTS - 2) {
      if (nest.res.food >= C.EGG_FOOD_COST) nest.res.food -= C.EGG_FOOD_COST;
      else nest.res.biomass -= 14;
      if (nest.res.water >= 1) nest.res.water -= 1;
      else nest.res.biomass -= 3;
      col.spawnBrood(nest, A.x[i] + (Math.random() - 0.5) * 2, A.y[i] + (Math.random() - 0.5) * 2);
      nest.stats.eggsLaid++;
      col.log(i, 10);
      A.timer[i] = 0;
    }
  }

  // The one genuine decision in the simulation. A queen cannot see the farm;
  // she knows how full her larder is, how much room is left to dig, and how
  // strongly her workers have been coming home smelling of strangers. She
  // commits to a stance for a while, with enough randomness that two colonies
  // in the same position do not always do the same thing.
  function reviewPolicy(nest) {
    const p = nest.policy;
    if (col.lifeTick - p.timer < C.POLICY_REVIEW) return;
    p.timer = col.lifeTick;

    let unbuilt = 0, rooms = 0;
    for (const n of nest.plan) {
      if (n.built < 1) unbuilt++;
      if (n.built >= 1 && !n.abandoned) rooms++;
    }
    const crowded = rooms > 0 && nest.count / rooms > 9;
    const hungry = nest.res.food < C.HOSTILE_FOOD || nest.res.water < C.HOSTILE_FOOD;
    const threatened = p.threat > 1.5;
    const small = nest.count < 25;

    const w = { grow: 1.0, expand: 0.7, defend: 0.15, raid: 0.03 };
    // Alone on the farm there is nothing to defend against and nobody to rob.
    if (NS.living().length < 2) { w.defend = 0.02; w.raid = 0; }
    if (threatened) { w.defend += 0.5 + p.threat * 0.35; w.grow -= 0.3; }
    if (crowded) w.expand += 1.1;
    if (hungry) { w.grow -= 0.45; w.expand -= 0.35; }
    // Raiding is a last resort: you need neighbours, hunger, and the numbers.
    if (hungry && threatened && !small) w.raid += 0.9 + p.threat * 0.2;
    if (small) { w.grow += 1.0; w.defend *= 0.5; w.raid = 0; }
    if (nest.res.food > 200 && nest.res.water > 150) w.expand += 0.5;

    let total = 0;
    for (const k in w) { w[k] = Math.max(0, w[k]); total += w[k]; }
    let roll = Math.random() * total;
    for (const k in w) {
      roll -= w[k];
      if (roll <= 0) { p.mode = k; break; }
    }
  }

  // ------------------------------------------------------------- eat & drink

  function stepEatDrink(i, nest) {
    const s = NS.store(nest);
    switch (A.state[i]) {
      case ST.GO_EAT:
      case ST.GO_DRINK: {
        if (aboveGround(i)) { headInside(i, nest); break; }
        navDown(i, nest.fStore, s.x, s.y);
        if (atField(i, nest.fStore, 1) || dist2(A.x[i], A.y[i], s.x, s.y) < s.r * s.r) {
          setState(i, A.state[i] === ST.GO_EAT ? ST.EATING : ST.DRINKING);
          A.timer[i] = A.state[i] === ST.EATING ? C.EAT_TICKS : C.DRINK_TICKS;
        }
        break;
      }
      case ST.EATING: {
        A.timer[i]--;
        if (A.timer[i] <= 0) {
          if (nest.res.food >= C.MEAL_COST) {
            nest.res.food -= C.MEAL_COST;
            A.energy[i] = C.ENERGY_MAX;
            col.log(i, 5);
          } else col.log(i, 14);
          setState(i, ST.IDLE);
        }
        break;
      }
      case ST.DRINKING: {
        A.timer[i]--;
        if (A.timer[i] <= 0) {
          if (nest.res.water >= C.SIP_COST) {
            nest.res.water -= C.SIP_COST;
            A.hydration[i] = C.HYDRATION_MAX;
            col.log(i, 17);
          } else col.log(i, 18);
          setState(i, ST.IDLE);
        }
        break;
      }
    }
  }

  // An ant walled off from its nest claws its way back toward the entrance.
  function digOut(i, nest) {
    const ang = Math.atan2(nest.entrance.y - A.y[i], nest.entrance.x - A.x[i]);
    steer(i, ang, 0.25);
    tunnelStep(i);
    if (A.stuck[i] % 25 === 0) {
      for (let k = 0; k < PROBES.length; k++) {
        const a = ang + PROBES[k];
        const fx = Math.floor(A.x[i] + Math.cos(a)), fy = Math.floor(A.y[i] + Math.sin(a));
        const t = W.tileAt(fx, fy);
        if (W.isDiggable(t)) {
          W.setTile(fx, fy, T.AIR);
          W.refreshColumn(fx);
          nest.stats.tilesDug++;
          nest.pendingSpoil++;
          col.log(i, 3);
          return;
        }
      }
    }
  }

  // Where each ant last got somewhere. Distance walked alone can't tell pacing
  // from progress: an ant going round and round in the same few tiles walks
  // plenty, and a digger did that for hours without the watchdog noticing.
  // An ant with an errand that stays within a few tiles of one spot for
  // PACING_TICKS is treated as stuck.
  const PACING_TICKS = 600;
  const lastReplan = new Int32Array(C.MAX_ANTS).fill(-1000);
  const paceX = new Float32Array(C.MAX_ANTS), paceY = new Float32Array(C.MAX_ANTS);
  const paceT = new Int32Array(C.MAX_ANTS).fill(-1), paceS = new Int16Array(C.MAX_ANTS).fill(-1);
  // Jobs that are meant to mill about in one area.
  const WANDERING = new Set([ST.IDLE, ST.TEND, ST.PATROL, ST.REST, ST.RESPOND, ST.FIGHT, ST.AVOID,
    ST.SEEK_FOOD, ST.SEEK_WATER, ST.SEEK_BODY]);

  function pacing(i) {
    const moved = Math.hypot(A.x[i] - paceX[i], A.y[i] - paceY[i]);
    if (paceT[i] < 0 || moved > 3 || A.state[i] !== paceS[i]) {
      paceX[i] = A.x[i]; paceY[i] = A.y[i]; paceT[i] = col.tick; paceS[i] = A.state[i];
      return false;
    }
    if (col.tick - paceT[i] < PACING_TICKS) return false;
    paceT[i] = col.tick;
    return A.caste[i] !== CASTE.QUEEN && !WANDERING.has(A.state[i]) && !stationary(A.state[i]);
  }

  // States where standing still is the job, not a fault.
  function stationary(s) {
    return s === ST.EATING || s === ST.DRINKING || s === ST.DIGGING ||
           s === ST.FEEDING || s === ST.LAY || s === ST.REST || s === ST.FEED_QUEEN;
  }

  function stepAnt(i) {
    if (!metabolism(i)) return;
    const nest = nestOf(i);
    unstick(i);

    // Progress watchdog. Local steering can wedge an ant against geometry it
    // cannot reason about. Rather than special-case each way that happens,
    // notice it has stopped getting anywhere and make it re-plan.
    const raiding = A.state[i] === ST.RAID_OUT || A.state[i] === ST.RAID_TAKE ||
                    A.state[i] === ST.RAID_HOME;
    if (!aboveGround(i) && !raiding && W.fieldAt(nest.fHome, A.x[i], A.y[i]) < 0) {
      A.stuck[i] += 1;
    } else if ((col.tick + i) % 60 === 0) {
      const travelled = A.sDist[i] - A.lx[i];
      A.lx[i] = A.sDist[i];
      // Standing still is fine for an ant that is loitering on purpose.
      const loitering = Math.abs(col.tick - lastLoiter[i]) <= 2;
      // "No headway" is judged against what this ant could cover in the
      // window: half its possible distance, capped at the old 0.8 tiles. A
      // fixed 0.8 flagged the queen at half walking pace (she can only manage
      // 0.66) every minute, and the watchdog kept turning her around and
      // eventually had her dig her way "out" of her own chamber.
      const expected = Math.min(0.8, A.spd[i] * C.WALK_PACE * 60 * 0.5);
      if (travelled < expected && !stationary(A.state[i]) && !loitering) A.stuck[i] += 60;
      else A.stuck[i] = 0;
      if (pacing(i)) {
        // Re-plan now. Brood being carried is set down where it is, so a
        // nurse that gives up doesn't walk off holding it forever.
        if (A.carry[i] === CARRY.EGG && A.target[i] >= 0) {
          B.held[A.target[i]] = -1;
          A.carry[i] = CARRY.NONE;
          A.target[i] = -1;
        }
        A.stuck[i] = 180;
      }
    }

    if (A.stuck[i] > 420) { digOut(i, nest); return; }
    // Once per stuck spell, not every tick: the count only moves at each
    // minute's check, so it sat on 180 and the ant re-planned sixty times over,
    // flipping between two dig sites each tick.
    if (A.stuck[i] >= 180 && A.stuck[i] % 180 === 0 && col.tick - lastReplan[i] >= 60) {
      lastReplan[i] = col.tick;
      const n = A.node[i] >= 0 ? nest.plan[A.node[i]] : null;
      if (n && Math.hypot(n.x - A.x[i], n.y - A.y[i]) > n.r + 2) n.fails++;
      releaseNode(i, nest);
      A.target[i] = -1; A.digTile[i] = -1;
      A.hd[i] = Math.random() * TAU;
      setState(i, ST.IDLE);
    }

    if (handleStrangers(i, nest)) return;

    needsInterrupt(i, nest);

    const st = A.state[i];
    if (st === ST.GO_EAT || st === ST.EATING || st === ST.GO_DRINK || st === ST.DRINKING) {
      stepEatDrink(i, nest);
      return;
    }

    switch (A.caste[i]) {
      case CASTE.QUEEN: stepQueen(i, nest); break;
      case CASTE.FORAGER: stepForager(i, nest); break;
      case CASTE.DIGGER: stepDigger(i, nest); break;
      case CASTE.NURSE: stepNurse(i, nest); break;
      case CASTE.SOLDIER: stepSoldier(i, nest); break;
      case CASTE.UNDERTAKER: stepUndertaker(i, nest); break;
    }
  }

  // ------------------------------------------------------------------- brood

  function stepBrood() {
    for (let b = 0; b < C.MAX_BROOD; b++) {
      if (!B.alive[b]) continue;
      if (B.held[b] >= 0) continue;
      const nest = NS.get(B.nest[b]);
      if (!nest) continue;

      const st = B.stage[b];
      if (st === 0) {
        B.t[b] += LIFE;
        if (B.t[b] >= C.EGG_T) {
          nest.broodPop[0]--; nest.broodPop[1]++;
          B.stage[b] = 1; B.t[b] = 0; B.fed[b] = 40;
        }
      } else if (st === 1) {
        // Last resort: a colony down to the queen has nobody left to forage,
        // so she metabolises the corpse pool into a starter crew.
        if (B.fed[b] <= 0 && nest.count <= 3 && nest.res.biomass > 15) {
          B.fed[b] += 14 * LIFE;
          nest.res.biomass -= 0.4 * LIFE;
        }
        if (B.fed[b] > 0) { B.fed[b] -= C.LARVA_BURN * LIFE; B.t[b] += LIFE; }
        else B.t[b] -= 0.12 * LIFE;
        if (B.t[b] < -900) { col.killBrood(b); continue; }
        if (B.t[b] >= C.LARVA_T) {
          nest.broodPop[1]--; nest.broodPop[2]++;
          B.stage[b] = 2; B.t[b] = 0;
        }
      } else {
        B.t[b] += LIFE;
        if (B.t[b] >= C.PUPA_T) {
          // Queenless but still strong enough to carry on: raise a new queen.
          const caste = (nest.queen < 0 && nest.count >= 5)
            ? CASTE.QUEEN
            : col.chooseCaste(nest);
          const id = col.spawnAnt(nest, caste, B.x[b], B.y[b], false);
          if (id >= 0) col.consumeBrood(b);
          else B.t[b] = C.PUPA_T - 60;   // no biomass spare — wait in the cocoon
        }
      }
    }
  }

  // ------------------------------------------------------------- housekeeping

  function refreshBroodLists() {
    for (const nest of NS.list) {
      nest.hungryLarvae.length = 0;
      nest.looseEggs.length = 0;
    }
    for (let b = 0; b < C.MAX_BROOD; b++) {
      if (!B.alive[b]) continue;
      const nest = NS.get(B.nest[b]);
      if (!nest) continue;
      const bc = NS.brood(nest);
      const rr = bc.r * bc.r * 1.6;
      if (B.stage[b] === 1 && B.fed[b] < 15 && nest.hungryLarvae.length < 400) {
        nest.hungryLarvae.push(b);
      }
      if (B.held[b] < 0 && dist2(B.x[b], B.y[b], bc.x, bc.y) > rr && nest.looseEggs.length < 200) {
        nest.looseEggs.push(b);
      }
    }
  }

  // Shift workers between jobs as a nest's needs move.
  function rebalanceLabour(nest) {
    if (nest.count < 3) return;

    // At least one nurse whenever there's a queen: she's fed by them.
    const needNurses = nest.broodPop[1] > 0
      ? Math.max(2, Math.ceil(nest.broodPop[1] / 6))
      : (nest.queen >= 0 ? 1 : 0);
    if (nest.castePop[CASTE.NURSE] < needNurses) {
      col.retask(nest, CASTE.NURSE, nest.castePop[CASTE.DIGGER] > 2 ? CASTE.DIGGER : null);
    }

    const needForagers = Math.min(4, nest.count - 1);
    if (nest.castePop[CASTE.FORAGER] < needForagers ||
        ((nest.res.food < 20 || nest.res.water < 20) &&
         nest.castePop[CASTE.FORAGER] < nest.count * 0.55)) {
      col.retask(nest, CASTE.FORAGER, nest.castePop[CASTE.DIGGER] > 1 ? CASTE.DIGGER : null);
    }

    let unbuilt = 0;
    for (const n of nest.plan) if (n.built < 1) unbuilt++;

    if (unbuilt > 0 && nest.res.food > 120 && nest.res.water > 80 &&
        nest.castePop[CASTE.DIGGER] < nest.count * 0.2) {
      col.retask(nest, CASTE.DIGGER, CASTE.FORAGER);
    }
    if (unbuilt === 0 && nest.castePop[CASTE.DIGGER] > 2) {
      col.retask(nest, CASTE.FORAGER, CASTE.DIGGER);
    }
    // Under threat, put bodies on the door.
    if (nest.policy.mode === 'defend' && nest.castePop[CASTE.SOLDIER] < nest.count * 0.2) {
      col.retask(nest, CASTE.SOLDIER, CASTE.DIGGER);
    }

    // After a bad fight the floor is covered. Put more hands on clearing it —
    // every body left lying is biomass the colony does not get back.
    const bodies = col.corpses.length;
    if (bodies > 6 && nest.castePop[CASTE.UNDERTAKER] < Math.min(8, Math.ceil(bodies / 10))) {
      col.retask(nest, CASTE.UNDERTAKER, null);
    }
  }

  // Judge a dig site by whether the hole is getting bigger, not by how the
  // diggers look.
  const REVIEW_EVERY = 120;
  const MAX_CREW = 8;          // diggers one unfinished site keeps; the rest re-pick
  // A room that stalls with most of it dug is finished, not failed. The last
  // tile or two is usually tucked behind stone where no digger can stand, and
  // writing the whole chamber off for that left colonies believing they owned
  // one room — so they couldn't anchor new ones, site an entrance, or aim for
  // food, and their diggers sat idle inside chambers that were 99% open.
  const DONE_ENOUGH = 0.85;

  // A breach is aimed at the rim of a neighbour's room, so part of its footprint
  // is already their open air before anyone digs. Held to the usual bar, a
  // gallery was written off at 81% with the tunnel all but through.
  function doneEnough(n) {
    return n.type === 'breach' ? 0.6 : DONE_ENOUGH;
  }

  function reviewDigSites(nest) {
    // Recount claims from the ants actually holding them rather than trusting a
    // running tally. Any path that forgets to release one — death, a job change,
    // a colony collapse — would otherwise leave a room looking busy forever.
    for (const n of nest.plan) n.claims = 0;
    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i] || A.nest[i] !== nest.id || A.node[i] < 0) continue;
      const site = nest.plan[A.node[i]];
      if (!site) continue;
      // A digger only re-picks when its site is finished, so one big room
      // could hold the whole crew — 27 of 27 in one test — while a new shaft
      // sat untouched until it timed out. Past a working crew, the rest are
      // sent to choose again, and the crowding penalty spreads them out.
      if (site.built < 1 && site.claims >= MAX_CREW && A.state[i] !== ST.DIGGING) {
        A.node[i] = -1;
        if (A.state[i] === ST.TO_DIG) A.state[i] = ST.IDLE;
        continue;
      }
      site.claims++;
    }

    for (const n of nest.plan) {
      // Heal rooms wrongly written off before this rule existed.
      if (n.abandoned && n.type !== 'entrance' && W.nodeProgress(n) >= doneEnough(n)) {
        n.abandoned = false;
        n.built = 1;
        continue;
      }
      if (n.built >= 1) continue;
      // Most of a shaft's work is the gallery below its mouth, which the disc
      // at the ground line never sees. Count tiles bored too, or it times out
      // while they are still digging down to the nest.
      if ((n.bored || 0) > (n.lastBored || 0)) {
        n.lastBored = n.bored;
        n.idleTicks = 0;
        n.fails = 0;
        continue;
      }
      const p = W.nodeProgress(n);
      if (p > (n.lastProgress || 0) + 0.001) {
        n.lastProgress = p;
        n.idleTicks = 0;
        n.fails = 0;
      } else if (n.claims > 0 || n.opportunistic) {
        // Side errands — a new entrance, a food spur, a breach — are timed out
        // whether or not anyone holds a claim. They sit at the end of a long
        // gallery, so their diggers rack up fail penalties until nobody will
        // take them; left uncounted, a dead shaft stayed "outstanding" forever
        // and blocked the colony from ever siting another.
        n.idleTicks = (n.idleTicks || 0) + REVIEW_EVERY;
        // Doubled when cuts got slow (DIG_SLOW): a digger can go a long while
        // between cuts once a spoil haul and a meal fall in the same stretch.
        const limit = (n.opportunistic ? 9000 : 6000) * 2;
        if (n.idleTicks > limit) {
          n.built = 1;
          if (p < doneEnough(n)) n.abandoned = true;   // genuinely unreachable
        }
      }
    }
  }

  // A colony with no queen and nobody left is finished. Its rooms do not go to
  // waste: the nearest surviving nest inherits the ground, and any brood still
  // in the nursery is raised as theirs. Brood raiding is real ant behaviour,
  // and it is why a lost war can end with your daughters working for someone
  // else.
  function settleEstates() {
    for (const dead of NS.list) {
      if (!dead.alive) continue;
      if (dead.count > 0 || dead.queen >= 0) continue;

      dead.alive = false;
      let heir = null, bd = Infinity;
      for (const other of NS.list) {
        if (other === dead || !other.alive || other.count === 0) continue;
        const d = Math.abs(other.entrance.x - dead.entrance.x);
        if (d < bd) { bd = d; heir = other; }
      }
      if (!heir) continue;

      for (const n of dead.plan) {
        if (n.built >= 1 && !n.abandoned) heir.plan.push(n);
      }
      dead.plan = [];
      heir.res.food += dead.res.food;
      heir.res.water += dead.res.water;
      heir.res.biomass += dead.res.biomass;
      dead.res.food = dead.res.water = dead.res.biomass = 0;

      for (let b = 0; b < C.MAX_BROOD; b++) {
        if (B.alive[b] && B.nest[b] === dead.id) col.adoptBrood(b, heir);
      }
      heir.stats.conquests++;
      W.fieldsStale = true;
    }
  }

  // Grow the farm once a nest works its way out toward a wall.
  function considerExpansion() {
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nest of NS.list) {
      for (const n of nest.plan) {
        if (n.abandoned) continue;
        minX = Math.min(minX, n.x - n.r);
        maxX = Math.max(maxX, n.x + n.r);
        maxY = Math.max(maxY, n.y + n.r);
      }
    }
    if (minX === Infinity) return;

    const m = C.GROW_MARGIN;
    const wide = (maxX - minX) > C.W * 0.55;
    const deep = maxY > C.SKY + (C.H - C.SKY) * 0.62;

    const addLeft = (minX < m || wide) ? C.GROW_STEP_X : 0;
    const addRight = (maxX > C.W - m || wide) ? C.GROW_STEP_X : 0;
    const addDown = (maxY > C.H - m || deep) ? C.GROW_STEP_Y : 0;
    if (!addLeft && !addRight && !addDown) return;

    const shift = W.expand(addLeft, addRight, addDown);
    if (shift <= 0 && !addRight && !addDown) return;

    if (shift > 0) {
      for (let i = 0; i < C.MAX_ANTS; i++) {
        if (!A.alive[i]) continue;
        A.x[i] += shift;
        A.tx[i] += shift;
        A.lx[i] = A.sDist[i];
        if (A.memx[i] >= 0) A.memx[i] += shift;
      }
      for (let b = 0; b < C.MAX_BROOD; b++) if (B.alive[b]) B.x[b] += shift;
      for (const p of col.piles) p.x += shift;
      for (const p of col.puddles) p.x += shift;
      for (const t of col.intruders) t.x += shift;
      for (const nest of NS.list) {
        for (const n of nest.plan) n.x += shift;
        nest.entrance.x += shift;
        for (const e of nest.entrances) if (e !== nest.entrance) e.x += shift;
        nest.founding.x += shift;
        if (nest.larder) nest.larder.x += shift;
      }
    }

    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      A.digTile[i] = -1;
      if (A.state[i] === ST.DIGGING) setState(i, ST.TO_DIG);
    }

    NS.rebuildFields();
    if (AF.render && AF.render.worldResized) AF.render.worldResized(shift);
  }

  function updateResources() {
    for (let k = col.piles.length - 1; k >= 0; k--) {
      if (col.piles[k].amount <= 0.01) col.piles.splice(k, 1);
    }
    for (let k = col.puddles.length - 1; k >= 0; k--) {
      const p = col.puddles[k];
      p.amount -= C.EVAPORATION * LIFE;
      if (p.amount <= 0.01) col.puddles.splice(k, 1);
    }
    if (C.WILD_FOOD && lifeEvery(C.WILD_FOOD_EVERY)) {
      const x = 8 + Math.random() * (C.W - 16);
      col.addPile(x, W.surfaceAt(x) - 0.6);
    }
  }

  // ---------------------------------------------------------------- intruders

  function nearestIntruder(x, y, maxD) {
    let best = null, bd = maxD * maxD;
    for (const t of col.intruders) {
      const d = dist2(x, y, t.x, t.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  function spawnIntruder() {
    if (!NS.living().length) return;       // nothing to raid yet
    const x = Math.random() < 0.5 ? 6 + Math.random() * 20 : C.W - 26 + Math.random() * 20;
    col.intruders.push({
      x, y: W.surfaceAt(x) - 0.6,
      hp: C.INTRUDER_HP, max: C.INTRUDER_HP,
      hd: 0, timer: 0,
      target: NS.living()[0],
    });
  }

  function stepIntruders() {
    // With no nest left (or none yet), a beetle has nowhere to go: it leaves.
    const home = NS.living()[0];
    if (!home) { col.intruders.length = 0; return; }
    for (let k = col.intruders.length - 1; k >= 0; k--) {
      const t = col.intruders[k];
      if (t.timer > C.INTRUDER_PATIENCE) { col.intruders.splice(k, 1); continue; }
      if (t.hp <= 0) {
        // A dead beetle is a windfall for whoever brought it down.
        const nest = t.target && t.target.alive ? t.target : home;
        nest.res.biomass += 14;
        nest.res.food += 10;
        col.intruders.splice(k, 1);
        continue;
      }
      const nest = t.target && t.target.alive ? t.target : home;
      const above = t.y < W.surfaceAt(t.x) - 0.25;
      if (above) {
        const dx = nest.entrance.x - t.x;
        t.x += Math.sign(dx) * 0.075 * C.WALK_PACE;
        t.y = W.surfaceAt(t.x) - 0.6;
        if (dx) t.hd += wrapAngle((dx > 0 ? 0 : Math.PI) - t.hd) * 0.25;
        if (Math.abs(dx) < 1.2) {
          t.x = nest.entrance.x; t.y = nest.entrance.y + 0.5;
          t.hd = Math.PI / 2;                        // head first down the hole
        }
      } else {
        const ang = W.downhill(nest.fBrood, t.x, t.y);
        const a = isNaN(ang) ? Math.random() * TAU : ang;
        const step = 0.07 * C.WALK_PACE;
        const nx = t.x + Math.cos(a) * step, ny = t.y + Math.sin(a) * step;
        if (W.passableAt(nx, ny)) {
          t.x = nx; t.y = ny;
          // Turn toward where it's going rather than snapping: with no scent
          // to follow the direction is random each tick, and it would spin.
          t.hd += wrapAngle(a - t.hd) * 0.12;
        }
      }

      W.depositAlarm(t.x, t.y, C.ALARM_DROP * 0.6);
      t.timer++;
      if (t.timer % C.INTRUDER_BITE_EVERY === 0) {
        AF.grid.near(t.x, t.y, 1.6, i => {
          A.health[i] -= C.INTRUDER_BITE;
          col.log(i, 9);
          W.depositAlarm(A.x[i], A.y[i], C.ALARM_DROP);
          if (A.caste[i] !== CASTE.SOLDIER && A.caste[i] !== CASTE.QUEEN && Math.random() < 0.5) {
            A.hd[i] = Math.atan2(A.y[i] - t.y, A.x[i] - t.x);
          }
          if (A.health[i] <= 0) col.killAnt(i, 'killed');
          return true;      // one bite at a time
        });
      }
    }
  }

  // -------------------------------------------------------------- the tick

  sim.tick = function () {
    col.tick++;
    LIFE = sim.lifeRate();
    lifeBefore = col.lifeTick;
    col.lifeTick += LIFE;

    W.decayPheromones();
    AF.grid.rebuild();

    for (const nest of NS.list) nest.policy.threat *= C.THREAT_DECAY;

    for (let i = 0; i < C.MAX_ANTS; i++) {
      if (!A.alive[i]) continue;
      // Headings get nudged all over the place; keep them in one turn so they
      // can't grow without limit (see wrapAngle).
      const h = A.hd[i];
      if (h > Math.PI || h < -Math.PI) A.hd[i] = wrapAngle(h);
      stepAnt(i);
    }

    stepBrood();
    stepIntruders();
    for (const t of col.intruders) t.hd = wrapAngle(t.hd || 0);
    updateResources();
    col.rotCorpses();

    if (col.tick % 45 === 0) refreshBroodLists();
    if (col.tick % 240 === 0) for (const n of NS.list) if (n.alive) rebalanceLabour(n);
    if (col.tick % REVIEW_EVERY === 0) for (const n of NS.list) if (n.alive) reviewDigSites(n);
    if (lifeEvery(C.ERODE_EVERY)) W.erode(C.ERODE_SAMPLES);        // weather keeps colony time
    W.relaxSpoil(4);                                              // loose soil slides in real time
    if (col.tick % C.FIELD_REBUILD_EVERY === 0 && W.fieldsStale) NS.rebuildFields();
    if (col.tick % 600 === 0) for (const n of NS.list) if (n.alive) NS.expandPlan(n);
    if (col.tick % 200 === 0) for (const n of NS.list) if (n.alive) NS.checkEntrances(n);
    if (col.tick % 300 === 0) for (const n of NS.list) if (n.alive) reviewPolicy(n);
    if (col.tick % 900 === 0) considerExpansion();
    if (col.tick % 400 === 0) settleEstates();
    if (lifeEvery(C.INTRUDER_EVERY) && col.count > 25) spawnIntruder();
  };

  // ------------------------------------------------------- inspector wording

  sim.goalText = function (i) {
    const st = A.state[i];
    if ((st === ST.HAUL_FOOD || st === ST.STORE_FOOD) && A.carry[i] === CARRY.WATER) {
      return 'Hauling water';
    }
    return AF.ST_NAME[st] || 'Idle';
  };

  sim.thought = function (i) {
    const st = A.state[i], caste = A.caste[i];
    const nest = nestOf(i);
    const thirsty = A.hydration[i] < C.THIRSTY_AT, hungry = A.energy[i] < C.HUNGRY_AT;
    const foreign = NS.count() > 1 && NS.sampleForeign(nest, A.x[i], A.y[i]) > C.FOREIGN_SENSE;

    switch (st) {
      case ST.SEEK_FOOD:
        if (foreign) return 'Another colony has been over this ground. Tread carefully.';
        return NS.sampleTrail(nest, A.x[i], A.y[i]) > 0.1
          ? 'Someone came through here carrying food. Worth following.'
          : 'Nothing out here yet. Keep sweeping.';
      case ST.SEEK_WATER:
        return 'The colony is dry. There has to be water somewhere on the surface.';
      case ST.TO_FOOD: return 'Food. Straight for it.';
      case ST.TO_WATER: return 'Water ahead — fill up and get back.';
      case ST.HAUL_FOOD:
        return A.carry[i] === CARRY.WATER
          ? 'Heavy load of water. Back to the store, marking the way.'
          : 'Got it. Home, and lay a trail so the others find this.';
      case ST.STORE_FOOD: return 'Unloading into the larder.';
      case ST.LEAVE_NEST: return 'Out through the entrance and back to the search.';
      case ST.TO_DIG: {
        const n = nest.plan[A.node[i]];
        return n ? 'Working the ' + n.type + ' face. Get there and cut.' : 'Looking for something to dig.';
      }
      case ST.DIGGING: return 'Soil here is loose enough. Cut it free.';
      case ST.HAUL_DIRT: return 'Carrying spoil out. It cannot stay in the tunnel.';
      case ST.DUMP_DIRT: return 'Clear of the heap. Drop it.';
      case ST.TEND: return nest.hungryLarvae.length ? 'Brood are calling to be fed.' : 'All quiet in the nursery.';
      case ST.TO_LARVA: return 'That larva is hungry. Going to it.';
      case ST.FEEDING: return 'Feeding. It grows only while it eats.';
      case ST.HAUL_EGG: return A.carry[i] === CARRY.EGG
        ? 'This belongs in the nursery. Find it a spot of its own.'
        : 'Brood lying where it shouldn\'t be. Pick it up.';
      case ST.FETCH_ROYAL: return 'The queen is hungry. Fetch her food and water from the larder.';
      case ST.TO_QUEEN: return 'Carrying her meal down to the royal chamber.';
      case ST.FEED_QUEEN: return 'Feeding the queen.';
      case ST.GO_EAT: return 'Running low. Heading to the store.';
      case ST.EATING: return 'Eating.';
      case ST.GO_DRINK: return 'Parched. The store should have water.';
      case ST.DRINKING: return 'Drinking.';
      case ST.LAY: {
        const mode = nest.policy.mode;
        if (mode === 'defend') return 'Strangers on our ground. Lay soldiers.';
        if (mode === 'raid') return 'We cannot feed ourselves. They can. Lay soldiers.';
        if (mode === 'expand') return 'Too many of us for these chambers. More diggers.';
        return nest.res.food > 25
          ? 'Well fed. Keep laying — the colony can afford more brood.'
          : 'Not enough food coming in. Slow the laying down.';
      }
      case ST.PATROL: return foreign
        ? 'Their scent is on the wind. Stay between it and the nest.'
        : 'Nothing on the air. Keep walking the perimeter.';
      case ST.RESPOND: return 'Alarm scent, strong. Something is wrong that way.';
      case ST.FIGHT: return 'Intruder. Hold it here and bite.';
      case ST.RAID_OUT: return 'Their nest is that way. We need what is in it.';
      case ST.RAID_TAKE: return 'Their larder. Take what I can carry.';
      case ST.RAID_HOME: return 'Loaded. Out, and home before they rally.';
      case ST.REST: return 'Nothing needs digging. Wait.';
      default:
        if (thirsty) return 'Thirsty.';
        if (hungry) return 'Hungry.';
        return caste === CASTE.QUEEN ? 'Still.' : 'Waiting for something to do.';
    }
  };
})();
