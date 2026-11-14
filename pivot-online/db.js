
// db.js — Pool PostgreSQL partagé par toute l'app
const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL est absente !');
}

const dbUrl = new URL(process.env.DATABASE_URL);

console.log('[db] Configuration PostgreSQL :', {
  host: dbUrl.hostname,
  port: dbUrl.port || '5432',
  database: dbUrl.pathname.slice(1),
  ssl: process.env.DATABASE_SSL === 'false' ? false : true
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('[db] Erreur PostgreSQL :', err.message);
});

async function query(text, params) {
  if (process.env.NODE_ENV !== 'production') {
    const first = text.trim().split(/\s+/)[0].toUpperCase();
  }
  return pool.query(text, params);
}

module.exports = { pool, query };
