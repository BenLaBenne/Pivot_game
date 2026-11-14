// routes/tournaments.js — Tournois : créer / rejoindre / lister / lancer
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

// GET /api/tournaments — liste des tournois publics en attente
router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT t.id, t.name, t.status, t.is_private, t.max_players, t.created_at,
            u.pseudo AS creator_pseudo,
            (SELECT COUNT(*) FROM tournament_players WHERE tournament_id = t.id) AS nb_inscrits
     FROM tournaments t LEFT JOIN users u ON u.id = t.creator_id
     WHERE t.status = 'waiting' AND t.is_private = FALSE
     ORDER BY t.created_at DESC`
  );
  res.json({ tournois: r.rows });
});

// POST /api/tournaments — créer un tournoi
// body: { name, isPrivate }
router.post('/', authMiddleware, async (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name || name.length < 3 || name.length > 64)
    return res.status(400).json({ error: 'Nom de tournoi invalide (3-64 caractères).' });
  const isPrivate = !!req.body.isPrivate;
  const code = isPrivate ? genCode() : null;
  try {
    const ins = await pool.query(
      `INSERT INTO tournaments (name, creator_id, status, is_private, code)
       VALUES ($1, $2, 'waiting', $3, $4) RETURNING id, name, is_private, code`,
      [name, req.user.id, isPrivate, code]
    );
    const t = ins.rows[0];
    // Le créateur est automatiquement inscrit
    await pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [t.id, req.user.id]
    );
    res.json({ ok: true, tournoi: t });
  } catch (e) {
    console.error('[tournaments] create:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/tournaments/:id — détail d'un tournoi
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Tournoi introuvable.' });
  const t = r.rows[0];
  const inscrits = await pool.query(
    `SELECT u.id, u.pseudo, u.elo, u.trophies, tp.eliminated, tp.round_reached
     FROM tournament_players tp JOIN users u ON u.id = tp.user_id
     WHERE tp.tournament_id = $1 ORDER BY u.elo DESC`,
    [id]
  );
  res.json({ tournoi: t, inscrits: inscrits.rows });
});

// POST /api/tournaments/:id/join — rejoindre un tournoi
router.post('/:id/join', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Tournoi introuvable.' });
  const t = r.rows[0];
  if (t.status !== 'waiting') return res.status(400).json({ error: 'Tournoi déjà lancé ou terminé.' });
  // Vérifier code si privé
  if (t.is_private) {
    const code = (req.body && req.body.code || '').toUpperCase();
    if (code !== t.code) return res.status(403).json({ error: 'Code du tournoi privé incorrect.' });
  }
  // Vérifier capacité
  const nb = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tournament_players WHERE tournament_id = $1`,
    [id]
  );
  if (nb.rows[0].n >= t.max_players) return res.status(400).json({ error: 'Tournoi plein.' });
  // Inscrire
  try {
    await pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[tournaments] join:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/tournaments/:id/start — lance le tournoi (créateur uniquement, min 3 inscrits)
router.post('/:id/start', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Tournoi introuvable.' });
  const t = r.rows[0];
  if (t.creator_id !== req.user.id) return res.status(403).json({ error: 'Seul le créateur peut lancer le tournoi.' });
  if (t.status !== 'waiting') return res.status(400).json({ error: 'Tournoi déjà lancé ou terminé.' });
  const ins = await pool.query(
    `SELECT user_id FROM tournament_players WHERE tournament_id = $1 ORDER BY user_id`,
    [id]
  );
  if (ins.rowCount < 3) return res.status(400).json({ error: 'Minimum 3 joueurs pour lancer.' });
  if (ins.rowCount > t.max_players) return res.status(400).json({ error: 'Trop de joueurs.' });

  // Construire le bracket : on prend la puissance de 2 supérieure, on attribue des "byes"
  const joueurs = ins.rows.map((r) => r.user_id);
  // Compléter à la puissance de 2 avec des "byes" (null)
  let n = 1;
  while (n < joueurs.length) n *= 2;
  while (joueurs.length < n) joueurs.push(null);

  // Mélanger (bracket aléatoire équitable)
  for (let i = joueurs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [joueurs[i], joueurs[j]] = [joueurs[j], joueurs[i]];
  }

  // Créer les matches du premier round
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tournaments SET status = 'running' WHERE id = $1`, [id]);
    const round = 1;
    for (let i = 0; i < joueurs.length; i += 2) {
      const p1 = joueurs[i];
      const p2 = joueurs[i + 1];
      // Si un des deux est un "bye", l'autre passe au tour suivant
      if (p1 === null && p2 === null) continue;
      if (p1 === null) {
        // p2 passe
        await client.query(
          `UPDATE tournament_players SET round_reached = $1 WHERE tournament_id = $2 AND user_id = $3`,
          [round + 1, id, p2]
        );
        continue;
      }
      if (p2 === null) {
        await client.query(
          `UPDATE tournament_players SET round_reached = $1 WHERE tournament_id = $2 AND user_id = $3`,
          [round + 1, id, p1]
        );
        continue;
      }
      // Match à jouer
      await client.query(
        `INSERT INTO tournament_matches (tournament_id, round, match_index, player1_id, player2_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [id, round, Math.floor(i / 2), p1, p2]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, nbJoueurs: joueurs.length, round });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[tournaments] start:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
});

module.exports = router;
