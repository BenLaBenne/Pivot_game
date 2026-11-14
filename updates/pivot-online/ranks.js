// ranks.js — Système de rank à 18 paliers (6 tiers × 3 niveaux)
// + récompenses automatiques à chaque montée de niveau/tier.
// Utilisé par les routes (shop, profile) et par les sockets (fin de match).

const { pool } = require('./db');

// 18 ranks du plus bas au plus haut
const RANKS = [
  { nom: 'Plastique 1', tr: 0 },
  { nom: 'Plastique 2', tr: 50 },
  { nom: 'Plastique 3', tr: 100 },
  { nom: 'Bronze 1', tr: 150 },
  { nom: 'Bronze 2', tr: 250 },
  { nom: 'Bronze 3', tr: 350 },
  { nom: 'Argent 1', tr: 500 },
  { nom: 'Argent 2', tr: 650 },
  { nom: 'Argent 3', tr: 800 },
  { nom: 'Fer 1', tr: 1000 },
  { nom: 'Fer 2', tr: 1200 },
  { nom: 'Fer 3', tr: 1400 },
  { nom: 'Or 1', tr: 1700 },
  { nom: 'Or 2', tr: 2000 },
  { nom: 'Or 3', tr: 2300 },
  { nom: 'Legendary 1', tr: 2700 },
  { nom: 'Legendary 2', tr: 3100 },
  { nom: 'Legendary 3', tr: 3500 }
];

// Renvoie le rang (objet) pour un nombre de TR donné.
function rangPourTR(tr) {
  let r = RANKS[0];
  for (const cand of RANKS) {
    if (tr >= cand.tr) r = cand;
  }
  return r;
}

// Renvoie l'index du rang.
function indexRang(tr) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (tr >= RANKS[i].tr) idx = i;
  }
  return idx;
}

// Récompenses de montée de niveau (au sein d'un tier)
const RECOMP_NIVEAU = {
  Plastique: { pc: 30 },
  Bronze: { pc: 50, pivot: 1 },
  Argent: { pc: 80, diagonale: 1 },
  Fer: { pc: 120, coffre: 2 },
  Or: { pc: 200, coffre: 3 },
  Legendary: { pc: 350, coffre: 4 }
};

// Récompenses de montée de tier (Plastique 3 → Bronze 1, etc.)
const RECOMP_TIER = {
  Bronze: { pc: 100, coffre: 2 },
  Argent: { pc: 200, coffre: 3 },
  Fer: { pc: 400, coffre: 4, tp: 2 },
  Or: { pc: 700, coffre: 5, diagonale: 3 },
  Legendary: { pc: 1500, coffre: 5, coffre2: 5, tp: 5, diagonale: 5 } // coffre 5 x2
};

// Crédite un objet "coffre" dans l'inventaire user_chests
async function crediterCoffre(userId, level) {
  await pool.query(
    'INSERT INTO user_chests (user_id, chest_level, status) VALUES ($1, $2, $3)',
    [userId, level, 'unopened']
  );
}

// Crédite une quantité d'une capacité dans user_inventory (atomic incréments)
async function crediterCapacite(userId, type, qte) {
  if (!type || qte <= 0) return;
  // Upsert
  await pool.query(
    `INSERT INTO user_inventory (user_id, ability_type, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, ability_type)
     DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity`,
    [userId, type, qte]
  );
}

// Crédite des PC au solde utilisateur
async function crediterPc(userId, montant) {
  if (montant <= 0) return;
  await pool.query('UPDATE users SET pc_balance = pc_balance + $1 WHERE id = $2',
    [montant, userId]);
}

// Applique une récompense composite (objet avec pc, tp, diagonale, pivot, coffre, coffre2)
async function appliquerRecompense(userId, recomp) {
  const resume = [];
  if (recomp.pc) { await crediterPc(userId, recomp.pc); resume.push(`${recomp.pc} PC`); }
  if (recomp.tp) { await crediterCapacite(userId, 'tp', recomp.tp); resume.push(`${recomp.tp} TP`); }
  if (recomp.diagonale) { await crediterCapacite(userId, 'diagonale', recomp.diagonale); resume.push(`${recomp.diagonale} Diagonale`); }
  if (recomp.pivot) { await crediterCapacite(userId, 'pivot', recomp.pivot); resume.push(`${recomp.pivot} Pivot`); }
  if (recomp.coffre) { await crediterCoffre(userId, recomp.coffre); resume.push(`coffre niv.${recomp.coffre}`); }
  if (recomp.coffre2) { await crediterCoffre(userId, recomp.coffre2); resume.push(`coffre niv.${recomp.coffre2}`); }
  return resume.join(', ');
}

// Vérifie et applique toutes les montées de rank entre oldTr et newTr.
// Renvoie la liste des récompenses créditées.
async function verifierMontees(userId, oldTr, newTr) {
  if (newTr <= oldTr) return [];
  const oldIdx = indexRang(oldTr);
  const newIdx = indexRang(newTr);
  if (newIdx === oldIdx) return [];

  const recompenses = [];
  for (let i = oldIdx + 1; i <= newIdx; i++) {
    const rang = RANKS[i];
    const [tier, niveauStr] = rang.nom.split(' ');
    const isMonteeTier = (niveauStr === '1' && i > 0); // Plastique 3 → Bronze 1, etc.
    let rec;
    if (isMonteeTier) {
      rec = RECOMP_TIER[tier] || {};
    } else {
      rec = RECOMP_NIVEAU[tier] || {};
    }
    if (Object.keys(rec).length === 0) continue;
    const resume = await appliquerRecompense(userId, rec);
    await pool.query(
      `INSERT INTO rank_history (user_id, old_rank, new_rank, reward_pc)
       VALUES ($1, $2, $3, $4)`,
      [userId, RANKS[i - 1].nom, rang.nom, rec.pc || 0]
    );
    recompenses.push({ rang: rang.nom, recompenses: resume });
  }
  return recompenses;
}

module.exports = {
  RANKS, rangPourTR, indexRang,
  RECOMP_NIVEAU, RECOMP_TIER,
  crediterPc, crediterCapacite, crediterCoffre,
  appliquerRecompense, verifierMontees
};
