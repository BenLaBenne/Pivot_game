-- ============================================================
-- PIVOT Online — Script de migration PostgreSQL autonome
-- ============================================================
-- Ce script crée toutes les tables manquantes ET ajoute toutes les
-- colonnes manquantes sur une base existante. Il est idempotent :
-- il peut être exécuté plusieurs fois sans effet secondaire.
--
-- Usage sur render.com :
--   1. Dashboard render.com → ta DB "pivot-db" → onglet "Shell"
--   2. Copier/coller ce script entier, ou :
--   3. Sauvegarde-le en pivot_migration.sql puis :
--        psql "$DATABASE_URL" -f pivot_migration.sql
--
-- Sur une DB locale :
--   psql -U user -d pivot -f pivot_migration.sql
-- ============================================================

BEGIN;

-- ============================================================
-- 1. Table users (création si inexistante + migrations colonnes)
-- ============================================================
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- Migrations : ajouter les colonnes si la table existait déjà sans elles
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS elo INTEGER DEFAULT 1000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trophies INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pc_balance INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS win_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS best_streak INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_played INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_won INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_lost INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_level INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- Synchroniser is_admin avec admin_level (admin_level >= 1 ⇒ is_admin = TRUE)
UPDATE users SET is_admin = (admin_level >= 1) WHERE admin_level IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_pseudo ON users(pseudo);
CREATE INDEX IF NOT EXISTS idx_users_trophies ON users(trophies DESC);
CREATE INDEX IF NOT EXISTS idx_users_elo ON users(elo);
CREATE INDEX IF NOT EXISTS idx_users_banned ON users(banned);

-- ============================================================
-- 2. Table user_inventory (capacités consommables)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ability_type VARCHAR(16) NOT NULL,  -- 'tp', 'diagonale', 'pivot'
  quantity INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, ability_type)
);

-- ============================================================
-- 3. Table user_chests (coffres en attente d'ouverture)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_chests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  chest_level INTEGER NOT NULL,
  status VARCHAR(16) DEFAULT 'unopened',
  opened_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chests_user ON user_chests(user_id);

-- ============================================================
-- 4. Table matches (historique des matchs)
-- ============================================================
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
-- Migrations
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tournament_id INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS room_code VARCHAR(6);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(player2_id);

-- ============================================================
-- 5. Table private_rooms (salons privés)
-- ============================================================
CREATE TABLE IF NOT EXISTS private_rooms (
  code VARCHAR(6) PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 6. Tables tournaments (tournois + inscriptions + matchs)
-- ============================================================
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
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_players INTEGER DEFAULT 20;

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

-- ============================================================
-- 7. Table purchases (audit des achats)
-- ============================================================
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  item_type VARCHAR(32) NOT NULL,
  price_pc INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

-- ============================================================
-- 8. Table rank_history (historique des montées de rank)
-- ============================================================
CREATE TABLE IF NOT EXISTS rank_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  old_rank VARCHAR(32),
  new_rank VARCHAR(32),
  reward_pc INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rankhist_user ON rank_history(user_id);

-- ============================================================
-- 9. Table chest_openings (audit des coffres ouverts)
-- ============================================================
CREATE TABLE IF NOT EXISTS chest_openings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  chest_level INTEGER NOT NULL,
  rewards TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 10. Table reports (signalements entre joueurs)
-- ============================================================
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
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);

-- ============================================================
-- 11. Table admin_logs (audit des actions admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id),
  action VARCHAR(64) NOT NULL,
  target_id INTEGER,
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adminlogs_admin ON admin_logs(admin_id);

-- ============================================================
-- 12. Données initiales
-- ============================================================
-- Inutile de seed des utilisateurs : l'app crée les comptes via /api/auth/signup.
-- L'inventaire par défaut (1 pivot gratuit) est aussi créé par la route signup.

-- ============================================================
-- 13. Récapitulatif console (visible dans le shell render.com)
-- ============================================================
DO $$
DECLARE
  nb_users int;
  nb_admins int;
  nb_banned int;
BEGIN
  SELECT COUNT(*) INTO nb_users FROM users;
  SELECT COUNT(*) INTO nb_admins FROM users WHERE admin_level >= 1 OR is_admin = TRUE;
  SELECT COUNT(*) INTO nb_banned FROM users WHERE banned = TRUE;
  RAISE NOTICE '==============================================';
  RAISE NOTICE '  PIVOT Online — Migration terminée avec succès';
  RAISE NOTICE '==============================================';
  RAISE NOTICE '  Joueurs : %', nb_users;
  RAISE NOTICE '  Admins  : %', nb_admins;
  RAISE NOTICE '  Bannis  : %', nb_banned;
  RAISE NOTICE '==============================================';
  RAISE NOTICE '  Pour promouvoir un MODO, exécute :';
  RAISE NOTICE '    UPDATE users SET admin_level = 1, is_admin = TRUE WHERE pseudo = ''pseudo'';';
  RAISE NOTICE '  ';
  RAISE NOTICE '  Pour promouvoir un ADMIN PRINCIPAL, exécute :';
  RAISE NOTICE '    UPDATE users SET admin_level = 2, is_admin = TRUE WHERE pseudo = ''pseudo'';';
  RAISE NOTICE '==============================================';
END $$;

COMMIT;
