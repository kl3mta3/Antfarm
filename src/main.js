// Wiring: the real-time loop, caretaker tools, and the inspector panel.
(function () {
  const AF = window.AF, C = AF.CFG, W = AF.world, col = AF.colony, sim = AF.sim, R = AF.render;
  const A = col.A, CASTE = AF.CASTE, CARRY = AF.CARRY;

  const TICK_HZ = C.BASE_HZ;
  const STEP_MS = 1000 / TICK_HZ;
  const TICKS_PER_DAY = C.DAY_TICKS;    // a colony day, on the life clock

  const canvas = document.getElementById('farm');
  const $ = id => document.getElementById(id);

  // Two ways to watch. At / everyone sees the one house farm, simulated on the
  // server; at /play the whole farm runs here in the browser, yours alone.
  const HOUSE = AF.MODE === 'house';

  // ?embed=1 — just the farm, no toolbar or panels, for showing it inside
  // another page (the landing page's live window).
  if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');

  let tool = 'select';
  let autoTend = false;
  try { autoTend = localStorage.getItem('antfarm.autotend') === '1'; } catch (e) { /* fine */ }
  let acc = 0, last = performance.now(), tendTicks = 0;
  let tickCounter = 0, rateTimer = performance.now(), simRate = 0;

  // ---------------------------------------------------------------- start up

  function newColony(queens) {
    R.selected = -1;
    if (HOUSE) { houseAct({ type: 'new', queens }); return; }
    AF.persist.clear();
    const q = queens == null ? 1 : queens;     // 0 is a real choice: bare ground
    W.generate(q);
    col.reset(q);
    R.fit();
    R.clampCam();
  }

  R.init(canvas);
  R.resize();

  if (HOUSE) {
    // Bare ground to draw until the server's first keyframe lands.
    W.generate(1);
    col.reset(1);
    col.initPool();
    for (const n of AF.nests.list) { n.count = 0; n.castePop.fill(0); }
    AF.mirror.onKey = () => { R.resize(); R.fit(); R.clampCam(); syncButtons(); };
    AF.mirror.onControls = () => syncButtons();
    AF.mirror.onStatus = msg => { if (msg) flash(msg); };
    AF.mirror.connect();
  } else {
    // Pick up where the farm left off, if there is a colony to come back to.
    let restored = false;
    try { restored = AF.persist.load(); } catch (e) { restored = false; }
    if (!restored) { W.generate(1); col.reset(1); }
  }

  R.resize();
  R.fit();
  R.clampCam();

  // Auto-tend: keep something on the surface to forage whenever the stores or
  // the surface supply run low. Takes the caretaking off your hands, and with
  // it the risk of coming back to a dead farm.
  // Every nest gets tended at its own door. Feeding the farm as a whole would
  // hand the lot to whichever colony happened to be nearest the drop.
  function tend() {
    if (!autoTend) return;

    for (const nest of AF.nests.list) {
      if (!nest.alive || nest.count === 0) continue;

      // Water stays close to the entrance and food gets scattered. Thirst
      // kills faster than hunger, so a reliable drink is what keeps a long
      // search survivable — and it is how you'd tend a real farm anyway.
      const range = AF.forageRange(nest);
      const wet = 34;
      const nearWater = () => Math.max(6, Math.min(C.W - 6,
        nest.entrance.x + (Math.random() * 2 - 1) * wet));
      // Inside the search radius, or it may as well not be there: ants turn
      // back at the edge of their range and would never reach it.
      const scatterFood = () => Math.max(6, Math.min(C.W - 6,
        nest.entrance.x + (Math.random() < 0.5 ? -1 : 1) * (16 + Math.random() * range * 0.8)));

      const nearby = (list, reach) => list.reduce((sum, p) =>
        sum + (Math.abs(p.x - nest.entrance.x) < reach ? p.amount : 0), 0);

      // Scale the ration with the colony, and the drop size with it too — a
      // fixed handful silently caps how big they can ever get.
      const foodWant = 70 + nest.count * 2.6;
      const waterWant = 70 + nest.count * 2.2;
      const load = Math.max(C.PILE_AMOUNT, Math.round(nest.count * 3));

      // The only reason to hold off is the ground already being littered. Gate
      // loosely: a strict gate stops restocking while food the ants have not
      // found yet sits outside, and the larder empties underneath it.
      // Two reasons to drop: the stores are running low, or there's barely
      // anything left lying out on the surface. The second keeps food and water
      // visibly out in the farm even once the larder is full — a well-fed colony
      // stops foraging and leaves it there.
      const onGroundFood = nearby(col.piles, range);
      const onGroundWater = nearby(col.puddles, wet * 1.6);
      const keepOut = Math.max(40, nest.count);
      if ((nest.res.food < foodWant && onGroundFood < foodWant * 1.5) || onGroundFood < keepOut) {
        const x = scatterFood();
        col.addPile(x, W.surfaceAt(x) - 0.6, load);
      }
      if ((nest.res.water < waterWant && onGroundWater < waterWant * 1.5) || onGroundWater < keepOut) {
        const x = nearWater();
        col.addPuddle(x, W.surfaceAt(x) - 0.4, load);
      }
    }
  }

  // Autosave: periodically, and whenever the page is being put away.
  // (Only your own farm. The house farm is saved on the server.)
  if (!HOUSE) {
    setInterval(() => { if (!sim.paused) AF.persist.save(); }, 10000);
    window.addEventListener('pagehide', () => AF.persist.save());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) AF.persist.save();
    });
  }

  // A window listener alone misses the cases that actually happen: the pane
  // being resized, or the layout settling after load. Watch the element.
  window.addEventListener('resize', () => R.viewportChanged());
  if (window.ResizeObserver) {
    new ResizeObserver(() => R.viewportChanged()).observe(canvas.parentElement);
  }

  // ------------------------------------------------------- the real-time loop
  // Fixed 60Hz steps with an accumulator, so the colony advances at the same
  // pace whether the tab renders at 60fps or 30.

  // Advance the colony by however much real time has passed. Catch-up is
  // capped so a long stall can't dump thousands of ticks in one go.
  function advance(now, maxCatchupMs, maxSteps) {
    const dt = Math.min(maxCatchupMs, now - last);
    last = now;
    if (HOUSE || sim.paused) return;      // the house farm ticks on the server

    acc += dt;
    let budget = 0;
    while (acc >= STEP_MS && budget < maxSteps) {
      // The speed setting is how many ticks run per step: at 24×, 24 times as
      // much of everything happens each second.
      for (let s = 0; s < sim.speed; s++) {
        sim.tick();
        tickCounter++;
        if (++tendTicks >= C.TEND_EVERY) { tendTicks = 0; tend(); }
      }
      acc -= STEP_MS;
      budget++;
    }
    if (acc > STEP_MS * 8) acc = 0;
  }

  // rAF stops firing when the window is hidden, which would freeze the farm
  // the moment you switch tabs. A timer keeps it alive (and skips drawing).
  let hiddenTimer = null;
  function onVisibility() {
    if (document.hidden) {
      if (!hiddenTimer) {
        hiddenTimer = setInterval(() => advance(performance.now(), 2000, 180), 200);
      }
    } else if (hiddenTimer) {
      clearInterval(hiddenTimer);
      hiddenTimer = null;
      last = performance.now();
      acc = 0;
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  onVisibility();

  // Some browsers stop animation frames for a window that is covered or
  // minimised without ever marking the page hidden, and the farm would freeze.
  // If frames stall, keep time moving from a timer instead.
  let lastFrameAt = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (!HOUSE && !document.hidden && now - lastFrameAt > 500) advance(now, 2000, 180);
  }, 250);

  function frame(now) {
    lastFrameAt = performance.now();
    if (HOUSE) AF.mirror.update(now);
    else if (!document.hidden) advance(now, 250, 20);
    R.draw();

    if (now - rateTimer > 500) {
      simRate = Math.round(tickCounter / ((now - rateTimer) / 1000));
      tickCounter = 0; rateTimer = now;
    }
    updatePanel();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------------- input

  let dragging = false, dragged = false, lastX = 0, lastY = 0;

  canvas.addEventListener('mousedown', e => {
    dragging = true; dragged = false;
    lastX = e.clientX; lastY = e.clientY;
  });

  window.addEventListener('mouseup', e => {
    if (dragging && !dragged) handleClick(e);
    dragging = false;
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
    if (dragged) {
      const s = R.cam.zoom * C.TILE / R.dpr;
      R.cam.x -= dx / s;
      R.cam.y -= dy / s;
      R.clampCam();
      lastX = e.clientX; lastY = e.clientY;
    }
  });

  // Zoom by a factor, keeping the world point under (clientX, clientY) still.
  // A phone's high-density screen gets a closer maximum, or ants never get
  // big enough to make out; with a mouse the limit is what it always was.
  const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  function zoomAt(clientX, clientY, factor) {
    const maxZoom = coarsePointer ? 14 * Math.max(1, R.dpr / 1.5) : 14;
    const rect = canvas.getBoundingClientRect();
    const before = R.screenToWorld(clientX - rect.left, clientY - rect.top);
    R.cam.zoom = Math.max(0.35, Math.min(maxZoom, R.cam.zoom * factor));
    const after = R.screenToWorld(clientX - rect.left, clientY - rect.top);
    R.cam.x += before.x - after.x;
    R.cam.y += before.y - after.y;
    R.clampCam();
  }

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  // ---- touch: one finger pans, two fingers pinch to zoom, a tap selects ----
  // Phones don't turn drags or pinches into mouse or wheel events, so without
  // this the farm could only ever be seen at its fitted, zoomed-out size.
  // Only touch events are handled here; mouse and wheel are untouched.
  let touchMode = null, tapOk = false;
  let tapX = 0, tapY = 0, lastTX = 0, lastTY = 0, pinchSpread = 0;
  const midOf = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const spreadOf = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const panBy = (dx, dy) => {
    const s = R.cam.zoom * C.TILE / R.dpr;
    R.cam.x -= dx / s;
    R.cam.y -= dy / s;
    R.clampCam();
  };
  function startPinch(t) {
    touchMode = 'pinch';
    tapOk = false;
    pinchSpread = spreadOf(t);
    const m = midOf(t);
    lastTX = m.x; lastTY = m.y;
  }

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches;
    if (t.length === 1) {
      touchMode = 'pan';
      tapOk = true;
      tapX = lastTX = t[0].clientX;
      tapY = lastTY = t[0].clientY;
    } else if (t.length >= 2) {
      startPinch(t);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches;
    if (t.length >= 2) {
      if (touchMode !== 'pinch') { startPinch(t); return; }
      const m = midOf(t), spread = spreadOf(t);
      zoomAt(m.x, m.y, spread / Math.max(1, pinchSpread));
      panBy(m.x - lastTX, m.y - lastTY);            // two fingers also drag the view
      pinchSpread = spread;
      lastTX = m.x; lastTY = m.y;
    } else if (t.length === 1 && touchMode === 'pan') {
      if (Math.abs(t[0].clientX - tapX) + Math.abs(t[0].clientY - tapY) > 10) tapOk = false;
      panBy(t[0].clientX - lastTX, t[0].clientY - lastTY);
      lastTX = t[0].clientX; lastTY = t[0].clientY;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();          // no emulated mouse click on top of our tap
    if (e.touches.length === 0) {
      if (touchMode === 'pan' && tapOk) handleClick({ clientX: tapX, clientY: tapY });
      touchMode = null;
    } else if (e.touches.length === 1) {
      // One finger lifted mid-pinch: carry on panning with the other.
      touchMode = 'pan';
      tapOk = false;
      lastTX = tapX = e.touches[0].clientX;
      lastTY = tapY = e.touches[0].clientY;
    }
  }, { passive: false });
  canvas.addEventListener('touchcancel', () => { touchMode = null; tapOk = false; });

  // Zoom buttons (shown on touch screens only), around the middle of the view.
  const zoomFromCentre = factor => {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };
  $('zoomIn').onclick = () => zoomFromCentre(1.5);
  $('zoomOut').onclick = () => zoomFromCentre(1 / 1.5);

  function handleClick(e) {
    const rect = canvas.getBoundingClientRect();
    const p = R.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    if (p.x < 0 || p.x >= C.W) return;

    if (tool === 'food' || tool === 'water' || tool === 'queen') {
      if (locked()) { setTool('select'); openLogin(); return; }
      if (HOUSE) {
        const wasQueen = tool === 'queen';
        houseAct({ type: tool, x: p.x }).then(res => { if (res.ok && wasQueen) setTool('select'); });
        return;
      }
      if (tool === 'food') col.addPile(p.x, W.surfaceAt(p.x) - 0.6);
      else if (tool === 'water') col.addPuddle(p.x, W.surfaceAt(p.x) - 0.4);
      else {
        const res = AF.nests.found(p.x);
        if (!res.ok) { flash(res.error); return; }
        setTool('select');
      }
    } else {
      const i = R.pickAnt(p.x, p.y);
      R.selected = i;
      renderAntCard(true);
    }
  }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();

    // view-only keys work signed out
    if (k === 'escape') {
      if (!$('loginScrim').hidden) { closeLogin(); return; }
      if (!$('renameScrim').hidden) { closeRename(); return; }
      if (!$('newScrim').hidden) { closeNewColony(); return; }
      setTool('select'); return;
    }
    if (k === 'p') { R.showPheromones = !R.showPheromones; syncButtons(); return; }
    // The nest plan is for keepers on the house farm (anyone on their own).
    if (k === 'n') { if (!locked()) { R.showPlan = !R.showPlan; syncButtons(); } return; }

    if (locked()) return;
    if (k === ' ') { e.preventDefault(); togglePause(); }
    else if (k === 'f') setTool(tool === 'food' ? 'select' : 'food');
    else if (k === 'w') setTool(tool === 'water' ? 'select' : 'water');
    else if (k === '[' || k === ']') {
      const stops = C.SPEED_STOPS;
      const cur = HOUSE ? AF.mirror.controls.speed : sim.speed;
      const at = Math.max(0, stops.indexOf(cur));
      setSpeed(stops[Math.max(0, Math.min(stops.length - 1, at + (k === ']' ? 1 : -1)))]);
    }
  });

  // ----------------------------------------------------------------- toolbar

  function togglePause() {
    if (HOUSE) { houseAct({ type: 'pause', paused: !AF.mirror.controls.paused }); return; }
    sim.paused = !sim.paused;
    syncButtons();
  }
  function setSpeed(s) {
    if (HOUSE) { houseAct({ type: 'speed', speed: s }); return; }
    sim.speed = s;
    sim.paused = false;
    syncButtons();
  }
  function setTool(t) {
    tool = t;
    canvas.style.cursor = t === 'select' ? 'crosshair' : 'copy';
    syncButtons();
  }

  // Controls that change the farm need a signed-in keeper. Watching it —
  // pheromones, the nest plan, following an ant, framing the view — does not.

  // A one-line message under the toolbar, for things that aren't alerts.
  let flashUntil = 0;
  function flash(msg) {
    $('flash').textContent = msg;
    $('flash').hidden = false;
    flashUntil = performance.now() + 5000;
  }

  // Your own farm is yours: nothing to sign in for. The house farm is shared.
  function locked() { return HOUSE && !AF.auth.signedIn; }

  // In the house farm every change is a request. The server checks the
  // keeper's token and makes the change, or says why not.
  async function houseAct(action) {
    const res = await AF.mirror.act(action);
    if (!res.ok) {
      if (res.status === 401) { await AF.auth.refresh(); openLogin(); }
      else flash(res.error || 'The farm did not accept that.');
    }
    return res;
  }

  function guard(fn) {
    return (...args) => {
      if (locked()) { openLogin(); return; }
      return fn(...args);
    };
  }

  $('btnPause').onclick = guard(togglePause);
  // Speed: a slider from real time up to 24×, locking onto each stop. The
  // label follows while dragging; the speed changes when it's let go.
  const slider = $('speed');
  slider.max = String(C.SPEED_STOPS.length - 1);
  slider.oninput = () => { $('speedLabel').textContent = speedText(C.SPEED_STOPS[+slider.value]); };
  slider.onchange = guard(() => { setSpeed(C.SPEED_STOPS[+slider.value]); slider.blur(); });
  $('btnFood').onclick = guard(() => setTool(tool === 'food' ? 'select' : 'food'));
  $('btnWater').onclick = guard(() => setTool(tool === 'water' ? 'select' : 'water'));
  $('btnAuto').onclick = guard(() => {
    if (HOUSE) { houseAct({ type: 'autoTend', on: !AF.mirror.controls.autoTend }); return; }
    autoTend = !autoTend;
    try { localStorage.setItem('antfarm.autotend', autoTend ? '1' : '0'); } catch (e) { /* fine */ }
    syncButtons();
  });
  $('btnQueen').onclick = guard(() => {
    if (AF.nests.list.length >= AF.MAX_NESTS) {
      flash('The farm already holds as many nests as it can.');
      return;
    }
    setTool(tool === 'queen' ? 'select' : 'queen');
    if (tool === 'queen') flash('Click the surface where the new queen should dig in.');
  });
  $('btnPh').onclick = () => { R.showPheromones = !R.showPheromones; syncButtons(); };
  $('btnPlan').onclick = guard(() => { R.showPlan = !R.showPlan; syncButtons(); });
  $('btnFollow').onclick = () => { R.follow = !R.follow; syncButtons(); };
  $('btnFit').onclick = () => { R.fit(); R.clampCam(); };
  $('btnReset').onclick = guard(() => openNewColony());

  // Between the two farms. Your own opens in a new tab so the house farm keeps
  // playing where you left it.
  $('btnOwn').onclick = () => window.open('/play', '_blank', 'noopener');
  $('btnHouse').onclick = () => { location.href = '/'; };
  $('btnOwn').hidden = !HOUSE;
  $('btnHouse').hidden = HOUSE;
  $('btnBookmark').hidden = HOUSE;
  $('btnAuth').hidden = !HOUSE;

  // Keep a link back to a personal farm. No browser lets a page add a bookmark
  // itself any more, so: on a phone or tablet, open the share sheet with the
  // link (it offers "Add bookmark" and "Add to home screen"); elsewhere, copy
  // the link and give the keyboard shortcut. The farm lives in this browser's
  // storage, so the bookmark only brings it back in the same browser.
  $('btnBookmark').onclick = async () => {
    const url = location.origin + '/play';
    if (navigator.share && coarsePointer) {
      try {
        await navigator.share({ title: 'My ant farm', url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;          // they closed the share sheet
      }
    }
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) { /* no clipboard access */ }
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    flash('Press ' + (mac ? '⌘D' : 'Ctrl+D') + ' to bookmark this page' +
      (copied ? ' (the link is copied too)' : '') +
      '. Your farm is saved in this browser, so come back to it in the same one.');
  };

  // ------------------------------------------------------------- sign-in UI

  function openLogin() {
    $('loginErr').textContent = '';
    $('loginScrim').hidden = false;
    $('loginUser').focus();
  }
  function closeLogin() { $('loginScrim').hidden = true; }

  $('loginCancel').onclick = closeLogin;
  $('loginScrim').onmousedown = e => { if (e.target === $('loginScrim')) closeLogin(); };

  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('loginGo');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const res = await AF.auth.signIn($('loginUser').value, $('loginPass').value);
    btn.disabled = false;
    btn.textContent = 'Sign in';
    if (res.ok) {
      $('loginPass').value = '';
      closeLogin();
    } else {
      $('loginErr').textContent = res.error;
    }
  };

  $('btnAuth').onclick = () => {
    if (AF.auth.signedIn) AF.auth.signOut();
    else openLogin();
  };

  AF.auth.onChange = syncButtons;
  AF.auth.refresh();

  // --------------------------------------------------------------- renaming
  // A keeper can name a nest (click its title) or an ant (click its name in
  // the inspector). In the house farm the name goes through the server, which
  // checks the sign-in, and everyone watching sees it. An ant's name lasts as
  // long as the ant: when it dies its slot gets a new id and the default back.
  let renaming = null;

  function openRename(target) {
    if (locked()) return;
    if (target.kind === 'farm') {
      renaming = target;
      $('renameTitle').textContent = 'Name the house farm';
      $('renameSub').textContent = 'Everyone watching sees the new name.';
      $('renameInput').value = AF.mirror.controls.name || '';
      $('renameInput').placeholder = 'The house farm';
      $('renameErr').textContent = '';
      $('renameScrim').hidden = false;
      $('renameInput').focus();
      $('renameInput').select();
      return;
    }
    renaming = target;
    const isNest = target.kind === 'nest';
    const nest = isNest ? AF.nests.get(target.id) : null;
    $('renameTitle').textContent = isNest ? 'Name this nest' : 'Name this ant';
    $('renameSub').textContent = isNest
      ? (HOUSE ? 'Everyone watching the house farm sees the new name.' : 'Shown on this nest’s card.')
      : (HOUSE ? 'Everyone who inspects this ant sees it. It lasts as long as the ant does.'
               : 'It lasts as long as the ant does.');
    $('renameInput').value = isNest ? (nest.name || '') : (col.antName(target.i) || '');
    $('renameInput').placeholder = isNest
      ? (nestNames[nest.id] || ('Nest ' + (nest.id + 1)))
      : 'Ant #' + target.uid;
    $('renameErr').textContent = '';
    $('renameScrim').hidden = false;
    $('renameInput').focus();
    $('renameInput').select();
  }
  function closeRename() { $('renameScrim').hidden = true; renaming = null; }

  async function saveRename(raw) {
    const t = renaming;
    if (!t) return;
    const name = AF.nests.cleanName(raw);
    if (t.kind === 'ant' && (!A.alive[t.i] || A.uid[t.i] !== t.uid)) {
      $('renameErr').textContent = 'That ant has died.';
      return;
    }
    if (HOUSE) {
      const res = await AF.mirror.act({ type: 'rename', kind: t.kind, id: t.id, i: t.i, uid: t.uid, name });
      if (!res.ok) {
        if (res.status === 401) { closeRename(); await AF.auth.refresh(); openLogin(); return; }
        $('renameErr').textContent = res.error || 'That name wasn’t saved.';
        return;
      }
      // Show it straight away; the server's copy arrives within a second.
      if (t.kind === 'nest') { const n = AF.nests.get(t.id); if (n) n.name = res.name || null; }
      if (t.kind === 'farm') { AF.mirror.controls.name = res.name || null; syncButtons(); }
    } else if (t.kind === 'nest') {
      const n = AF.nests.get(t.id);
      if (n) n.name = name;
    } else {
      col.setAntName(t.i, name);
    }
    closeRename();
    renderAntCard(true);
  }

  $('nestCards').addEventListener('click', e => {
    const el = e.target.closest('[data-nest]');
    if (el && !locked()) openRename({ kind: 'nest', id: Number(el.dataset.nest) });
  });
  $('antCard').addEventListener('click', e => {
    const el = e.target.closest('[data-ant]');
    if (!el || locked()) return;
    const i = Number(el.dataset.ant);
    if (A.alive[i]) openRename({ kind: 'ant', i, uid: A.uid[i] });
  });
  $('renameForm').onsubmit = e => { e.preventDefault(); saveRename($('renameInput').value); };
  $('renameReset').onclick = () => saveRename('');
  $('renameCancel').onclick = closeRename;
  $('renameScrim').onmousedown = e => { if (e.target === $('renameScrim')) closeRename(); };
  $('farmTitle').addEventListener('click', () => { if (HOUSE && !locked()) openRename({ kind: 'farm' }); });

  // --------------------------------------------------------- new colony UI

  let queenCount = 1;
  const QUEEN_NOTES = [
    'No queens yet: just the ground. Use Add queen to place each one where you want her.',
    'One queen, one nest. The farm is hers alone.',
    'Two nests, at opposite ends of the farm. They will meet — over food first, and over ground after.',
    'Three nests on one stretch of soil. Expect raids.',
  ];

  function openNewColony() {
    $('queenNote').textContent = QUEEN_NOTES[queenCount];
    $('newScrim').hidden = false;
  }
  function closeNewColony() { $('newScrim').hidden = true; }

  $('newCancel').onclick = closeNewColony;
  $('newScrim').onmousedown = e => { if (e.target === $('newScrim')) closeNewColony(); };

  document.querySelectorAll('#queenChoices button').forEach(b => {
    b.onclick = () => {
      queenCount = parseInt(b.dataset.q, 10);
      document.querySelectorAll('#queenChoices button')
        .forEach(o => o.classList.toggle('on', o === b));
      $('queenNote').textContent = QUEEN_NOTES[queenCount];
    };
  });

  $('newForm').onsubmit = e => {
    e.preventDefault();
    closeNewColony();
    newColony(queenCount);
  };

  function syncButtons() {
    const lock = locked();
    $('btnAuth').textContent = lock ? 'Sign in' : 'Sign out';
    $('btnAuth').title = lock ? '' : 'Signed in as ' + (AF.auth.user || 'keeper');
    // Signed out, the controls that change the farm aren't shown at all —
    // greyed-out buttons a watcher can't use are just clutter.
    document.querySelectorAll('.keeper').forEach(el => { el.hidden = lock; });
    if (lock && tool !== 'select') setTool('select');
    if (lock && R.showPlan) R.showPlan = false;           // the plan is keepers-only

    // The farm's title. On the house farm a keeper can click it to rename the
    // farm for everyone.
    const farmTitle = HOUSE ? (AF.mirror.controls.name || 'The house farm') : 'Your farm';
    if ($('farmTitle').textContent !== farmTitle) $('farmTitle').textContent = farmTitle;
    $('farmTitle').classList.toggle('nameable', HOUSE && !lock);
    $('farmTitle').title = HOUSE && !lock ? 'Click to rename' : '';

    const paused = HOUSE ? AF.mirror.controls.paused : sim.paused;
    const speed = HOUSE ? AF.mirror.controls.speed : sim.speed;
    $('btnPause').textContent = paused ? 'Resume' : 'Pause';
    $('btnPause').classList.toggle('on', paused);
    if (document.activeElement !== $('speed')) {
      $('speed').value = String(Math.max(0, C.SPEED_STOPS.indexOf(speed)));
      $('speedLabel').textContent = speedText(speed);
    }
    $('btnFood').classList.toggle('on', tool === 'food');
    $('btnWater').classList.toggle('on', tool === 'water');
    $('btnAuto').classList.toggle('on', HOUSE ? AF.mirror.controls.autoTend : autoTend);
    $('btnQueen').classList.toggle('on', tool === 'queen');
    $('btnPh').classList.toggle('on', R.showPheromones);
    $('btnPlan').classList.toggle('on', R.showPlan);
    $('btnFollow').classList.toggle('on', R.follow);
  }
  syncButtons();

  // ------------------------------------------------------------------- panel

  let panelFrame = 0;

  function updatePanel() {
    if (panelFrame++ % 6 !== 0) return;

    const t = col.totals();
    $('pop').textContent = t.count.toLocaleString();
    $('popLabel').textContent = AF.nests.count() > 1
      ? 'ants across ' + AF.nests.living().length + ' nests' : 'ants alive';
    $('clock').textContent = clockText();

    renderNestCards();

    const s = t;
    $('births').textContent = s.births;
    $('deaths').textContent = s.deaths;
    $('starved').textContent = s.starved;
    $('dehydrated').textContent = s.dehydrated;
    $('killed').textContent = s.killed;
    $('recycled').textContent = s.recycled;
    $('freeslots').textContent = col.freeSlots();
    $('gathered').textContent = s.foodGathered.toFixed(0);
    $('wgathered').textContent = s.waterGathered.toFixed(0);
    $('dirt').textContent = s.tilesDug;
    $('fed').textContent = s.larvaeFed;
    $('fps').textContent = (HOUSE ? AF.mirror.rate : simRate) + ' ticks/s';

    if (flashUntil && performance.now() > flashUntil) {
      $('flash').hidden = true;
      flashUntil = 0;
    }

    renderAlerts();
    renderAntCard(false);
  }

  // "1× · real time", "6× · a day in 4 h", "24× · a day in 1 h"
  function speedText(s) {
    if (s === 1) return '1× · real time';
    const h = 24 / s;
    return s + '× · a day in ' + (Number.isInteger(h) ? h : h.toFixed(1)) + ' h';
  }

  // A span of colony time, in the largest unit that reads naturally.
  function lifeText(t) {
    const days = t / TICKS_PER_DAY;
    if (days >= 1) return (days < 10 ? days.toFixed(1) : Math.round(days)) + ' days';
    const hours = days * 24;
    if (hours >= 1) return hours.toFixed(1) + ' h';
    return Math.max(1, Math.round(hours * 60)) + ' min';
  }

  function clockText() {
    const now = col.lifeTick || 0;
    const day = Math.floor(now / TICKS_PER_DAY) + 1;
    const inDay = now % TICKS_PER_DAY;
    const hh = Math.floor(inDay / (TICKS_PER_DAY / 24));
    const mm = Math.floor((inDay % (TICKS_PER_DAY / 24)) / (TICKS_PER_DAY / 1440));
    // Real character, not an HTML entity — this is written with textContent.
    return 'day ' + day + ' · ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // What each queen is currently investing in, in plain words.
  const POLICY_TEXT = {
    grow: 'Growing — nurses and foragers',
    expand: 'Expanding — digging more room',
    defend: 'Defensive — raising soldiers',
    raid: 'Raiding — taking what they need',
  };

  const nestNames = ['First nest', 'Second nest', 'Third nest'];

  // Names are typed by keepers and shown to everyone, so they are always
  // escaped before going into the page.
  const esc = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nestLabel = nest => nest.name || nestNames[nest.id] || ('Nest ' + (nest.id + 1));
  const antLabel = i => col.antName(i) || ('Ant #' + A.uid[i]);
  // Marks a name as clickable to rename, for whoever is allowed to.
  const nameAttrs = (attr, value) => locked() ? '' :
    ' class="nameable" ' + attr + '="' + value + '" title="Click to rename"';

  function renderNestCards() {
    let html = '';
    for (const nest of AF.nests.list) {
      const pop = Math.max(1, nest.count);
      const dead = !nest.alive || nest.count === 0;
      const name = nestLabel(nest);

      html += '<div class="card">';
      html += '<h2><span class="swatch" style="background:' + nest.colors.tint +
        '"></span><span' + nameAttrs('data-nest', nest.id) + '>' + esc(name) + '</span>' +
        (dead ? ' — gone' : '') + '</h2>';

      if (dead) {
        html += '<div class="empty">No queen, no workers. Its chambers passed to whoever was nearest.</div></div>';
        continue;
      }

      html += '<div class="row"><span class="k">Ants</span><span class="v">' + nest.count + '</span></div>';

      let bar = '';
      for (let c = 0; c < AF.NCASTE; c++) {
        const pct = (nest.castePop[c] / pop) * 100;
        if (pct > 0) {
          bar += '<i style="width:' + pct + '%;background:' +
            nest.colors[AF.CASTE_KEY[c]] + '"></i>';
        }
      }
      html += '<div class="castebar">' + bar + '</div>';

      for (let c = 1; c < AF.NCASTE; c++) {
        html += '<div class="row"><span class="k">' + AF.CASTE_NAME[c] + 's</span>' +
          '<span class="v">' + nest.castePop[c] + '</span></div>';
      }

      html += '<div class="row" style="margin-top:8px"><span class="k">Food</span><span class="v">' +
        nest.res.food.toFixed(0) + '</span></div>' +
        '<div class="bar"><i style="background:var(--green);width:' +
        Math.min(100, nest.res.food / 3) + '%"></i></div>' +
        '<div class="row"><span class="k">Water</span><span class="v">' +
        nest.res.water.toFixed(0) + '</span></div>' +
        '<div class="bar"><i style="background:var(--blue);width:' +
        Math.min(100, nest.res.water / 3) + '%"></i></div>';

      html += '<div class="row"><span class="k">Brood</span><span class="v">' +
        nest.broodPop.join(' / ') + '</span></div>';
      html += '<div class="row"><span class="k">Queen</span><span class="v">' +
        (nest.queen >= 0 ? 'laying' : 'none') + '</span></div>';

      const st = nest.stats;
      if (st.bodiesCleared > 0) {
        html += '<div class="row"><span class="k">Bodies cleared</span><span class="v">' +
          st.bodiesCleared + '</span></div>';
      }

      if (AF.nests.count() > 1) {
        html += '<div class="thought" style="margin-top:10px">' +
          POLICY_TEXT[nest.policy.mode] +
          (nest.policy.threat > 1.5 ? '<br>Neighbours close by.' : '') + '</div>';

        // The war ledger, only once there is something in it.
        if (st.kills || st.captives || st.conquests || st.stolen || st.raidsLost || st.bodiesEaten) {
          html += '<h2 style="margin-top:12px">Against the neighbours</h2>';
          const line = (k, v) => '<div class="row"><span class="k">' + k +
            '</span><span class="v">' + v + '</span></div>';
          if (st.kills) html += line('Enemy ants killed', st.kills);
          if (st.captives) html += line('Brood captured', st.captives);
          if (st.conquests) html += line('Nests taken over', st.conquests);
          if (st.stolen) html += line('Stolen from rivals', st.stolen.toFixed(0));
          if (st.raidsLost) html += line('Lost to raiders', st.raidsLost.toFixed(0));
          if (st.bodiesEaten) html += line('Enemy dead eaten', st.bodiesEaten);
        }
      }
      html += '</div>';
    }
    $('nestCards').innerHTML = html;
  }

  // The farm depends on you. Say so, loudly, before anything dies.
  function renderAlerts() {
    const a = [];
    const many = AF.nests.count() > 1;
    for (const nest of AF.nests.list) {
      if (!nest.alive || nest.count === 0) continue;
      const who = many ? esc(nestLabel(nest)) + ': ' : '';
      if (nest.res.water < 12) a.push(['', who + 'out of water. Drop some on the surface.']);
      else if (nest.res.water < 35) a.push(['warn', who + 'water is running low.']);
      if (nest.res.food < 12) a.push(['', who + 'the larder is empty.']);
      else if (nest.res.food < 35) a.push(['warn', who + 'food is running low.']);
      if (nest.queen < 0) a.push(['', who + 'the queen is dead. No new eggs.']);
    }
    // An empty surface only matters if a nest is actually running low.
    const lowStores = AF.nests.list.some(n =>
      n.alive && n.count > 0 && (n.res.food < 100 || n.res.water < 100));
    if (lowStores && col.puddles.length === 0) a.push(['warn', 'No water on the surface to forage.']);
    if (lowStores && col.piles.length === 0) a.push(['warn', 'Nothing left to forage out there.']);
    if (col.intruders.length) a.push(['', 'An intruder is in the farm.']);

    $('alerts').innerHTML = a.slice(0, 6).map(x =>
      '<div class="alert ' + x[0] + '">' + x[1] + '</div>').join('');
  }

  function bar(label, val, max, color) {
    const pct = Math.max(0, Math.min(100, (val / max) * 100));
    return '<div class="row"><span class="k">' + label + '</span><span class="v">' +
      Math.round(val) + '</span></div><div class="bar"><i style="width:' + pct +
      '%;background:' + color + '"></i></div>';
  }

  function ago(t) {
    const secs = (col.tick - t) / TICK_HZ;
    if (secs < 1) return 'just now';
    if (secs < 90) return Math.round(secs) + 's ago';
    return Math.round(secs / 60) + 'm ago';
  }

  function renderAntCard(force) {
    const i = R.selected;
    const card = $('antCard');

    if (i < 0) {
      if (force || !card.dataset.empty) {
        card.dataset.empty = '1';
        card.innerHTML = '<h2>Inspector</h2><div class="empty">Click any ant to follow its mind.</div>' +
          '<div class="hint"><kbd>Space</kbd> pause &middot; <kbd>F</kbd> food &middot; ' +
          '<kbd>W</kbd> water &middot; <kbd>P</kbd> pheromones &middot; scroll to zoom, drag to pan</div>';
      }
      return;
    }
    card.dataset.empty = '';

    if (!A.alive[i]) {
      card.innerHTML = '<h2>Inspector</h2>' +
        '<div class="name">Ant #' + A.uid[i] + '</div>' +
        '<div class="thought">This ant is dead. Its body went back to the biomass pool, ' +
        'and slot ' + i + ' is queued for the next pupa.</div>' +
        '<button id="clearSel">Clear</button>';
      const b = $('clearSel');
      if (b) b.onclick = () => { R.selected = -1; renderAntCard(true); };
      return;
    }

    const caste = A.caste[i];
    const lifePct = Math.min(100, (A.age[i] / A.life[i]) * 100);
    const depth = Math.max(0, A.y[i] - W.surfaceAt(A.x[i]));

    const nest = AF.nests.get(A.nest[i]);
    const casteKey = AF.CASTE_KEY[caste];

    let html = '<h2>Inspector</h2>' +
      '<div class="row"><span class="name"><span' + nameAttrs('data-ant', i) + '>' +
        esc(antLabel(i)) + '</span></span>' +
      '<span class="badge" style="background:' + nest.colors[casteKey] + '">' +
      AF.CASTE_NAME[caste] + '</span></div>' +
      (AF.nests.count() > 1
        ? '<div class="row"><span class="k">Nest</span><span class="v">' +
          esc(nestLabel(nest)) + '</span></div>'
        : '') +

      '<div class="row"><span class="k">Goal</span><span class="v">' + sim.goalText(i) + '</span></div>' +
      '<div class="thought">' + sim.thought(i) + '</div>' +

      bar('Health', A.health[i], 100, 'var(--red)') +
      bar('Energy', A.energy[i], C.ENERGY_MAX, 'var(--green)') +
      bar('Hydration', A.hydration[i], C.HYDRATION_MAX, 'var(--blue)') +

      '<div class="row"><span class="k">Carrying</span><span class="v">' +
        AF.CARRY_NAME[A.carry[i]] + '</span></div>' +
      '<div class="row"><span class="k">Age</span><span class="v">' +
        lifeText(A.age[i]) + ' of ~' + lifeText(A.life[i]) + '</span></div>' +
      '<div class="bar"><i style="width:' + lifePct + '%;background:#7b8aa5"></i></div>' +
      '<div class="row"><span class="k">Position</span><span class="v">' +
        A.x[i].toFixed(0) + ', ' + A.y[i].toFixed(0) +
        (depth > 0.5 ? ' &middot; ' + depth.toFixed(0) + ' deep' : ' &middot; surface') + '</span></div>';

    html += '<h2 style="margin-top:14px">Work done</h2>';
    if (caste === CASTE.FORAGER) html += '<div class="row"><span class="k">Loads delivered</span><span class="v">' + A.sFood[i] + '</span></div>';
    if (caste === CASTE.DIGGER) html += '<div class="row"><span class="k">Soil removed</span><span class="v">' + A.sDirt[i] + '</span></div>';
    if (caste === CASTE.NURSE) html += '<div class="row"><span class="k">Larvae fed</span><span class="v">' + A.sFed[i] + '</span></div>';
    if (caste === CASTE.SOLDIER) html += '<div class="row"><span class="k">Bites landed</span><span class="v">' + A.sHits[i] + '</span></div>';
    if (caste === CASTE.QUEEN) html += '<div class="row"><span class="k">Eggs laid</span><span class="v">' + nest.stats.eggsLaid + '</span></div>';
    html += '<div class="row"><span class="k">Distance walked</span><span class="v">' + A.sDist[i].toFixed(0) + ' tiles</span></div>' +
      '<div class="row"><span class="k">Pool slot</span><span class="v">#' + i + ' &middot; use ' + A.gen[i] + '</span></div>';

    const log = col.recentLog(i);
    if (log.length) {
      html += '<h2 style="margin-top:14px">Recent</h2><ul class="log">';
      for (const e of log) {
        html += '<li><b>' + AF.EV[e.code] + '</b> &middot; ' + ago(e.t) + '</li>';
      }
      html += '</ul>';
    }

    card.innerHTML = html;
  }
})();
