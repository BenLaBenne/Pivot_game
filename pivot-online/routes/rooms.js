// routes/rooms.js — Salons privés : créer / rejoindre / lister
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');

const router = express.Router();

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// POST /api/rooms/create — crée un salon privé et renvoie le code
router.post('/create', authMiddleware, async (req, res) => {
  const code = genCode();
  try {
    await pool.query(
      `INSERT INTO private_rooms (code, host_id, status) VALUES ($1, $2, 'waiting')`,
      [code, req.user.id]
    );
    res.json({ ok: true, code, link: `/room/${code}` });
  } catch (e) {
    console.error('[rooms] create:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/rooms/join — rejoindre un salon par code
// body: { code: 'XXXXXX' }
router.post('/join', authMiddleware, async (req, res) => {
  const code = (req.body && req.body.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Code invalide.' });
  const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Salon introuvable.' });
  const room = r.rows[0];
  if (room.status === 'finished') return res.status(400).json({ error: 'Salon terminé.' });
  if (room.host_id === req.user.id) return res.json({ ok: true, code, host: true });
  // Vérifier qu'il n'y a pas déjà un adversaire
  // On accepte : si le salon est "waiting", le 2e joueur rejoint.
  res.json({ ok: true, code, host: false });
});

// POST /api/rooms/leave — quitte un salon (l'host quitte = salon supprimé)
// body: { code }
router.post('/leave', authMiddleware, async (req, res) => {
  const code = (req.body && req.body.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Code invalide.' });
  const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Salon introuvable.' });
  const room = r.rows[0];
  if (room.host_id === req.user.id) {
    // L'host quitte → supprimer le salon
    await pool.query(`DELETE FROM private_rooms WHERE code = $1`, [code]);
    return res.json({ ok: true, closed: true });
  }
  // L'invité quitte → revenir en 'waiting'
  await pool.query(`UPDATE private_rooms SET status = 'waiting' WHERE code = $1`, [code]);
  res.json({ ok: true, closed: false });
});

// DELETE /api/rooms/:code — supprime un salon (host uniquement)
router.delete('/:code', authMiddleware, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Salon introuvable.' });
  if (r.rows[0].host_id !== req.user.id) return res.status(403).json({ error: 'Seul l\'hôte peut supprimer le salon.' });
  await pool.query(`DELETE FROM private_rooms WHERE code = $1`, [code]);
  res.json({ ok: true });
});

// GET /api/rooms/:code — état d'un salon
router.get('/:code', authMiddleware, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Salon introuvable.' });
  const room = r.rows[0];
  const host = await pool.query('SELECT pseudo FROM users WHERE id = $1', [room.host_id]);
  res.json({
    code: room.code,
    status: room.status,
    hostPseudo: host.rows[0] ? host.rows[0].pseudo : null,
    isHost: room.host_id === req.user.id
  });
});

module.exports = router;
