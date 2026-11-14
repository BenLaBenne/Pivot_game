// init-db.js — Création automatique de toutes les tables au démarrage.
// Peut être lancé seul: `npm run init-db` ou automatiquement par server.js.
const { pool, waitForConnection } = require('./db');

const SCHEMA = `
-- ===== Users =====
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  pseudo VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  elo INTEGER DEFAULT 1000,
  trophies INTEGER DEFAULT 0,
  pc_balance INTEGER DEFAULT 0,
  win_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  matches_played INTEGER DEFAULT 0,
  matches_won INTEGER DEFAULT 0,
  matches_lost INTEGER DEFAULT 0,
  is_admin BOOLEAN DEFAULT FALSE,
  banned BOOLEAN DEFAULT FALSE,
  banned_reason TEXT,
  banned_at TIMESTAMP,
  admin_level INTEGER DEFAULT 0,  -- 0 = user, 1 = modo, 2 = admin principal
  pass_xp INTEGER DEFAULT 0,      -- XP accumulée pour le Pass de Combat
  pass_level INTEGER DEFAULT 0,  -- Niveau actuel du Pass (0 à 30)
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_pseudo ON users(pseudo);
CREATE INDEX IF NOT EXISTS idx_users_trophies ON users(trophies DESC);
CREATE INDEX IF NOT EXISTS idx_users_elo ON users(elo);
CREATE INDEX IF NOT EXISTS idx_users_banned ON users(banned);

-- ===== Signalements =====
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(255) NOT NULL,
  details TEXT,
  status VARCHAR(16) DEFAULT 'open',  -- 'open', 'resolved', 'dismissed'
  admin_id INTEGER REFERENCES users(id),
  admin_note TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);

-- ===== Logs admin =====
CREATE TABLE IF NOT EXISTS admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id),
  action VARCHAR(64) NOT NULL,  -- 'delete_user', 'ban', 'unban', 'give_item', 'set_admin', 'resolve_report'
  target_id INTEGER,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adminlogs_admin ON admin_logs(admin_id);

-- ===== Inventaire (capacités consommables) =====
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ability_type VARCHAR(16) NOT NULL,  -- 'tp', 'diagonale', 'pivot'
  quantity INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, ability_type)
);

-- ===== Coffres en attente d'ouverture =====
CREATE TABLE IF NOT EXISTS user_chests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  chest_level INTEGER NOT NULL,
  status VARCHAR(16) DEFAULT 'unopened',
  opened_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chests_user ON user_chests(user_id);

-- ===== Matchs =====
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  player1_id INTEGER REFERENCES users(id),
  player2_id INTEGER REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  match_type VARCHAR(16) NOT NULL,  -- 'ranked', 'private', 'tournament'
  status VARCHAR(16) DEFAULT 'playing',
  elo_change INTEGER DEFAULT 0,
  pc_earned INTEGER DEFAULT 0,
  tr_earned INTEGER DEFAULT 0,
  tournament_id INTEGER,
  room_code VARCHAR(6),
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(player2_id);

-- ===== Salons privés =====
CREATE TABLE IF NOT EXISTS private_rooms (
  code VARCHAR(6) PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===== Tournois =====
CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  creator_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'waiting',
  is_private BOOLEAN DEFAULT FALSE,
  code VARCHAR(6),
  max_players INTEGER DEFAULT 20,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  joined_at TIMESTAMP DEFAULT NOW(),
  eliminated BOOLEAN DEFAULT FALSE,
  round_reached INTEGER DEFAULT 0,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  match_index INTEGER NOT NULL,
  player1_id INTEGER REFERENCES users(id),
  player2_id INTEGER REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===== Historique des achats (audit) =====
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  item_type VARCHAR(32) NOT NULL,
  price_pc INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

-- ===== Historique des montées de rank =====
CREATE TABLE IF NOT EXISTS rank_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  old_rank VARCHAR(32),
  new_rank VARCHAR(32),
  reward_pc INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rankhist_user ON rank_history(user_id);

-- ===== Logs d'ouverture de coffres =====
CREATE TABLE IF NOT EXISTS chest_openings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  chest_level INTEGER NOT NULL,
  rewards TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===== Saisons mensuelles (Pass de Combat) =====
-- Une saison dure 1 mois. À la fin de la saison, les TR de tous les joueurs
-- sont réinitialisés à 0 (retour à Plastique 1), et le pass est reset.
CREATE TABLE IF NOT EXISTS seasons (
  id SERIAL PRIMARY KEY,
  name VARCHAR(64) UNIQUE NOT NULL,  -- ex: "Saison 2026-11"
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ===== Historique du pass par saison (snapshot avant reset) =====
CREATE TABLE IF NOT EXISTS user_season_history (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  final_xp INTEGER DEFAULT 0,
  final_level INTEGER DEFAULT 0,
  final_trophies INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, season_id)
);

-- ===== Récompenses de Pass réclamées (claim) =====
-- Quand un joueur atteint un niveau, la récompense est "débloquée" mais
-- pas encore créditée. Le joueur doit cliquer sur la case pour la réclamer.
-- On track ici quelles récompenses ont déjà été réclamées.
CREATE TABLE IF NOT EXISTS pass_claims (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  claimed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, season_id, level)
);
CREATE INDEX IF NOT EXISTS idx_passclaims_user ON pass_claims(user_id);
`;

async function initDb() {
  console.log('[init-db] Création / vérification du schéma...');
  // Attendre que la DB soit prête (retry auto si la DB est encore en cold start)
  const connected = await waitForConnection(5, 2000);
  if (!connected) {
    throw new Error('Impossible de se connecter à la base de données après 5 essais.');
  }
  console.log('[init-db] Connexion DB OK. Création du schéma...');
  await pool.query(SCHEMA);

  // Migrations: ajouter les colonnes manquantes sur une DB existante.
  // On utilise ALTER TABLE ... ADD COLUMN IF NOT EXISTS (PostgreSQL 9.6+)
  // qui est beaucoup plus rapide qu'un DO $$ block avec information_schema.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_level INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pass_xp INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pass_level INTEGER DEFAULT 0;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_id INTEGER;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS room_code VARCHAR(6);
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
    ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_players INTEGER DEFAULT 20;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
    -- Synchroniser is_admin avec admin_level (admin_level >= 1 ⇒ is_admin = TRUE)
    UPDATE users SET is_admin = (admin_level >= 1) WHERE admin_level IS NOT NULL;
  `);
  console.log('[init-db] Schéma OK.');
}

module.exports = { initDb, SCHEMA };

// Si lancé directement: node init-db.js
if (require.main === module) {
  initDb()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[init-db] ERREUR:', err);
      process.exit(1);
    });
}
