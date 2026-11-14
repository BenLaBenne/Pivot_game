// routes/leaderboard.js — Classement public par TR
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/leaderboard?tier=Plastique&sort=tr&page=1
// tier : 'all' (défaut) ou nom d'un tier
// sort : 'tr' (défaut), 'matches', 'winrate'
// page : 1-based
router.get('/', async (req, res) => {
  const tier = req.query.tier || 'all';
  const sort = req.query.sort || 'tr';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  // Le "tier" correspond au nom de tier : Plastique, Bronze, Argent, Fer, Or, Legendary
  // Pour filtrer, on compare les seuils de TR. On utilise les rangs définis dans ranks.js.
  const { RANKS } = require('../ranks');
  let trMin = -1, trMax = 999999;
  if (tier !== 'all') {
    const rangsTier = RANKS.filter(r => r.nom.startsWith(tier));
    if (rangsTier.length === 0) return res.status(400).json({ error: 'Tier inconnu.' });
    trMin = rangsTier[0].tr;
    // Le max est le seuil du tier suivant moins 1, ou l'infini pour Legendary
    const lastTr = rangsTier[rangsTier.length - 1].tr;
    const idx = RANKS.findIndex(r => r.tr === lastTr);
    if (idx + 1 < RANKS.length) trMax = RANKS[idx + 1].tr - 1;
    else trMax = 999999;
  }

  let orderBy = 'trophies DESC';
  if (sort === 'matches') orderBy = 'matches_played DESC';
  else if (sort === 'winrate') orderBy = '(CASE WHEN matches_played > 0 THEN matches_won::float / matches_played ELSE 0 END) DESC, trophies DESC';

  const params = [];
  let where = '';
  if (tier !== 'all') {
    params.push(trMin, trMax);
    where = `WHERE trophies >= $1 AND trophies <= $2`;
  }
  params.push(limit, offset);

  const countSql = `SELECT COUNT(*)::int AS n FROM users ${where}`;
  const dataSql = `SELECT id, pseudo, elo, trophies, matches_played, matches_won, matches_lost
                   FROM users ${where}
                   ORDER BY ${orderBy}
                   LIMIT $${params.length - 1} OFFSET $${params.length}`;

  try {
    const countR = await pool.query(countSql, params.slice(0, params.length - 2));
    const total = countR.rows[0].n;
    const r = await pool.query(dataSql, params);
    res.json({
      joueurs: r.rows,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (e) {
    console.error('[leaderboard] error:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/leaderboard/user/:pseudo — profil public d'un joueur
router.get('/user/:pseudo', async (req, res) => {
  const pseudo = req.params.pseudo;
  const r = await pool.query(
    `SELECT id, pseudo, elo, trophies, pc_balance, win_streak, best_streak,
            matches_played, matches_won, matches_lost, created_at
     FROM users WHERE pseudo = $1`,
    [pseudo]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Joueur introuvable.' });
  const u = r.rows[0];
  const inv = await pool.query(
    `SELECT ability_type, quantity FROM user_inventory WHERE user_id = $1`,
    [u.id]
  );
  const inventaire = { tp: 0, diagonale: 0, pivot: 0 };
  for (const row of inv.rows) inventaire[row.ability_type] = row.quantity;

  // Derniers matchs
  const derniers = await pool.query(
    `SELECT m.id, m.match_type, m.status, m.winner_id,
            u1.pseudo AS p1, u2.pseudo AS p2,
            m.elo_change, m.pc_earned, m.tr_earned, m.finished_at
     FROM matches m
     LEFT JOIN users u1 ON u1.id = m.player1_id
     LEFT JOIN users u2 ON u2.id = m.player2_id
     WHERE m.player1_id = $1 OR m.player2_id = $1
     ORDER BY m.finished_at DESC NULLS LAST
     LIMIT 10`,
    [u.id]
  );

  res.json({
    user: u,
    inventaire,
    derniersMatchs: derniers.rows
  });
});

module.exports = router;
