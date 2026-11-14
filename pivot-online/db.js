// db.js — Pool PostgreSQL partagé par toute l'app
const { Pool } = require('pg');
require('dotenv').config();

// render.com: la première connexion à la DB peut être lente (SSL + cold start).
// On met un timeout généreux (30s) pour éviter les erreurs au démarrage.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // render.com (et la plupart des PaaS) exigent SSL sur la DB externe.
  // Si tu es en local sans SSL, mets DATABASE_SSL=false dans ton .env.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000  // 30s — la première connexion peut être lente
});

pool.on('error', (err) => {
  console.error('[db] Erreur PostgreSQL inattendue:', err.message);
});

// Wrapper query qui log en dev
async function query(text, params) {
  if (process.env.NODE_ENV !== 'production') {
    const first = text.trim().split(/\s+/)[0].toUpperCase();
    // console.debug('[db]', first, params ? JSON.stringify(params).slice(0, 80) : '');
  }
  return pool.query(text, params);
}

// Teste la connexion avec retry — utilisé par init-db pour éviter de planter
// au démarrage si la DB n'est pas encore prête.
async function waitForConnection(maxRetries = 5, delayMs = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const c = await pool.connect();
      c.release();
      return true;
    } catch (e) {
      console.warn(`[db] Connexion échouée (essai ${i + 1}/${maxRetries}): ${e.message}`);
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

module.exports = { pool, query, waitForConnection };
