// routes/admin.js — Page admin: gestion des comptes, bans, dons, signalements.
// Toutes les routes exigent authMiddleware + adminMiddleware.
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');

const router = express.Router();

// Middleware: vérifie que l'utilisateur est admin.
async function adminMiddleware(req, res, next) {
  try {
    const r = await pool.query('SELECT is_admin, banned FROM users WHERE id = $1', [req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (r.rows[0].banned) return res.status(403).json({ error: 'Votre compte est banni.' });
    if (!r.rows[0].is_admin) return res.status(403).json({ error: 'Accès admin requis.' });
    next();
  } catch (e) {
    console.error('[admin] mw:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
}

async function logAdmin(adminId, action, targetId, details) {
  await pool.query(
    `INSERT INTO admin_logs (admin_id, action, target_id, details) VALUES ($1, $2, $3, $4)`,
    [adminId, action, targetId || null, details || null]
  );
}

// Toutes les routes ci-dessous requièrent auth + admin
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/users — liste tous les joueurs (avec pagination)
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
              is_admin, banned, banned_reason, banned_at, created_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    // Charger les inventaires des utilisateurs affichés
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
    const users = r.rows.map(u => ({ ...u, inventaire: inventaires[u.id] || { tp: 0, diagonale: 0, pivot: 0 } }));
    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (e) {
    console.error('[admin] users:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/delete — supprime un compte
router.post('/users/:id/delete', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas te supprimer toi-même.' });
  // Vérifier que la cible n'est pas un admin (anti-cascade admin)
  const u = await pool.query('SELECT is_admin FROM users WHERE id = $1', [id]);
  if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (u.rows[0].is_admin) return res.status(403).json({ error: 'Impossible de supprimer un admin.' });
  try {
    const pseudo = (await pool.query('SELECT pseudo FROM users WHERE id = $1', [id])).rows[0].pseudo;
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    await logAdmin(req.user.id, 'delete_user', id, `Pseudo: ${pseudo}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] delete:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/ban — bannit un compte
// body: { reason }
router.post('/users/:id/ban', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  if (id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas te bannir toi-même.' });
  const reason = (req.body && req.body.reason || 'Non spécifié.').slice(0, 500);
  const u = await pool.query('SELECT is_admin, pseudo FROM users WHERE id = $1', [id]);
  if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  if (u.rows[0].is_admin) return res.status(403).json({ error: 'Impossible de bannir un admin.' });
  try {
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
router.post('/users/:id/unban', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  try {
    await pool.query(
      `UPDATE users SET banned = FALSE, banned_reason = NULL, banned_at = NULL WHERE id = $1`,
      [id]
    );
    await logAdmin(req.user.id, 'unban', id, '');
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] unban:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/give — donne des objets à un joueur
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

// POST /api/admin/users/:id/set-admin — promeut/rétrograde un admin
// body: { isAdmin: bool }
router.post('/users/:id/set-admin', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'id invalide.' });
  const isAdmin = !!req.body.isAdmin;
  try {
    const u = await pool.query('SELECT pseudo, is_admin FROM users WHERE id = $1', [id]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
    await logAdmin(req.user.id, 'set_admin', id, `Pseudo: ${u.rows[0].pseudo}, isAdmin=${isAdmin}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] set-admin:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/users/:id/reset-elo — remet Elo/TR/PC/streak à leurs valeurs par défaut
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

// GET /api/admin/reports — liste les signalements (par défaut: open)
router.get('/reports', async (req, res) => {
  const status = req.query.status || 'open';
  try {
    const r = await pool.query(
      `SELECT rep.id, rep.reason, rep.details, rep.status, rep.admin_note, rep.created_at, rep.resolved_at,
              rep.reporter_id, rep.reported_id, rep.admin_id,
              ru.pseudo AS reporter_pseudo, ru.banned AS reporter_banned,
              tu.pseudo AS reported_pseudo, tu.banned AS reported_banned,
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
    res.json({ reports: r.rows });
  } catch (e) {
    console.error('[admin] reports:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/admin/reports/:id/resolve — marque un signalement comme résolu (avec note)
// body: { note, dismiss: bool }
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

// GET /api/admin/logs — historique des actions admin
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

// GET /api/admin/stats — statistiques globales (dashboard admin)
router.get('/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    const online = 0; // pas de tracking des sockets ici
    const banned = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE banned = TRUE');
    const admins = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE');
    const matches = await pool.query('SELECT COUNT(*)::int AS n FROM matches');
    const openReports = await pool.query("SELECT COUNT(*)::int AS n FROM reports WHERE status = 'open'");
    const pcTotal = await pool.query('SELECT COALESCE(SUM(pc_balance), 0)::int AS n FROM users');
    res.json({
      users: users.rows[0].n,
      banned: banned.rows[0].n,
      admins: admins.rows[0].n,
      matches: matches.rows[0].n,
      openReports: openReports.rows[0].n,
      pcTotal: pcTotal.rows[0].n
    });
  } catch (e) {
    console.error('[admin] stats:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
