// routes/shop.js — Boutique : capacités à l'unité + coffres + ouverture de coffres
const express = require('express');
const { pool } = require('../db');
const { authMiddleware } = require('./auth');
const { crediterCapacite, crediterCoffre, crediterPc, appliquerRecompense } = require('../ranks');

const router = express.Router();

// Prix des capacités à l'unité
const PRIX_CAPACITES = {
  tp:        3,  // téléportation
  diagonale: 2,
  pivot:     1
};

// 5 niveaux de coffres : { prix, variantes: [ { gains: { tp, diagonale, pivot } } ] }
// Une variante est tirée au sort à l'ouverture.
const COFFRES = {
  1: { prix: 2, variantes: [
    { gains: { tp: 1 } },
    { gains: { pivot: 3 } },
    { gains: { diagonale: 1, pivot: 1 } }
  ]},
  2: { prix: 5, variantes: [
    { gains: { tp: 1, pivot: 1 } },
    { gains: { diagonale: 1, pivot: 2 } },
    { gains: { diagonale: 2 } }
  ]},
  3: { prix: 12, variantes: [
    { gains: { tp: 2 } },
    { gains: { tp: 1, diagonale: 1, pivot: 2 } },
    { gains: { diagonale: 3, pivot: 1 } }
  ]},
  4: { prix: 25, variantes: [
    { gains: { tp: 3, diagonale: 1 } },
    { gains: { tp: 2, diagonale: 2, pivot: 2 } },
    { gains: { diagonale: 5 } }
  ]},
  5: { prix: 50, variantes: [
    { gains: { tp: 5, diagonale: 2 } },
    { gains: { tp: 4, diagonale: 3, pivot: 5 } },
    { gains: { diagonale: 10, pivot: 5 } }
  ]}
};

// GET /api/shop/info — renvoie le catalogue + l'inventaire du joueur connecté
router.get('/info', authMiddleware, async (req, res) => {
  const inv = await pool.query(
    `SELECT ability_type, quantity FROM user_inventory WHERE user_id = $1`,
    [req.user.id]
  );
  const inventaire = { tp: 0, diagonale: 0, pivot: 0 };
  for (const r of inv.rows) inventaire[r.ability_type] = r.quantity;

  const u = await pool.query('SELECT pc_balance FROM users WHERE id = $1', [req.user.id]);
  const pc = u.rows[0] ? u.rows[0].pc_balance : 0;

  const coffres = await pool.query(
    `SELECT id, chest_level, status FROM user_chests WHERE user_id = $1 AND status = 'unopened' ORDER BY id`,
    [req.user.id]
  );

  res.json({
    prixCapacites: PRIX_CAPACITES,
    coffres: COFFRES,
    inventaire,
    pc,
    coffresEnStock: coffres.rows
  });
});

// POST /api/shop/buy-capacite — achète une capacité à l'unité
// body: { type: 'tp'|'diagonale'|'pivot', quantite: 1..50 }
router.post('/buy-capacite', authMiddleware, async (req, res) => {
  const { type, quantite } = req.body || {};
  if (!PRIX_CAPACITES[type]) return res.status(400).json({ error: 'Type de capacité invalide.' });
  const qte = parseInt(quantite, 10);
  if (!qte || qte < 1 || qte > 50) return res.status(400).json({ error: 'Quantité invalide (1-50).' });

  const prix = PRIX_CAPACITES[type] * qte;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT pc_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (u.rowCount === 0) throw new Error('Utilisateur introuvable.');
    if (u.rows[0].pc_balance < prix) throw new Error('Pas assez de PC.');
    await client.query('UPDATE users SET pc_balance = pc_balance - $1 WHERE id = $2', [prix, req.user.id]);
    await client.query(
      `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, ability_type)
       DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
      [req.user.id, type, qte]
    );
    await client.query(
      `INSERT INTO purchases (user_id, item_type, price_pc) VALUES ($1, $2, $3)`,
      [req.user.id, `${type} x${qte}`, prix]
    );
    await client.query('COMMIT');
    const nouv = await client.query('SELECT pc_balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ ok: true, depense: prix, nouveauPc: nouv.rows[0].pc_balance, capacite: type, quantite: qte });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.message.startsWith('Pas assez') || e.message.startsWith('Utilisateur'))
      return res.status(400).json({ error: e.message });
    console.error('[shop] buy-capacite:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
});

// POST /api/shop/buy-chest — achète un coffre (il faut l'ouvrir ensuite)
// body: { niveau: 1..5 }
router.post('/buy-chest', authMiddleware, async (req, res) => {
  const niveau = parseInt(req.body && req.body.niveau, 10);
  if (!COFFRES[niveau]) return res.status(400).json({ error: 'Niveau de coffre invalide.' });
  const prix = COFFRES[niveau].prix;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT pc_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (u.rowCount === 0) throw new Error('Utilisateur introuvable.');
    if (u.rows[0].pc_balance < prix) throw new Error('Pas assez de PC.');
    await client.query('UPDATE users SET pc_balance = pc_balance - $1 WHERE id = $2', [prix, req.user.id]);
    const ins = await client.query(
      `INSERT INTO user_chests (user_id, chest_level, status) VALUES ($1, $2, 'unopened') RETURNING id`,
      [req.user.id, niveau]
    );
    await client.query(
      `INSERT INTO purchases (user_id, item_type, price_pc) VALUES ($1, $2, $3)`,
      [req.user.id, `chest_${niveau}`, prix]
    );
    await client.query('COMMIT');
    res.json({ ok: true, depense: prix, chestId: ins.rows[0].id, niveau });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.message.startsWith('Pas assez') || e.message.startsWith('Utilisateur'))
      return res.status(400).json({ error: e.message });
    console.error('[shop] buy-chest:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
});

// POST /api/shop/open-chest — ouvre un coffre en stock et crédite les gains
// body: { chestId: 123 }
router.post('/open-chest', authMiddleware, async (req, res) => {
  const chestId = parseInt(req.body && req.body.chestId, 10);
  if (!chestId) return res.status(400).json({ error: 'chestId requis.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM user_chests WHERE id = $1 AND user_id = $2 AND status = 'unopened' FOR UPDATE`,
      [chestId, req.user.id]
    );
    if (r.rowCount === 0) throw new Error('Coffre introuvable ou déjà ouvert.');
    const coffre = r.rows[0];
    const niveau = coffre.chest_level;
    const catalog = COFFRES[niveau];
    if (!catalog) throw new Error('Niveau de coffre invalide.');
    // Tirer une variante
    const variante = catalog.variantes[Math.floor(Math.random() * catalog.variantes.length)];
    // Créditer les gains
    const recap = [];
    for (const [type, qte] of Object.entries(variante.gains)) {
      await client.query(
        `INSERT INTO user_inventory (user_id, ability_type, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, ability_type)
         DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
        [req.user.id, type, qte]
      );
      recap.push(`${qte} ${type}`);
    }
    await client.query(
      `UPDATE user_chests SET status = 'opened', opened_at = NOW() WHERE id = $1`,
      [chestId]
    );
    await client.query(
      `INSERT INTO chest_openings (user_id, chest_level, rewards) VALUES ($1, $2, $3)`,
      [req.user.id, niveau, JSON.stringify(variante.gains)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, niveau, gains: variante.gains, recap: recap.join(', ') });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.message.startsWith('Coffre')) return res.status(404).json({ error: e.message });
    console.error('[shop] open-chest:', e);
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
});

module.exports = router;
