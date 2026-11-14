// routes/pass.js — Routes pour le Pass de Combat
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');
const pass = require('../pass');
const { appliquerRecompense } = require('../ranks');
const { getCurrentSeason, getUserSeasonHistoryAll } = require('../seasons');

const router = express.Router();

// Renvoie l'état du pass avec le statut de chaque niveau (locked / unlocked / claimed)
async function buildPassState(userId) {
  // Vérifier la saison (peut reset TR si nouveau mois)
  const saison = await getCurrentSeason();

  // Charger le pass de l'utilisateur
  const u = await pool.query(
    'SELECT pass_xp, pass_level, pseudo, trophies FROM users WHERE id = $1',
    [userId]
  );
  if (u.rowCount === 0) return null;
  const xp = u.rows[0].pass_xp || 0;
  const level = u.rows[0].pass_level || 0;
  const nextLevelXp = (level + 1) * pass.XP_PER_LEVEL;
  const prevLevelXp = level * pass.XP_PER_LEVEL;
  const xpInCurrentLevel = xp - prevLevelXp;
  const xpForNextLevel = nextLevelXp - prevLevelXp;
  const pct = pass.TOTAL_LEVELS <= level ? 100 : Math.round(100 * xpInCurrentLevel / xpForNextLevel);

  // Charger les récompenses déjà réclamées (pass_claims)
  const claims = await pool.query(
    'SELECT level FROM pass_claims WHERE user_id = $1 AND season_id = $2',
    [userId, saison.id]
  );
  const claimedLevels = new Set(claims.rows.map(r => r.level));

  // Liste toutes les récompenses avec leur statut
  let unclaimedCount = 0;
  const rewardsList = pass.REWARDS.map(r => {
    const isUnlocked = r.level <= level;
    const isClaimed = claimedLevels.has(r.level);
    const isClaimable = isUnlocked && !isClaimed;
    if (isClaimable) unclaimedCount++;
    return {
      level: r.level,
      reward: r,
      icon: pass.rewardIcon(r),
      unlocked: isUnlocked,
      claimed: isClaimed,
      claimable: isClaimable,
      current: r.level === level + 1
    };
  });

  // Jours restants dans la saison
  const now = new Date();
  const endDate = new Date(saison.end_date);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysRemaining = Math.max(0, Math.ceil((endDate - now) / msPerDay));

  return {
    pass: {
      xp,
      level,
      totalLevels: pass.TOTAL_LEVELS,
      xpPerLevel: pass.XP_PER_LEVEL,
      nextLevelXp,
      prevLevelXp,
      xpInCurrentLevel,
      xpForNextLevel,
      pct,
      maxReached: level >= pass.TOTAL_LEVELS,
      unclaimedCount  // nombre de récompenses à réclamer
    },
    season: {
      id: saison.id,
      name: saison.name,
      startDate: saison.start_date,
      endDate: saison.end_date,
      daysRemaining
    },
    rewards: rewardsList,
    unclaimedCount
  };
}

// GET /api/pass — renvoie l'état du pass pour l'utilisateur connecté
router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await buildPassState(req.user.id);
    if (!data) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    // Historique des saisons passées
    let history = [];
    try {
      history = await getUserSeasonHistoryAll(req.user.id);
    } catch (e) { /* ignore */ }
    data.history = history;

    res.json(data);
  } catch (e) {
    console.error('[pass] /:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/pass/season — renvoie juste l'info saison
router.get('/season', authMiddleware, async (req, res) => {
  try {
    const saison = await getCurrentSeason();
    const now = new Date();
    const endDate = new Date(saison.end_date);
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysRemaining = Math.max(0, Math.ceil((endDate - now) / msPerDay));
    res.json({
      id: saison.id,
      name: saison.name,
      startDate: saison.start_date,
      endDate: saison.end_date,
      daysRemaining
    });
  } catch (e) {
    console.error('[pass] /season:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/pass/unclaimed — renvoie juste le nombre de récompenses à réclamer (léger)
router.get('/unclaimed', authMiddleware, async (req, res) => {
  try {
    const data = await buildPassState(req.user.id);
    if (!data) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ unclaimedCount: data.unclaimedCount, level: data.pass.level });
  } catch (e) {
    console.error('[pass] /unclaimed:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/pass/claim — réclame la récompense d'un niveau débloqué
// body: { level: 1..30 }
router.post('/claim', authMiddleware, async (req, res) => {
  try {
    const level = parseInt(req.body && req.body.level, 10);
    if (!level || level < 1 || level > pass.TOTAL_LEVELS) {
      return res.status(400).json({ error: 'Niveau invalide.' });
    }
    const reward = pass.rewardForLevel(level);
    if (!reward) return res.status(400).json({ error: 'Pas de récompense pour ce niveau.' });

    // Charger l'utilisateur
    const u = await pool.query('SELECT pass_level FROM users WHERE id = $1', [req.user.id]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const userLevel = u.rows[0].pass_level || 0;
    if (level > userLevel) {
      return res.status(403).json({ error: 'Niveau pas encore débloqué.' });
    }

    // Vérifier la saison
    const saison = await getCurrentSeason();

    // Tenter d'insérer dans pass_claims (atomic — gère les claims concurrents)
    const ins = await pool.query(
      `INSERT INTO pass_claims (user_id, season_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, season_id, level) DO NOTHING RETURNING level`,
      [req.user.id, saison.id, level]
    );
    if (ins.rowCount === 0) {
      return res.status(409).json({ error: 'Récompense déjà réclamée.', alreadyClaimed: true });
    }

    // Créditer la récompense (PC, capacités, coffre)
    let recap = '';
    try {
      recap = await appliquerRecompense(req.user.id, reward);
    } catch (eR) {
      // Annuler le claim si le crédit échoue
      await pool.query('DELETE FROM pass_claims WHERE user_id = $1 AND season_id = $2 AND level = $3',
        [req.user.id, saison.id, level]);
      console.error('[pass] claim crédit erreur:', eR.message);
      return res.status(500).json({ error: 'Erreur lors du crédit de la récompense.' });
    }

    console.log(`[pass] User ${req.user.id} a réclamé le niveau ${level}: ${recap}`);
    res.json({ ok: true, level, recap, reward: reward });
  } catch (e) {
    console.error('[pass] /claim:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/pass/claim-all — réclame toutes les récompenses débloquées non réclamées d'un coup
router.post('/claim-all', authMiddleware, async (req, res) => {
  try {
    const data = await buildPassState(req.user.id);
    if (!data) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const toClaim = data.rewards.filter(r => r.claimable);
    if (toClaim.length === 0) {
      return res.json({ ok: true, claimed: 0, recaps: [] });
    }

    const recaps = [];
    for (const rw of toClaim) {
      try {
        const ins = await pool.query(
          `INSERT INTO pass_claims (user_id, season_id, level) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, season_id, level) DO NOTHING RETURNING level`,
          [req.user.id, data.season.id, rw.level]
        );
        if (ins.rowCount > 0) {
          const recap = await appliquerRecompense(req.user.id, rw.reward);
          recaps.push({ level: rw.level, recap });
          console.log(`[pass] claim-all: User ${req.user.id} niveau ${rw.level}: ${recap}`);
        }
      } catch (eR) {
        console.error(`[pass] claim-all niveau ${rw.level}:`, eR.message);
      }
    }
    res.json({ ok: true, claimed: recaps.length, recaps });
  } catch (e) {
    console.error('[pass] /claim-all:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/pass/config — configuration publique du pass (récompenses par niveau)
router.get('/config', (req, res) => {
  res.json({
    totalLevels: pass.TOTAL_LEVELS,
    xpPerLevel: pass.XP_PER_LEVEL,
    xpPerWin: pass.XP_PER_WIN,
    xpPerLoss: pass.XP_PER_LOSS,
    xpPerMove: pass.XP_PER_MOVE,
    rewards: pass.REWARDS
  });
});

module.exports = router;
