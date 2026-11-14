// routes/pass.js — Routes pour le Pass de Combat
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');
const pass = require('../pass');
const { getCurrentSeason, getUserSeasonHistoryAll } = require('../seasons');

const router = express.Router();

// GET /api/pass — renvoie l'état du pass pour l'utilisateur connecté
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Vérifier la saison (peut reset TR si nouveau mois)
    const saison = await getCurrentSeason();

    // Charger le pass de l'utilisateur
    const u = await pool.query(
      'SELECT pass_xp, pass_level, pseudo, trophies FROM users WHERE id = $1',
      [req.user.id]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const xp = u.rows[0].pass_xp || 0;
    const level = u.rows[0].pass_level || 0;
    const nextLevelXp = (level + 1) * pass.XP_PER_LEVEL;
    const prevLevelXp = level * pass.XP_PER_LEVEL;
    const xpInCurrentLevel = xp - prevLevelXp;
    const xpForNextLevel = nextLevelXp - prevLevelXp;
    const pct = pass.TOTAL_LEVELS <= level ? 100 : Math.round(100 * xpInCurrentLevel / xpForNextLevel);

    // Jours restants dans la saison
    const now = new Date();
    const endDate = new Date(saison.end_date);
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysRemaining = Math.max(0, Math.ceil((endDate - now) / msPerDay));

    // Liste toutes les récompenses avec leur statut (locked / unlocked / claimed)
    const rewardsList = pass.REWARDS.map(r => {
      const isUnlocked = r.level <= level;
      // Comme on auto-claim, "unlocked" = "claimed"
      return {
        level: r.level,
        reward: r,
        icon: pass.rewardIcon(r),
        unlocked: isUnlocked,
        claimed: isUnlocked,
        current: r.level === level + 1  // prochain niveau à atteindre
      };
    });

    // Historique des saisons passées
    let history = [];
    try {
      history = await getUserSeasonHistoryAll(req.user.id);
    } catch (e) { /* ignore */ }

    res.json({
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
        maxReached: level >= pass.TOTAL_LEVELS
      },
      season: {
        id: saison.id,
        name: saison.name,
        startDate: saison.start_date,
        endDate: saison.end_date,
        daysRemaining
      },
      rewards: rewardsList,
      history
    });
  } catch (e) {
    console.error('[pass] /:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/season — renvoie juste l'info saison (plus léger)
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

// GET /api/pass/config — configuration publique du pass (récompenses par niveau)
// Pas d'auth requise — permet d'afficher le pass sans être connecté
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
