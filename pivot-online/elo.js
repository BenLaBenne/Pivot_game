// elo.js — Formule Elo standard (K=32)
// Elo_new = Elo_old + K * (score_obtenu - score_attendu)
// score_attendu = 1 / (1 + 10^((Elo_adv - Elo_joueur)/400))

const K = 32;

function expected(joueur, adversaire) {
  return 1 / (1 + Math.pow(10, (adversaire - joueur) / 400));
}

// Calcule le delta Elo d'un joueur (positif ou négatif)
// resultat: 1 = victoire, 0.5 = nul, 0 = défaite
function deltaElo(eloJoueur, eloAdversaire, resultat) {
  return Math.round(K * (resultat - expected(eloJoueur, eloAdversaire)));
}

// Applique Elo aux deux joueurs et renvoie les nouvelles valeurs
function appliquerElo(eloA, eloB, scoreA /* 1/0.5/0 */) {
  const scoreB = 1 - scoreA;
  const newA = eloA + deltaElo(eloA, eloB, scoreA);
  const newB = eloB + deltaElo(eloB, eloA, scoreB);
  return { newA, newB, deltaA: newA - eloA, deltaB: newB - eloB };
}

module.exports = { K, expected, deltaElo, appliquerElo };
