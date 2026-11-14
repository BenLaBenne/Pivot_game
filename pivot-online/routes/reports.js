// routes/reports.js — Signalements (côté joueur)
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');

const router = express.Router();

// Raisons acceptées pour un signalement
const RAISONS = [
  'triche',
  'comportement_toxique',
  'pseudo_inapproprie',
  'spam',
  'autre'
];

// POST /api/reports — crée un signalement
// body: { reportedId: int, reason: string, details?: string }
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { reportedId, reason, details } = req.body || {};
    if (!reportedId) return res.status(400).json({ error: 'reportedId requis.' });
    if (!RAISONS.includes(reason)) return res.status(400).json({ error: 'Raison invalide.' });
    const rid = parseInt(reportedId, 10);
    if (rid === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas te signaler toi-même.' });
    const u = await pool.query('SELECT id FROM users WHERE id = $1', [rid]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Joueur signalé introuvable.' });
    // Anti-spam: max 3 signalements par 10 minutes du même reporteur
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM reports
       WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
      [req.user.id]
    );
    if (recent.rows[0].n >= 3) return res.status(429).json({ error: 'Trop de signalements récents, patiente.' });
    // Dédoublonnage: ne pas recréer un signalement pour le même joueur si un est encore ouvert
    const exist = await pool.query(
      `SELECT id FROM reports WHERE reporter_id = $1 AND reported_id = $2 AND status = 'open'`,
      [req.user.id, rid]
    );
    if (exist.rowCount > 0) return res.status(409).json({ error: 'Tu as déjà un signalement en cours pour ce joueur.' });
    await pool.query(
      `INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)`,
      [req.user.id, rid, reason, (details || '').slice(0, 1000)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[reports] create:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/reports/reasons — liste des raisons possibles
router.get('/reasons', (req, res) => {
  res.json({ reasons: RAISONS });
});

module.exports = router;
