// pass.js — Configuration du Pass de Combat
//
// 30 niveaux par saison (1 saison = 1 mois).
// Chaque niveau débloque une récompense (PC, capacités, coffres) — automatiquement créditée.
// XP gagnée à chaque match : +10 par victoire, +3 par défaite, +5 par coup joué.
// Système purement COSMÉTIQUE : aucune récompense ne donne d'avantage en jeu,
// juste du PC et des capacités déjà achetables à la boutique.

const XP_PER_LEVEL = 100;        // XP needed for each level
const TOTAL_LEVELS = 30;
const XP_PER_WIN = 10;
const XP_PER_LOSS = 3;
const XP_PER_MOVE = 5;

// Récompenses par niveau (30 niveaux)
// Format compatible avec appliquerRecompense() de ranks.js :
//   { pc, tp, diagonale, pivot, coffre, coffre2 }
const REWARDS = [
  // Niveaux 1-5 (débutant — petites récompenses)
  { level: 1,  pc: 50 },
  { level: 2,  pivot: 1 },
  { level: 3,  pc: 30, diagonale: 1 },
  { level: 4,  tp: 1 },
  { level: 5,  coffre: 2 },
  // Niveaux 6-10 (premier palier — coffre niv.3 au niv.10)
  { level: 6,  pc: 50 },
  { level: 7,  pivot: 2 },
  { level: 8,  pc: 30, diagonale: 1 },
  { level: 9,  tp: 1 },
  { level: 10, coffre: 3 },
  // Niveaux 11-15
  { level: 11, pc: 80 },
  { level: 12, pivot: 2 },
  { level: 13, pc: 50, diagonale: 2 },
  { level: 14, tp: 2 },
  { level: 15, coffre: 3 },
  // Niveaux 16-20 (deuxième palier — coffre niv.4 au niv.20)
  { level: 16, pc: 80 },
  { level: 17, pivot: 2 },
  { level: 18, pc: 50, diagonale: 2 },
  { level: 19, tp: 2 },
  { level: 20, coffre: 4 },
  // Niveaux 21-25 (troisième palier — coffre niv.5 au niv.25)
  { level: 21, pc: 100 },
  { level: 22, pivot: 3 },
  { level: 23, pc: 80, diagonale: 2 },
  { level: 24, tp: 3 },
  { level: 25, coffre: 5 },
  // Niveaux 26-30 (final — grosse récompense au niv.30)
  { level: 26, pc: 150 },
  { level: 27, pivot: 3 },
  { level: 28, pc: 100, diagonale: 3 },
  { level: 29, tp: 3 },
  { level: 30, coffre: 5, pc: 500 }
];

function rewardForLevel(level) {
  return REWARDS.find(r => r.level === level) || null;
}

// Icône d'affichage pour une récompense (côté client)
function rewardIcon(reward) {
  if (!reward) return '🎁';
  const parts = [];
  if (reward.pc) parts.push(`🪙${reward.pc}`);
  if (reward.tp) parts.push(`⚡${reward.tp}`);
  if (reward.diagonale) parts.push(`↗️${reward.diagonale}`);
  if (reward.pivot) parts.push(`🔄${reward.pivot}`);
  if (reward.coffre) parts.push(`📦${reward.coffre}`);
  return parts.join(' + ') || '🎁';
}

// Calcule les nouveaux XP et le nouveau niveau après ajout d'XP.
// Renvoie { newXp, newLevel, levelsGained, newRewards: [...] }
function applyXp(currentXp, currentLevel, xpGained) {
  let newXp = currentXp + xpGained;
  let newLevel = currentLevel;
  const newRewards = [];

  // Tant qu'on a assez d'XP pour le niveau suivant et qu'on n'est pas au max
  while (newLevel < TOTAL_LEVELS && newXp >= (newLevel + 1) * XP_PER_LEVEL) {
    newLevel += 1;
    const reward = rewardForLevel(newLevel);
    if (reward) newRewards.push(reward);
  }

  // Plafonner l'XP si on est déjà au niveau max (pour éviter une XP infinie stockée)
  if (newLevel >= TOTAL_LEVELS) {
    newXp = Math.min(newXp, TOTAL_LEVELS * XP_PER_LEVEL);
  }

  return {
    newXp,
    newLevel,
    levelsGained: newLevel - currentLevel,
    newRewards
  };
}

// Calcule l'XP gagnée par un joueur à la fin d'un match
function xpPourMatch(aGagne, nbCoupsJoues) {
  const base = aGagne ? XP_PER_WIN : XP_PER_LOSS;
  const moves = Math.max(0, nbCoupsJoues || 0) * XP_PER_MOVE;
  return base + moves;
}

module.exports = {
  XP_PER_LEVEL, TOTAL_LEVELS, XP_PER_WIN, XP_PER_LOSS, XP_PER_MOVE,
  REWARDS, rewardForLevel, rewardIcon, applyXp, xpPourMatch
};
