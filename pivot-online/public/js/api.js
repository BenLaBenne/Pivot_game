// public/js/api.js — utilitaire client pour appeler l'API REST + WebSocket.
window.PIVOT = window.PIVOT || {};

PIVOT.getToken = function() { return localStorage.getItem('pivot_token'); };
PIVOT.setToken = function(t) { localStorage.setItem('pivot_token', t); };
PIVOT.clearToken = function() { localStorage.removeItem('pivot_token'); };

PIVOT.getUser = function() {
  try { return JSON.parse(localStorage.getItem('pivot_user') || 'null'); }
  catch (e) { return null; }
};
PIVOT.setUser = function(u) { localStorage.setItem('pivot_user', JSON.stringify(u)); };

PIVOT.isLoggedIn = function() { return !!PIVOT.getToken(); };

// Appel API générique
PIVOT.api = async function(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const t = PIVOT.getToken();
  if (t) opts.headers['Authorization'] = 'Bearer ' + t;
  const res = await fetch('/api' + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
};

PIVOT.toast = function(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind === 'error' ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
};

PIVOT.redirectIfLoggedOut = function() {
  if (!PIVOT.isLoggedIn()) {
    window.location.href = '/login';
    return true;
  }
  return false;
};

// Récupère le profil complet de l'utilisateur connecté (pour le dashboard)
PIVOT.fetchMe = async function() {
  return await PIVOT.api('GET', '/auth/me');
};

// Socket.io: connecte et renvoie le socket
PIVOT.connectSocket = function() {
  const token = PIVOT.getToken();
  if (!token) return null;
  if (PIVOT._socket) return PIVOT._socket;
  PIVOT._socket = io({ auth: { token } });
  return PIVOT._socket;
};
