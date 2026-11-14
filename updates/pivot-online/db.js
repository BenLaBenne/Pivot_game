// db.js — Pool PostgreSQL partagé par toute l'app
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // render.com (et la plupart des PaaS) exigent SSL sur la DB externe
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[db]Erreur PostgreSQL inattendue:', err.message);
});

// Wrapper query qui log en dev
async function query(text, params) {
  if (process.env.NODE_ENV !== 'production') {
    // Log léger en dev (juste le premier mot de la requête)
    const first = text.trim().split(/\s+/)[0].toUpperCase();
    // console.debug('[db]', first, params ? JSON.stringify(params).slice(0, 80) : '');
  }
  return pool.query(text, params);
}

module.exports = { pool, query };
