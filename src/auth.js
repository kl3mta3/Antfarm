// Keeper sign-in.
//
// The credentials live on the server and are never shipped here; this module
// only holds a token. Viewing the farm needs no account — the gate is on the
// controls that change it.
(function () {
  const AF = window.AF;
  const KEY = 'antfarm.token';

  const auth = {
    signedIn: false,
    user: null,
    checking: true,
    onChange: null,      // set by the UI
  };
  AF.auth = auth;

  function token() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); }
    catch (e) { /* storage blocked; session lasts this page only */ }
  }

  function announce() { if (auth.onChange) auth.onChange(); }

  auth.headers = function () {
    const t = token();
    return t ? { Authorization: 'Bearer ' + t } : {};
  };

  // Ask the server whether the stored token is still good.
  auth.refresh = async function () {
    auth.checking = true;
    try {
      const res = await fetch('/api/session', { headers: auth.headers() });
      const data = await res.json();
      auth.signedIn = !!data.signedIn;
      auth.user = data.user || null;
      if (!auth.signedIn) setToken('');
    } catch (e) {
      auth.signedIn = false;      // server unreachable: stay locked
      auth.user = null;
    }
    auth.checking = false;
    announce();
    return auth.signedIn;
  };

  auth.signIn = async function (user, password) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || 'Sign in failed.' };
      setToken(data.token);
      auth.signedIn = true;
      auth.user = data.user;
      announce();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Could not reach the server.' };
    }
  };

  auth.signOut = async function () {
    try {
      await fetch('/api/logout', { method: 'POST', headers: auth.headers() });
    } catch (e) { /* signing out locally regardless */ }
    setToken('');
    auth.signedIn = false;
    auth.user = null;
    announce();
  };
})();
