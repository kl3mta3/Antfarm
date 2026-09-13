// Keeping the colony between visits.
//
// An ant farm you tend in real time should still be there when you come back,
// with the same tunnels, the same stores and the same individuals — including
// their slot reuse counts.
(function () {
  const AF = window.AF, W = AF.world, col = AF.colony;
  const KEY = 'antfarm.save.v1';

  const persist = { lastSaved: 0, lastError: null };
  AF.persist = persist;

  persist.save = function () {
    try {
      const payload = JSON.stringify({
        v: 2,
        saved: Date.now(),
        world: W.saveState(),
        nests: AF.nests.saveState(),
        colony: col.saveState(),
      });
      localStorage.setItem(KEY, payload);
      persist.lastSaved = Date.now();
      persist.lastError = null;
      return true;
    } catch (e) {
      // Quota exceeded, or storage blocked (private window). Not fatal — the
      // farm keeps running, it just won't survive a refresh.
      persist.lastError = e && e.name ? e.name : 'save failed';
      return false;
    }
  };

  persist.load = function () {
    let raw;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      persist.lastError = 'storage unavailable';
      return false;
    }
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      // Saves from before multiple nests can't be migrated sensibly; start fresh.
      if (!data || data.v !== 2 || !data.world || !data.nests || !data.colony) return false;
      W.loadState(data.world);
      AF.nests.loadState(data.nests);
      col.loadState(data.colony);
      persist.lastSaved = data.saved || 0;
      return true;
    } catch (e) {
      persist.lastError = 'save was unreadable';
      return false;
    }
  };

  persist.clear = function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* nothing to do */ }
  };

  persist.has = function () {
    try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
  };
})();
