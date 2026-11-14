// server.js — Point d'entrée: Express + Socket.io + init DB
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

// Health check pour render.com
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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

// Initialisation DB puis lancement
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDb();
    gameSocket.register(io);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] PIVOT Online en écoute sur le port ${PORT}`);
    });
  } catch (e) {
    console.error('[server] Erreur au démarrage:', e);
    process.exit(1);
  }
}

start();
