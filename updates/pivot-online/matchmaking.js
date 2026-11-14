// matchmaking.js — File d'attente + appariement par Elo
//
// Le joueur entre dans la file via sockets/jouer. Le serveur cherche un adversaire
// dans la même tranche de Elo (±50 par défaut). Après 10s, élargir progressivement.
// Au pire, prend le joueur avec le Elo le plus proche disponible dans la file.

const joueurs = [];  // { socketId, userId, pseudo, elo, depuis }

function ajouter(entry) {
  // éviter doublons
  retirer(entry.socketId);
  retirerUser(entry.userId);
  entry.depuis = Date.now();
  joueurs.push(entry);
}

function retirer(socketId) {
  const i = joueurs.findIndex((j) => j.socketId === socketId);
  if (i >= 0) joueurs.splice(i, 1);
}

function retirerUser(userId) {
  const i = joueurs.findIndex((j) => j.userId === userId);
  if (i >= 0) joueurs.splice(i, 1);
}

function taille() { return joueurs.length; }

// Cherche un adversaire pour `userId` et renvoie le match trouvé (et le retire de la file).
// Renvoie null si personne pour l'instant.
function chercherAdversaire(userId, elo) {
  // On n'apparie jamais avec soi-même
  const candidats = joueurs.filter((j) => j.userId !== userId);
  if (candidats.length === 0) return null;

  // 1) Trouver dans la tranche la plus large selon l'attente du joueur
  // Calcule l'écart de chacun avec `elo` et trie par écart croissant
  candidats.sort((a, b) => Math.abs(a.elo - elo) - Math.abs(b.elo - elo));

  // 2) Tranche dynamique : ±50, puis ±100 (après 10s), puis ±200 (après 20s), puis tout
  const attente = Date.now() - (candidats[0].depuis || Date.now());
  let marge = 50;
  if (attente > 20000) marge = 1000;
  else if (attente > 10000) marge = 200;
  else if (attente > 5000) marge = 100;

  // On prend le plus proche en Elo dans la marge ; sinon le plus proche tout court
  const dansMarge = candidats.filter((j) => Math.abs(j.elo - elo) <= marge);
  const choisi = (dansMarge.length > 0 ? dansMarge[0] : candidats[0]);

  // Retirer les deux de la file
  retirerUser(choisi.userId);
  retirerUser(userId);

  return choisi;
}

module.exports = { ajouter, retirer, retirerUser, chercherAdversaire, taille };
