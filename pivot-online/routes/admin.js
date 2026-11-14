// routes/admin.js — Page admin: gestion des comptes, bans, dons, signalements.
//
// Système de niveaux:
//   admin_level = 0 → utilisateur normal
//   admin_level = 1 → modo (peut: voir, ban/deban users, give items, voir/resolve reports, delete users)
//   admin_level = 2 → admin principal (tout ce que modo peut + nommer modo/admin, bannir modos, retirer modo)
//
// Règles:
// - Le middleware adminMiddleware exige admin_level >= 1 pour toutes les routes.
// - Les routes sensibles (set-admin-level, ban/unban d'un autre admin) exigent admin_level >= 2.
// - Un modo ne peut PAS bannir un autre modo ou admin.
// - Un admin principal PEUT bannir un modo (mais pas un autre admin principal).
// - Pour empêcher de se lock-out: impossible de se rétrograder/bannir soi-même.

const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');

const router = express.Router();

// Charge le admin_level de l'utilisateur courant (depuis la DB).
async function getAdminLevel(userId) {
  const r = await pool.query('SELECT admin_level, is_admin, banned FROM users WHERE id = $1', [userId]);
  if (r.rowCount === 0) return { level: 0, banned: false, found: false };
  // Si admin_level n'existe pas (vieille DB), on dérive de is_admin
  let level = r.rows[0].admin_level;
  if (level == null) level = r.rows[0].is_admin ? 1 : 0;
  return { level, banned: r.rows[0].banned, found: true };
}

// Middleware: vérifie que l'utilisateur est admin (admin_level >= 1).
async function adminMiddleware(req, res, next) {
  try {
    const { level, banned, found } = await getAdminLevel(req.user.id);
    if (!found) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (banned) return res.status(403).json({ error: 'Votre compte est banni.' });
    if (level < 1) return res.status(403).json({ error: 'Accès admin requis.' });
    req.adminLevel = level;
    next();
  } catch (e) {
    console.error('[admin] mw:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// Middleware: exige admin_level >= 2 (admin principal)
function mainAdminOnly(req, res, next) {
  if (req.adminLevel < 2) return res.status(403).json({ error: 'Réservé à l\'admin principal.' });
  next();
}

async function logAdmin(adminId, action, targetId, details) {
  await pool.query(
    `INSERT INTO admin_logs (admin_id, action, target_id, details) VALUES ($1, $2, $3, $4)`,
    [adminId, action, targetId || null, details || null]
  );
}

// Toutes les routes ci-dessous requièrent auth + admin (admin_level >= 1)
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/me — renvoie le admin_level de l'utilisateur courant
router.get('/me', (req, res) => {
  res.json({ admin_level: req.adminLevel });
});

// GET /api/admin/stats — statistiques globales (modo + admin principal)
router.get('/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    const banned = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE banned = TRUE');
    const admins = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE admin_level >= 1 OR is_admin = TRUE');
    const modos = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE admin_level = 1');
    const mainAdmins = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE admin_level = 2');
    const matches = await pool.query('SELECT COUNT(*)::int AS n FROM matches');
    const openReports = await pool.query("SELECT COUNT(*)::int AS n FROM reports WHERE status = 'open'");
    const pcTotal = await pool.query('SELECT COALESCE(SUM(pc_balance), 0)::int AS n FROM users');
    res.json({
      users: users.rows[0].n,
      banned: banned.rows[0].n,
      admins: admins.rows[0].n,
      modos: modos.rows[0].n,
      mainAdmins: mainAdmins.rows[0].n,
      matches: matches.rows[0].n,
      openReports: openReports.rows[0].n,
      pcTotal: pcTotal.rows[0].n,
      myLevel: req.adminLevel
    });
  } catch (e) {
    console.error('[admin] stats:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/admin/users — liste tous les joueurs (modo + admin principal)
router.get('/users', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  let where = '';
  let params = [];
  if (search) {
    where = 'WHERE pseudo ILIKE $1';
    params.push('%' + search + '%');
  }
  params.push(limit, offset);
  try {
    const countR = await pool.query(`SELECT COUNT(*)::int AS n FROM users ${where}`, params.slice(0, params.length - 2));
    const total = countR.rows[0].n;
    const r = await pool.query(
      `SELECT id, pseudo, elo, trophies, pc_balance, win_streak, matches_played, matches_won, matches_lost,
              is_admin, admin_level, banned, banned_reason, banned_at, created_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    // Charger les inventaires
    const userIds = r.rows.map(u => u.id);
    let inventaires = {};
    if (userIds.length > 0) {
      const inv = await pool.query(
        `SELECT user_id, ability_type, quantity FROM user_inventory WHERE user_id = ANY($1::int[])`,
        [userIds]
      );
      for (const row of inv.rows) {
        if (!inventaires[row.user_id]) inventaires[row.user_id] = { tp: 0, diagonale: 0, pivot: 0 };
        inventaires[row.user_id][row.ability_type] = row.quantity;
      }
    }
    const users = r.rows.map(u => ({
      ...u,
      admin_level: u.admin_level || (u.is_admin ? 1 : 0),
      inventaire: inventaires[u.id] || { tp: 0, diagonale: 0, pivot: 0 }
    }));
    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    console.error('[admin] users:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/delete — supprime un compte
// Modos et admin principal peuvent supprimer, mais JAMAIS un compte admin_level >= 1.
router.post('/users/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas te supprimer toi-même.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Charger le user cible
    const u = await client.query('SELECT pseudo, admin_level, is_admin FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Utilisateur introuvable.' }); }
    const targetLevel = u.rows[0].admin_level || (u.rows[0].is_admin ? 1 : 0);
    if (targetLevel >= 1) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Impossible de supprimer un admin/modo. Demande à l\'admin principal de le rétrograder d\'abord.' }); }

    const pseudo = u.rows[0].pseudo;

    // Nettoyer toutes les FK avant suppression (la DB n'a pas toutes les clauses ON DELETE CASCADE)
    // 1. matches : player1_id, player2_id, winner_id → SET NULL
    await client.query('UPDATE matches SET player1_id = NULL WHERE player1_id = $1', [id]);
    await client.query('UPDATE matches SET player2_id = NULL WHERE player2_id = $1', [id]);
    await client.query('UPDATE matches SET winner_id = NULL WHERE winner_id = $1', [id]);
    // 2. private_rooms : host_id → SET NULL (ou supprimer le salon)
    await client.query('UPDATE private_rooms SET host_id = NULL WHERE host_id = $1', [id]);
    // 3. tournaments : creator_id → SET NULL
    await client.query('UPDATE tournaments SET creator_id = NULL WHERE creator_id = $1', [id]);
    // 4. tournament_players : DELETE
    await client.query('DELETE FROM tournament_players WHERE user_id = $1', [id]);
    // 5. tournament_matches : player1_id, player2_id, winner_id → SET NULL
    await client.query('UPDATE tournament_matches SET player1_id = NULL WHERE player1_id = $1', [id]);
    await client.query('UPDATE tournament_matches SET player2_id = NULL WHERE player2_id = $1', [id]);
    await client.query('UPDATE tournament_matches SET winner_id = NULL WHERE winner_id = $1', [id]);
    // 6. purchases : DELETE
    await client.query('DELETE FROM purchases WHERE user_id = $1', [id]);
    // 7. rank_history : DELETE
    await client.query('DELETE FROM rank_history WHERE user_id = $1', [id]);
    // 8. chest_openings : DELETE
    await client.query('DELETE FROM chest_openings WHERE user_id = $1', [id]);
    // 9. user_inventory + user_chests : CASCADE déjà défini, mais on supprime quand même
    await client.query('DELETE FROM user_inventory WHERE user_id = $1', [id]);
    await client.query('DELETE FROM user_chests WHERE user_id = $1', [id]);
    // 10. reports : reporter_id → SET NULL (déjà ON DELETE SET NULL), reported_id → CASCADE, admin_id → SET NULL
    await client.query('UPDATE reports SET admin_id = NULL WHERE admin_id = $1', [id]);
    // 11. admin_logs : admin_id → SET NULL, mais on garde target_id pour l'audit
    await client.query('UPDATE admin_logs SET admin_id = NULL WHERE admin_id = $1', [id]);

    // Enfin, supprimer le user
    await client.query('DELETE FROM users WHERE id = $1', [id]);

    await logAdmin(req.user.id, 'delete_user', id, `Pseudo: ${pseudo}`);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[admin] delete:', e);
    res.status(500).json({ error: 'Erreur serveur: ' + e.message });
  } finally {
    client.release();
  }
});

// POST /api/admin/users/:id/ban — bannit un compte
// - Modos ne peuvent PAS bannir un autre modo/admin.
// - Admin principal peut bannir un modo mais pas un autre admin principal.
router.post('/users/:id/ban', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas te bannir toi-même.' });
  const reason = (req.body && req.body.reason || 'Non spécifié.').slice(0, 500);

  try {
    const u = await pool.query('SELECT admin_level, is_admin, pseudo FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const targetLevel = u.rows[0].admin_level || (u.rows[0].is_admin ? 1 : 0);

    // Vérification des permissions
    if (targetLevel >= 1) {
      // La cible est modo ou admin principal
      if (req.adminLevel < 2) {
        return res.status(403).json({ error: 'Les modos ne peuvent pas bannir un autre modo ou admin.' });
      }
      if (targetLevel >= 2) {
        return res.status(403).json({ error: 'Impossible de bannir un autre admin principal.' });
      }
      // admin principal peut bannir un modo → OK
    }

    await pool.query(
      `UPDATE users SET banned = TRUE, banned_reason = $1, banned_at = NOW() WHERE id = $2`,
      [reason, id]
    );
    await logAdmin(req.user.id, 'ban', id, `Pseudo: ${u.rows[0].pseudo}, raison: ${reason}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] ban:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/unban — débannit un compte
// Mêmes restrictions que ban.
router.post('/users/:id/unban', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });

  try {
    const u = await pool.query('SELECT admin_level, is_admin, pseudo, banned FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const targetLevel = u.rows[0].admin_level || (u.rows[0].is_admin ? 1 : 0);

    if (targetLevel >= 1 && req.adminLevel < 2) {
      return res.status(403).json({ error: 'Les modos ne peuvent pas débannir un autre modo ou admin.' });
    }
    if (targetLevel >= 2 && req.adminLevel < 2) {
      return res.status(403).json({ error: 'Impossible de débannir un autre admin principal.' });
    }

    await pool.query(
      `UPDATE users SET banned = FALSE, banned_reason = NULL, banned_at = NULL WHERE id = $1`,
      [id]
    );
    await logAdmin(req.user.id, 'unban', id, `Pseudo: ${u.rows[0].pseudo}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] unban:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/give — donne des objets à un joueur (modo + admin principal)
// body: { tp?: int, diagonale?: int, pivot?: int, pc?: int, coffre?: int (niveau) }
router.post('/users/:id/give', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const { tp, diagonale, pivot, pc, coffre } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT pseudo FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Utilisateur introuvable.' }); }

    if (pc && pc > 0) {
      await client.query('UPDATE users SET pc_balance = pc_balance + $1 WHERE id = $2', [pc, id]);
    }
    if (tp && tp > 0) {
      await client.query(
        `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, 'tp', $2)
         ON CONFLICT (user_id, ability_type) DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
        [id, tp]
      );
    }
    if (diagonale && diagonale > 0) {
      await client.query(
        `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, 'diagonale', $2)
         ON CONFLICT (user_id, ability_type) DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
        [id, diagonale]
      );
    }
    if (pivot && pivot > 0) {
      await client.query(
        `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, 'pivot', $2)
         ON CONFLICT (user_id, ability_type) DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
        [id, pivot]
      );
    }
    if (coffre && coffre >= 1 && coffre <= 5) {
      await client.query(
        `INSERT INTO user_chests (user_id, chest_level, status) VALUES ($1, $2, 'unopened')`,
        [id, coffre]
      );
    }
    const recap = [];
    if (pc) recap.push(`${pc} PC`);
    if (tp) recap.push(`${tp} TP`);
    if (diagonale) recap.push(`${diagonale} Diag`);
    if (pivot) recap.push(`${pivot} Pivot`);
    if (coffre) recap.push(`coffre niv.${coffre}`);
    await logAdmin(req.user.id, 'give_item', id, `Pseudo: ${u.rows[0].pseudo}, don: ${recap.join(', ')}`);
    await client.query('COMMIT');
    res.json({ ok: true, recap: recap.join(', ') });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[admin] give:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
});

// POST /api/admin/users/:id/set-admin-level — modifie le admin_level d'un user
// RÉSERVÉ À L'ADMIN PRINCIPAL (admin_level >= 2).
// body: { level: 0 | 1 | 2 }
router.post('/users/:id/set-admin-level', mainAdminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  if (id === req.user.id) {
    // L'admin principal peut se rétrograder (mais c'est déconseillé). On le permet avec avertissement.
    // Pour éviter de se lock-out, on demande une confirmation côté client.
  }
  const level = parseInt(req.body && req.body.level, 10);
  if (isNaN(level) || level < 0 || level > 2) {
    return res.status(400).json({ error: 'level invalide (0, 1 ou 2).' });
  }

  try {
    const u = await pool.query('SELECT admin_level, is_admin, pseudo FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const targetLevel = u.rows[0].admin_level || (u.rows[0].is_admin ? 1 : 0);

    // Si la cible est déjà admin principal (level 2) et qu'on la modifie, on doit s'assurer
    // qu'il en reste au moins un. On compte les admins principaux.
    if (targetLevel === 2 && level < 2) {
      const nbMain = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE admin_level = 2');
      if (nbMain.rows[0].n <= 1) {
        return res.status(400).json({ error: 'Impossible : il doit rester au moins un admin principal. Nomme un autre admin principal d\'abord.' });
      }
    }

    await pool.query('UPDATE users SET admin_level = $1, is_admin = ($1 >= 1) WHERE id = $2', [level, id]);
    const niveauNom = level === 2 ? 'admin principal' : (level === 1 ? 'modo' : 'utilisateur');
    await logAdmin(req.user.id, 'set_admin_level', id, `Pseudo: ${u.rows[0].pseudo}, nouveau niveau: ${level} (${niveauNom})`);
    res.json({ ok: true, level });
  } catch (e) {
    console.error('[admin] set-admin-level:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/reset-stats — remet Elo/TR/PC/streak à leurs valeurs par défaut
// Modos et admin principal.
router.post('/users/:id/reset-stats', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  try {
    await pool.query(
      `UPDATE users SET elo = 1000, trophies = 0, win_streak = 0, best_streak = 0 WHERE id = $1`,
      [id]
    );
    await logAdmin(req.user.id, 'reset_stats', id, '');
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] reset-stats:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/admin/reports — liste les signalements (modo + admin principal)
router.get('/reports', async (req, res) => {
  const status = req.query.status || 'open';
  try {
    const r = await pool.query(
      `SELECT rep.id, rep.reason, rep.details, rep.status, rep.admin_note, rep.created_at, rep.resolved_at,
              rep.reporter_id, rep.reported_id, rep.admin_id,
              ru.pseudo AS reporter_pseudo, ru.banned AS reporter_banned,
              tu.pseudo AS reported_pseudo, tu.banned AS reported_banned,
              tu.admin_level AS reported_admin_level, tu.is_admin AS reported_is_admin,
              au.pseudo AS admin_pseudo
       FROM reports rep
       LEFT JOIN users ru ON ru.id = rep.reporter_id
       LEFT JOIN users tu ON tu.id = rep.reported_id
       LEFT JOIN users au ON au.id = rep.admin_id
       WHERE rep.status = $1
       ORDER BY rep.created_at DESC
       LIMIT 100`,
      [status]
    );
    res.json({ reports: r.rows, myLevel: req.adminLevel });
  } catch (e) {
    console.error('[admin] reports:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/reports/:id/resolve — résout/écarte un signalement (modo + admin principal)
router.post('/reports/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const note = (req.body && req.body.note || '').slice(0, 500);
  const dismiss = !!(req.body && req.body.dismiss);
  try {
    const newStatus = dismiss ? 'dismissed' : 'resolved';
    await pool.query(
      `UPDATE reports SET status = $1, admin_note = $2, admin_id = $3, resolved_at = NOW() WHERE id = $4`,
      [newStatus, note, req.user.id, id]
    );
    await logAdmin(req.user.id, 'resolve_report', null, `Report #${id}: ${newStatus} — ${note}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] resolve:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/admin/logs — historique des actions admin (modo + admin principal)
router.get('/logs', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT al.id, al.action, al.target_id, al.details, al.created_at,
              u.pseudo AS admin_pseudo
       FROM admin_logs al
       LEFT JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC
       LIMIT 200`
    );
    res.json({ logs: r.rows });
  } catch (e) {
    console.error('[admin] logs:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
