// game/state.js — Validation des coups + gestion d'une partie côté serveur.
// Le serveur est l'arbitre : le client envoie une intention, le serveur valide,
// applique, met à jour l'état, décrémente l'inventaire et détecte la victoire.

const rules = require('./rules');
const { autre, axeDe, dansGrille, nomCase, destinations, destinationsDiagonale,
  pointsLibres, deplacerPivot, peutBouger, peutBougerDepuis, verifierDefaite } = rules;

// Types d'actions acceptées par le serveur :
//  - { type: 'glisser', to: {x,y} }
//  - { type: 'virage', to: {x,y} }
//  - { type: 'diagonale', to: {x,y} }
//  - { type: 'borne', to: {x,y} }
//  - { type: 'tp', to: {x,y} }                       // téléportation seule (doit être suivie d'un déplacement)
//  - { type: 'tp_suite', deplacement: {type:'glisser'|'virage'|'diagonale', to:{x,y}} }
//  - { type: 'echange', garder: bool }

// Retourne { ok: true } ou { ok: false, err: 'message' }
// `inv` = inventaire côté serveur (DB) de l'utilisateur : { tp, diagonale, pivot }
//         Sert à valider que le joueur n'utilise pas plus que ce qu'il a en stock.
function appliquerCoup(e, cote, action, inv) {
  if (e.gagnant) return { ok: false, err: 'Partie terminée.' };
  if (e.attenteEchange) {
    // Seul le joueur "Bleu courant" peut décider
    if (action.type !== 'echange') return { ok: false, err: 'Échange des camps en attente.' };
    return appliquerEchange(e, cote, action);
  }
  if (e.tour !== cote) return { ok: false, err: 'Ce n\'est pas à vous de jouer.' };

  // Cas où le joueur doit finir sa téléportation par un déplacement
  if (e.enTp) {
    if (!action.type || action.type !== 'tp_suite') {
      return { ok: false, err: 'Vous devez déplacer le pivot après la téléportation.' };
    }
    return appliquerTpSuite(e, cote, action.deplacement, inv);
  }

  switch (action.type) {
    case 'glisser':   return appliquerGlisser(e, cote, action.to);
    case 'virage':    return appliquerVirage(e, cote, action.to, inv);
    case 'diagonale': return appliquerDiagonale(e, cote, action.to, inv);
    case 'borne':     return appliquerBorne(e, cote, action.to);
    case 'tp':        return appliquerTp(e, cote, action.to, inv);
    case 'echange':   return { ok: false, err: 'Pas d\'échange attendu ici.' };
    default:          return { ok: false, err: 'Action inconnue: ' + action.type };
  }
}

function appliquerGlisser(e, cote, to) {
  if (!to || !dansGrille(to.x, to.y)) return { ok: false, err: 'Cible invalide.' };
  const valides = destinations(e, axeDe(cote));
  if (!valides.some((d) => d.x === to.x && d.y === to.y))
    return { ok: false, err: 'Glissement invalide sur votre axe.' };
  deplacerPivot(e, cote, to.x, to.y);
  finDeTour(e);
  return { ok: true, action: 'glisser', to: nomCase(to.x, to.y) };
}

function appliquerVirage(e, cote, to, inv) {
  // Vérifier le stock côté partie
  if (e.stock[cote].virage <= 0) return { ok: false, err: 'Plus de virage disponible.' };
  // Vérifier le stock côté DB (anti-triche)
  if (inv && (inv.pivot || 0) < 1) return { ok: false, err: 'Inventaire insuffisant (virage).' };
  if (!to || !dansGrille(to.x, to.y)) return { ok: false, err: 'Cible invalide.' };
  const valides = destinations(e, axeDe(autre(cote)));
  if (!valides.some((d) => d.x === to.x && d.y === to.y))
    return { ok: false, err: 'Virage invalide : doit glisser sur l\'axe adverse.' };
  deplacerPivot(e, cote, to.x, to.y);
  e.stock[cote].virage -= 1;
  finDeTour(e);
  return { ok: true, action: 'virage', to: nomCase(to.x, to.y), consomme: { pivot: 1 } };
}

function appliquerDiagonale(e, cote, to, inv) {
  if (e.stock[cote].diagonale <= 0) return { ok: false, err: 'Plus de diagonale disponible.' };
  if (inv && (inv.diagonale || 0) < 1) return { ok: false, err: 'Inventaire insuffisant (diagonale).' };
  if (!to || !dansGrille(to.x, to.y)) return { ok: false, err: 'Cible invalide.' };
  const valides = destinationsDiagonale(e);
  if (!valides.some((d) => d.x === to.x && d.y === to.y))
    return { ok: false, err: 'Diagonale invalide.' };
  deplacerPivot(e, cote, to.x, to.y);
  e.stock[cote].diagonale -= 1;
  finDeTour(e);
  return { ok: true, action: 'diagonale', to: nomCase(to.x, to.y), consomme: { diagonale: 1 } };
}

function appliquerBorne(e, cote, to) {
  if (e.stock[cote].bornes <= 0) return { ok: false, err: 'Plus de bornes.' };
  if (!to || !dansGrille(to.x, to.y)) return { ok: false, err: 'Cible invalide.' };
  if (e.cases[to.y][to.x] !== null) return { ok: false, err: 'Ce point est bloqué.' };
  if (e.pivot.x === to.x && e.pivot.y === to.y) return { ok: false, err: 'Ne peut poser une borne sur le pivot.' };
  // Règle v2 : ne peut poser une borne que si on avait au moins un mouvement possible
  if (!peutBouger(e, cote)) return { ok: false, err: 'Bloqué : une borne ne sauve pas.' };
  e.cases[to.y][to.x] = { type: 'borne', cote };
  e.stock[cote].bornes -= 1;
  finDeTour(e);
  return { ok: true, action: 'borne', to: nomCase(to.x, to.y) };
}

// Téléportation seule : le pivot est déplacé sur le point cible, marqué comme visité.
// Le joueur doit ensuite déplacer le pivot (action 'tp_suite').
function appliquerTp(e, cote, to, inv) {
  if (e.stock[cote].tp <= 0) return { ok: false, err: 'Plus de téléportation disponible.' };
  if (inv && (inv.tp || 0) < 1) return { ok: false, err: 'Inventaire insuffisant (tp).' };
  if (!to || !dansGrille(to.x, to.y)) return { ok: false, err: 'Cible invalide.' };
  if (e.cases[to.y][to.x] !== null) return { ok: false, err: 'Point bloqué.' };
  if (e.pivot.x === to.x && e.pivot.y === to.y) return { ok: false, err: 'Téléportation sur place interdite.' };
  // Vérifier qu'après téléportation il aura au moins un mouvement possible
  if (!peutBougerDepuis(e, cote, to))
    return { ok: false, err: 'Téléportation interdite : aucune sortie ensuite.' };
  // Marquer le point de départ comme visité (déjà fait par deplacerPivot si on l'utilise,
  // mais ici on ne trace pas de trajet). Le pivot quitte son point : il reste bloqué.
  e.cases[e.pivot.y][e.pivot.x] = { type: 'trace', cote: e.cases[e.pivot.y][e.pivot.x] && e.cases[e.pivot.y][e.pivot.x].cote ? e.cases[e.pivot.y][e.pivot.x].cote : cote };
  // Marquer le point d'arrivée comme visité dans la couleur du joueur
  e.cases[to.y][to.x] = { type: 'trace', cote };
  e.pivot = { x: to.x, y: to.y };
  e.stock[cote].tp -= 1;
  e.enTp = true;  // le prochain coup doit être un déplacement
  e.lastMoveAt = Date.now();
  // Pas de finDeTour : on attend le déplacement obligatoire
  return { ok: true, action: 'tp', to: nomCase(to.x, to.y), consomme: { tp: 1 }, attenteDeplacement: true };
}

// Le déplacement obligatoire après une téléportation.
// `dep` = { type: 'glisser'|'virage'|'diagonale', to: {x,y} }
function appliquerTpSuite(e, cote, dep, inv) {
  if (!dep || !dep.type) return { ok: false, err: 'Déplacement manquant après tp.' };
  e.enTp = false;
  // Réutiliser les fonctions existantes, mais sans re-appeler finDeTour deux fois
  let r;
  if (dep.type === 'glisser') {
    r = appliquerGlisser(e, cote, dep.to);
  } else if (dep.type === 'virage') {
    r = appliquerVirage(e, cote, dep.to, inv);
  } else if (dep.type === 'diagonale') {
    r = appliquerDiagonale(e, cote, dep.to, inv);
  } else {
    return { ok: false, err: 'Type de déplacement après tp invalide.' };
  }
  if (!r.ok) {
    // Si le déplacement a échoué, on remet enTp à true pour ré-essayer
    e.enTp = true;
    return r;
  }
  // r.ok = true et finDeTour a déjà été appelée par la sous-fonction
  return { ok: true, action: 'tp_suite', to: r.to, consomme: r.consomme || {} };
}

function appliquerEchange(e, cote, action) {
  if (typeof action.garder !== 'boolean') return { ok: false, err: 'Choix d\'échange invalide.' };
  // C'est Bleu qui choisit (e.tour === 'B' théoriquement avant le coup 1, mais
  // le tour a déjà basculé à B après le 1er coup de R). On vérifie.
  if (e.tour !== 'B') return { ok: false, err: 'Ce n\'est pas à Bleu de choisir.' };
  if (!action.garder) {
    // Échange les noms et ids : R <-> B
    const tmpN = e.noms.R; e.noms.R = e.noms.B; e.noms.B = tmpN;
    const tmpI = e.ids.R; e.ids.R = e.ids.B; e.ids.B = tmpI;
    // Le stock suit le joueur, pas le camp — donc on échange aussi le stock
    const tmpS = e.stock.R; e.stock.R = e.stock.B; e.stock.B = tmpS;
  }
  e.attenteEchange = false;
  verifierDefaite(e);
  return { ok: true, action: 'echange', garder: action.garder };
}

function finDeTour(e) {
  e.coups += 1;
  e.tour = autre(e.tour);
  if (e.coups === 1) {
    e.attenteEchange = true;  // Bleu choisit garder/échanger
  } else {
    verifierDefaite(e);
  }
  e.lastMoveAt = Date.now();
}

// Renvoie un objet léger à envoyer aux deux clients pour mise à jour UI.
function vuePublique(e) {
  return {
    cases: e.cases,
    pivot: e.pivot,
    traits: e.traits,
    tour: e.tour,
    noms: e.noms,
    stock: e.stock,
    coups: e.coups,
    attenteEchange: e.attenteEchange,
    enTp: e.enTp,
    gagnant: e.gagnant
  };
}

module.exports = {
  appliquerCoup, appliquerGlisser, appliquerVirage, appliquerDiagonale,
  appliquerBorne, appliquerTp, appliquerTpSuite, appliquerEchange,
  finDeTour, vuePublique, peutBouger
};
