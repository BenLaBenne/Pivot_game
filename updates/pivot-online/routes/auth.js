// routes/auth.js — Inscription + connexion + JWT
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();
const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '7d';

function makeToken(user) {
  return jwt.sign({ id: user.id, pseudo: user.pseudo }, JWT_SECRET(), { expiresIn: TOKEN_TTL });
}

// Middleware d'authentification : vérifie le Bearer token.
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Token manquant.' });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET());
    req.user = { id: payload.id, pseudo: payload.pseudo };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré.' });
  }
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { pseudo, password } = req.body || {};
    if (!pseudo || typeof pseudo !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(pseudo))
      return res.status(400).json({ error: 'Pseudo invalide (3-32 caractères alphanumériques).' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Mot de passe minimum 6 caractères.' });

    const exists = await pool.query('SELECT id FROM users WHERE pseudo = $1', [pseudo]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'Pseudo déjà pris.' });

    const hash = await bcrypt.hash(password, 10);
    const ins = await pool.query(
      `INSERT INTO users (pseudo, password_hash) VALUES ($1, $2) RETURNING id, pseudo, elo, trophies, pc_balance, win_streak`,
      [pseudo, hash]
    );
    const user = ins.rows[0];

    // Inventaire par défaut : 1 pivot gratuit à l'inscription
    await pool.query(
      `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, 'pivot', 1)
       ON CONFLICT (user_id, ability_type) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [user.id]
    );

    const token = makeToken(user);
    res.json({ token, user: { ...user, elo: user.elo, trophies: user.trophies, pc: user.pc_balance } });
  } catch (e) {
    console.error('[auth] signup:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { pseudo, password } = req.body || {};
    if (!pseudo || !password) return res.status(400).json({ error: 'Pseudo et mot de passe requis.' });
    const r = await pool.query('SELECT * FROM users WHERE pseudo = $1', [pseudo]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
    const user = r.rows[0];
    if (user.banned) {
      const reason = user.banned_reason || 'Aucune raison fournie.';
      return res.status(403).json({ error: 'Ce compte est banni. Raison : ' + reason });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
    const token = makeToken(user);
    res.json({ token, user: { id: user.id, pseudo: user.pseudo, elo: user.elo, trophies: user.trophies, pc: user.pc_balance, is_admin: user.is_admin } });
  } catch (e) {
    console.error('[auth] login:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/auth/me — renvoie le profil complet de l'utilisateur connecté
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, pseudo, elo, trophies, pc_balance, win_streak, matches_played, matches_won, matches_lost, is_admin, banned
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const u = r.rows[0];
    if (u.banned) return res.status(403).json({ error: 'Votre compte est banni.' });
    const inv = await pool.query(
      `SELECT ability_type, quantity FROM user_inventory WHERE user_id = $1`,
      [req.user.id]
    );
    const inventaire = { tp: 0, diagonale: 0, pivot: 0 };
    for (const row of inv.rows) inventaire[row.ability_type] = row.quantity;

    const coffres = await pool.query(
      `SELECT id, chest_level, status FROM user_chests WHERE user_id = $1 AND status = 'unopened' ORDER BY id`,
      [req.user.id]
    );

    res.json({
      user: {
        id: u.id, pseudo: u.pseudo, elo: u.elo, trophies: u.trophies,
        pc: u.pc_balance, win_streak: u.win_streak,
        matches_played: u.matches_played, matches_won: u.matches_won, matches_lost: u.matches_lost,
        is_admin: u.is_admin,
        inventaire, coffres: coffres.rows
      }
    });
  } catch (e) {
    console.error('[auth] me:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = { router, authMiddleware, makeToken };
