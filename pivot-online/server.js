// server.js — Point d'entrée: Express + Socket.io + init DB (en arrière-plan)
//
// IMPORTANT pour render.com : le serveur bind le port IMMÉDIATEMENT, puis lance
// init-db en arrière-plan. Render.com a un timeout de 60s pour détecter un port
// ouvert, et init-db peut prendre 30-60s sur une DB externe (SSL + schéma).
// Les routes DB renvoient 503 tant que init-db n'est pas terminé.

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { pool } = require('./db');
const { initDb } = require('./init-db');
const gameSocket = require('./sockets/game-socket');

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6
});

app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));

// État global: la DB est-elle prête ?
let dbReady = false;
let dbError = null;

// Middleware: bloquer les routes DB tant que init-db n'est pas fini
app.use('/api', (req, res, next) => {
  // /api/health est toujours autorisé (render.com l'appelle pour le health check)
  if (req.path === '/health') return next();
  if (!dbReady) {
    return res.status(503).json({
      error: 'Le serveur démarre (initialisation de la base de données). Réessaie dans quelques secondes.',
      dbReady: false,
      dbError: dbError ? 'Erreur: ' + dbError : null
    });
  }
  next();
});

// Servir les pages statiques
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
const authRoutes = require('./routes/auth');
const shopRoutes = require('./routes/shop');
const roomsRoutes = require('./routes/rooms');
const tournamentsRoutes = require('./routes/tournaments');
const leaderboardRoutes = require('./routes/leaderboard');
const adminRoutes = require('./routes/admin');
const reportsRoutes = require('./routes/reports');

app.use('/api/auth', authRoutes.router);
app.use('/api/shop', shopRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/tournaments', tournamentsRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportsRoutes);

// Health check pour render.com — toujours OK, même avant init-db
app.get('/api/health', (req, res) => res.json({
  ok: true,
  ts: Date.now(),
  dbReady,
  dbError: dbError ? 'Erreur: ' + dbError : null
}));

// Redirections pratiques vers les pages HTML
const pagesMap = {
  '/': 'index.html',
  '/login': 'login.html',
  '/signup': 'signup.html',
  '/play': 'play.html',
  '/shop': 'shop.html',
  '/leaderboard': 'leaderboard.html',
  '/tournaments': 'tournaments.html',
  '/profile': 'profile.html',
  '/admin': 'admin.html'
};
for (const [path_, file] of Object.entries(pagesMap)) {
  app.get(path_, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}
// Routes paramétrées
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.get('/tournament/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tournament.html')));
app.get('/profile/:pseudo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// Fallback 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route API inconnue.' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Démarrage =====
const PORT = process.env.PORT || 3000;

// 1. Binder le port IMMÉDIATEMENT (render.com a 60s pour détecter un port ouvert)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] PIVOT Online en écoute sur le port ${PORT}`);
  console.log('[server] La base de données est en cours d\'initialisation en arrière-plan...');
});

// 2. Lancer init-db en arrière-plan (non bloquant)
(async function initInBackground() {
  const t0 = Date.now();
  try {
    await initDb();
    dbReady = true;
    console.log(`[server] Base de données prête en ${Date.now() - t0}ms.`);
    // Enregistrer le socket une fois la DB prête
    gameSocket.register(io);
    console.log('[server] Socket.io enregistré. Le serveur est pleinement opérationnel.');
  } catch (e) {
    dbError = e.message || String(e);
    console.error('[server] Erreur init-db:', dbError);
    // On ne quitte pas : le health check renverra dbError pour debug.
    // Les routes DB renverront 503 avec le message d'erreur.
    // Retry automatique dans 30s
    setTimeout(initInBackground, 30000);
  }
})();

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM reçu, arrêt en cours...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('[server] SIGINT reçu, arrêt en cours...');
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});
