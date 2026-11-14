// seasons.js — Gestion des saisons mensuelles
//
// Une saison dure 1 mois calendaire (du 1er au dernier jour du mois, en UTC).
// À la fin de la saison, les TR de tous les joueurs sont réinitialisés à 0
// (retour à Plastique 1), et le pass_xp/pass_level sont reset.
// Un snapshot des progressions est sauvegardé dans user_season_history.

const { pool } = require('./db');

// Calcule le début et la fin de la saison pour une date donnée
function seasonRange(date) {
  const now = date instanceof Date ? date : new Date(date);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function seasonName(date) {
  const now = date instanceof Date ? date : new Date(date);
  return `Saison ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Retourne la saison actuelle (la crée + reset TR si elle n'existe pas encore)
// Idempotent : si la saison existe déjà dans la DB, on ne reset rien.
async function getCurrentSeason() {
  const now = new Date();
  const { start, end } = seasonRange(now);
  const name = seasonName(now);

  // Chercher la saison actuelle (par name = unique)
  let r = await pool.query(`SELECT * FROM seasons WHERE name = $1`, [name]);
  if (r.rowCount > 0) return r.rows[0];

  // Créer la nouvelle saison (atomic — gère les appels concurrents)
  // INSERT ... ON CONFLICT DO NOTHING pour éviter les doublons en cas de race
  const ins = await pool.query(
    `INSERT INTO seasons (name, start_date, end_date) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO NOTHING RETURNING *`,
    [name, start, end]
  );

  // Si ins.rowCount === 0, quelqu'un d'autre a créé la saison entre-temps
  let saison;
  let nouvelleSaison = false;
  if (ins.rowCount > 0) {
    saison = ins.rows[0];
    nouvelleSaison = true;
  } else {
    const r2 = await pool.query(`SELECT * FROM seasons WHERE name = $1`, [name]);
    saison = r2.rows[0];
  }

  if (nouvelleSaison) {
    // ===== Nouvelle saison : snapshot + reset =====
    console.log(`[season] Nouvelle saison créée : ${name}. Reset des TR et pass...`);
    try {
      // 1. Snapshot de la saison précédente (la plus récente avant celle-ci)
      const prevSeason = await pool.query(
        `SELECT id FROM seasons WHERE id <> $1 ORDER BY end_date DESC LIMIT 1`,
        [saison.id]
      );
      if (prevSeason.rowCount > 0) {
        const prevId = prevSeason.rows[0].id;
        await pool.query(
          `INSERT INTO user_season_history (user_id, season_id, final_xp, final_level, final_trophies)
           SELECT id, $1, pass_xp, pass_level, trophies FROM users
           WHERE pass_xp > 0 OR pass_level > 0 OR trophies > 0
           ON CONFLICT (user_id, season_id) DO UPDATE SET
             final_xp = EXCLUDED.final_xp,
             final_level = EXCLUDED.final_level,
             final_trophies = EXCLUDED.final_trophies`,
          [prevId]
        );
        console.log(`[season] Snapshot de la saison #${prevId} sauvegardé.`);
      }
      // 2. Reset TR et pass pour tous les utilisateurs
      await pool.query(`UPDATE users SET trophies = 0, pass_xp = 0, pass_level = 0`);
      console.log(`[season] Tous les comptes sont retournés à Plastique 1 (TR=0, pass=0).`);
    } catch (e) {
      console.error('[season] Erreur lors du reset:', e.message);
    }
  }

  return saison;
}

// Vérifie s'il faut changer de saison — à appeler périodiquement
async function checkSeason() {
  return await getCurrentSeason();
}

// Récupère le snapshot d'une saison passée pour un user (ou null)
async function getUserSeasonHistory(userId, seasonId) {
  const r = await pool.query(
    `SELECT * FROM user_season_history WHERE user_id = $1 AND season_id = $2`,
    [userId, seasonId]
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

// Liste les saisons passées (pour l'historique d'un user)
async function getUserSeasonHistoryAll(userId) {
  const r = await pool.query(
    `SELECT h.season_id, h.final_xp, h.final_level, h.final_trophies, s.name, s.start_date, s.end_date
     FROM user_season_history h
     JOIN seasons s ON s.id = h.season_id
     WHERE h.user_id = $1
     ORDER BY s.start_date DESC`,
    [userId]
  );
  return r.rows;
}

module.exports = {
  seasonRange, seasonName, getCurrentSeason, checkSeason,
  getUserSeasonHistory, getUserSeasonHistoryAll
};
