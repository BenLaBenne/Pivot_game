// game/rules.js — Logique PIVOT v2 (portée depuis pivot.html v1 + règles v2)
//
// Règles v2 :
// - Grille 7x7, pivot partagé départ D4.
// - 3 bornes/joueur (gratuites).
// - 2 virages/joueur.
// - 1 téléportation/joueur (suivie obligatoirement d'un déplacement).
// - 1 diagonale/joueur.
// - Rouge = horizontal, Bleu = vertical.
// - Perte si aucun mouvement possible (glissement, virage, diagonale, tp),
//   même s'il reste des bornes. Une borne ne sauve pas.
// - Échange des camps après le premier coup : Bleu choisit garder ou échanger.

const N = 7;
const LETTRES = 'ABCDEFG';
const RANK_TIERS = ['Plastique', 'Bronze', 'Argent', 'Fer', 'Or', 'Legendary'];

const autre = (cote) => (cote === 'R' ? 'B' : 'R');
const axeDe = (cote) => (cote === 'R' ? 'H' : 'V');
const dansGrille = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
const nomCase = (x, y) => LETTRES[x] + (y + 1);

// Crée un état de partie neuf.
function nouvelEtat(matchType = 'ranked') {
  const cases = [];
  for (let y = 0; y < N; y++) {
    cases.push([]);
    for (let x = 0; x < N; x++) cases[y].push(null);
  }
  const centre = Math.floor(N / 2);
  cases[centre][centre] = { type: 'trace', cote: null };  // départ bloqué

  return {
    cases: cases,
    pivot: { x: centre, y: centre },
    traits: [],
    tour: 'R',
    // Stock v2 : bornes(3) + virage(2) + tp(1) + diagonale(1)
    stock: {
      R: { bornes: 3, virage: 2, tp: 1, diagonale: 1 },
      B: { bornes: 3, virage: 2, tp: 1, diagonale: 1 }
    },
    noms: { R: 'Joueur 1', B: 'Joueur 2' },
    ids: { R: null, B: null },
    coups: 0,
    coupsParJoueur: { R: 0, B: 0 },   // actions par joueur (pour XP pass)
    attenteEchange: false,
    enTp: false,              // true si le joueur vient de téléporter et doit encore déplacer
    gagnant: null,
    matchType,
    startedAt: Date.now(),
    lastMoveAt: Date.now()
  };
}

// Liste des points où le pivot peut aller en glissant sur l'axe donné ("H" ou "V").
function destinations(e, axe) {
  const directions = axe === 'H' ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
  const out = [];
  for (const [dx, dy] of directions) {
    let x = e.pivot.x + dx;
    let y = e.pivot.y + dy;
    while (dansGrille(x, y) && e.cases[y][x] === null) {
      out.push({ x, y });
      x += dx;
      y += dy;
    }
  }
  return out;
}

// Destinations en diagonale (4 directions)
function destinationsDiagonale(e) {
  const dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const out = [];
  for (const [dx, dy] of dirs) {
    let x = e.pivot.x + dx;
    let y = e.pivot.y + dy;
    while (dansGrille(x, y) && e.cases[y][x] === null) {
      out.push({ x, y });
      x += dx;
      y += dy;
    }
  }
  return out;
}

// Tous les points libres (pour poser une borne ou se téléporter)
function pointsLibres(e) {
  const out = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (e.cases[y][x] === null) out.push({ x, y });
  return out;
}

// Teste si un déplacement en ligne droite de (x0,y0) à (x1,y1) est libre (aucun point bloqué).
function ligneLibre(e, x0, y0, x1, y1) {
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let x = x0 + dx, y = y0 + dy;
  while (x !== x1 || y !== y1) {
    if (!dansGrille(x, y) || e.cases[y][x] !== null) return false;
    x += dx;
    y += dy;
  }
  return dansGrille(x1, y1) && e.cases[y1][x1] === null;
}

// Le joueur cote a-t-il au moins un mouvement possible (glisser, virage, diagonale, tp) ?
function peutBouger(e, cote) {
  // Glissement sur son axe
  if (destinations(e, axeDe(cote)).length > 0) return true;
  // Virage = glissement sur l'axe adverse
  if (e.stock[cote].virage > 0 && destinations(e, axeDe(autre(cote))).length > 0) return true;
  // Diagonale
  if (e.stock[cote].diagonale > 0 && destinationsDiagonale(e).length > 0) return true;
  // Téléportation : il faut un point libre qui laisse au moins une sortie ensuite
  if (e.stock[cote].tp > 0) {
    // Sur le point cible, vérifier qu'au moins un mouvement (glissement/virage/diagonale) est possible
    for (const pt of pointsLibres(e)) {
      if (pt.x === e.pivot.x && pt.y === e.pivot.y) continue;
      if (peutBougerDepuis(e, cote, pt)) return true;
    }
  }
  return false;
}

// Vérifie si depuis une position hypothétique pt, le joueur cote aurait au moins
// un mouvement possible (pour valider une téléportation). On simule en plaçant
// le pivot sur pt et en marquant l'ancien point comme visité.
function peutBougerDepuis(e, cote, pt) {
  // Créer un état simulé
  const sim = JSON.parse(JSON.stringify(e));
  // Marquer l'ancienne position comme visitée (elle l'est déjà, mais on déplace le pivot)
  sim.pivot = { x: pt.x, y: pt.y };
  // Marquer pt comme visité dans la couleur du joueur
  sim.cases[pt.y][pt.x] = { type: 'trace', cote: cote };
  // Recalculer
  return (
    destinations(sim, axeDe(cote)).length > 0 ||
    (sim.stock[cote].virage > 0 && destinations(sim, axeDe(autre(cote))).length > 0) ||
    (sim.stock[cote].diagonale > 0 && destinationsDiagonale(sim).length > 0)
  );
}

function verifierDefaite(e) {
  if (!peutBouger(e, e.tour)) {
    e.gagnant = autre(e.tour);
    return true;
  }
  return false;
}

// Applique un déplacement de (x0,y0) à (x1,y1) en ligne droite (trace + arrive).
function deplacerPivot(e, cote, x1, y1) {
  const x0 = e.pivot.x;
  const y0 = e.pivot.y;
  const dx = Math.sign(x1 - x0);
  const dy = Math.sign(y1 - y0);
  let cx = x0, cy = y0;
  while (cx !== x1 || cy !== y1) {
    cx += dx;
    cy += dy;
    e.cases[cy][cx] = { type: 'trace', cote };
  }
  e.traits.push({ x1: x0, y1: y0, x2: x1, y2: y1, cote });
  e.pivot = { x: x1, y: y1 };
}

module.exports = {
  N, LETTRES, RANK_TIERS,
  autre, axeDe, dansGrille, nomCase,
  nouvelEtat, destinations, destinationsDiagonale, pointsLibres, ligneLibre,
  peutBouger, peutBougerDepuis, verifierDefaite, deplacerPivot
};
