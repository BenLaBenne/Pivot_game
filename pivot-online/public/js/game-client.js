// public/js/game-client.js — Client du jeu (mode matchmaking ET salon privé)
//
// Gère le plateau SVG, les clics, les actions, le rendu, et la communication
// avec le serveur via socket.io.
// Compatible avec la page /play (ranked) et /room/:code (salon privé).

window.PIVOT = window.PIVOT || {};

// Constantes du plateau
const N = 7;
const LETTRES = 'ABCDEFG';
const PAS = 72;
const MARGE = 56;
const TAILLE = 2 * MARGE + (N - 1) * PAS;
const COULEUR = { R: '#D4342C', B: '#1D4FD7' };
const NOM_COULEUR = { R: 'Rouge', B: 'Bleu' };
const ENCRE = '#1B2430';

let etat = null;       // état public reçu du serveur
let role = null;       // 'R' ou 'B' — le camp du joueur local
let mode = 'glisser';  // action sélectionnée
let inventaireMoi = null;       // inventaire DB au début de la partie (moi)
let inventaireAdversaire = null; // inventaire DB au début de la partie (adversaire)
let adversairePseudo = null;
let adversaireElo = 0;
let dernierEtatSonJoue = null; // pour ne pas jouer le son "move" au premier render

// ==== Lobby / Matchmaking ====
PIVOT.initLobby = function() {
  const btn = document.getElementById('btn-queue');
  const btnLeave = document.getElementById('btn-leave-queue');
  const lobby = document.getElementById('lobby');
  const game = document.getElementById('game');

  // Connecter le socket
  const sock = PIVOT.connectSocket();
  if (!sock) { window.location.href = '/login'; return; }

  btn.addEventListener('click', () => {
    PIVOT.sounds && PIVOT.sounds.play('click');
    sock.emit('queue.join');
    btn.classList.add('hidden');
    btnLeave.classList.remove('hidden');
    document.getElementById('queue-msg').textContent = 'Recherche d\'un adversaire…';
    PIVOT.sounds && PIVOT.sounds.play('join');
  });
  btnLeave.addEventListener('click', () => {
    PIVOT.sounds && PIVOT.sounds.play('click');
    sock.emit('queue.leave');
    btn.classList.remove('hidden');
    btnLeave.classList.add('hidden');
    document.getElementById('queue-msg').textContent = '';
  });

  sock.on('queue.update', (data) => {
    if (data.removed) {
      btn.classList.remove('hidden');
      btnLeave.classList.add('hidden');
      document.getElementById('queue-msg').textContent = '';
      return;
    }
    document.getElementById('queue-msg').textContent = 'Dans la file… (' + data.position + ' joueur(s) en attente)';
  });

  sock.on('match.start', (data) => {
    role = data.role;
    etat = data.etat;
    inventaireMoi = data.inventaireMoi || null;
    inventaireAdversaire = data.inventaireAdversaire || null;
    adversairePseudo = data.adversaire && data.adversaire.pseudo;
    adversaireElo = data.adversaire && data.adversaire.elo;
    mode = 'glisser'; // Toujours commencer en mode Glisser
    lobby.classList.add('hidden');
    game.classList.remove('hidden');
    document.getElementById('statut').textContent =
      'Partie contre ' + adversairePseudo + ' (' + adversaireElo + ' Elo). Tu joues ' +
      (role === 'R' ? 'Rouge (horizontal)' : 'Bleu (vertical)') + '.';
    PIVOT.bindSocket(sock);
    PIVOT.bindPanel();
    PIVOT.render();
    PIVOT.sounds && PIVOT.sounds.play('join');
  });
};

// ==== Salon privé ====
PIVOT.initRoom = function(code) {
  if (PIVOT.redirectIfLoggedOut()) return;
  const sock = PIVOT.connectSocket();
  if (!sock) { window.location.href = '/login'; return; }

  PIVOT.bindSocket(sock);

  // Rejoindre le salon
  sock.emit('room.join', { code });

  sock.on('room.update', (data) => {
    const status = document.getElementById('room-status');
    if (status) status.textContent = 'Statut : ' + (data.status === 'waiting' ? 'en attente d\'un adversaire' : 'en cours');
    if (data.code) {
      const link = document.getElementById('room-link');
      if (link) {
        link.textContent = window.location.origin + '/room/' + data.code;
        link.href = '/room/' + data.code;
      }
    }
  });

  sock.on('match.start', (data) => {
    role = data.role;
    etat = data.etat;
    inventaireMoi = data.inventaireMoi || null;
    inventaireAdversaire = data.inventaireAdversaire || null;
    adversairePseudo = data.adversaire && data.adversaire.pseudo;
    adversaireElo = data.adversaire && data.adversaire.elo;
    mode = 'glisser';
    const lobby = document.getElementById('room-lobby');
    if (lobby) lobby.classList.add('hidden');
    const game = document.getElementById('game');
    if (game) game.classList.remove('hidden');
    PIVOT.bindPanel();
    PIVOT.render();
    PIVOT.sounds && PIVOT.sounds.play('join');
  });
};

// ==== Bind socket events ====
PIVOT.bindSocket = function(sock) {
  sock.on('match.update', (data) => {
    // Détection du son à jouer : si c'est mon tour qui vient de revenir, c'est que l'adversaire a joué
    if (etat && data && !etat.gagnant) {
      const ancienTour = etat.tour;
      const ancienEnTp = etat.enTp;
      const ancienCoups = etat.coups;
      // Le coup vient d'être joué par l'adversaire si data.tour !== ancienTour (tour a changé)
      // OU data.enTp === true après un tp de l'adversaire
      if (data.coups > ancienCoups && data.tour !== ancienTour) {
        PIVOT.sounds && PIVOT.sounds.play('move');
      } else if (data.coups > ancienCoups) {
        // Même joueur (tp en 2 étapes) — on joue un son tp
        PIVOT.sounds && PIVOT.sounds.play('tp');
      }
    }
    etat = data;
    // Revenir en mode Glisser après chaque coup
    mode = 'glisser';
    PIVOT.render();
  });
  sock.on('match.end', (data) => {
    PIVOT.renderFin(data);
  });
  sock.on('match.error', (data) => {
    PIVOT.sounds && PIVOT.sounds.play('error');
    PIVOT.toast(data.error, 'error');
  });
  sock.on('match.quit-notify', (data) => {
    // L'adversaire a quitté: message + on va recevoir match.end ensuite
    PIVOT.toast(data.message || 'L\'adversaire a quitté la partie.', 'error');
  });
};

// ==== Bind panneau (boutons modes) ====
PIVOT.bindPanel = function() {
  // S'assurer qu'on ne bind qu'une fois
  if (PIVOT._bound) return;
  PIVOT._bound = true;

  document.querySelectorAll('#modes button').forEach((b) => {
    b.addEventListener('click', () => {
      PIVOT.sounds && PIVOT.sounds.play('click');
      mode = b.dataset.mode;
      PIVOT.updateModeButtons();
      PIVOT.render();
    });
  });

  const btnGarder = document.getElementById('btn-garder');
  const btnEchanger = document.getElementById('btn-echanger');
  if (btnGarder) btnGarder.addEventListener('click', () => {
    PIVOT.sounds && PIVOT.sounds.play('click');
    PIVOT.envoyerEchange(true);
  });
  if (btnEchanger) btnEchanger.addEventListener('click', () => {
    PIVOT.sounds && PIVOT.sounds.play('click');
    PIVOT.envoyerEchange(false);
  });

  const plateau = document.getElementById('plateau');
  plateau.addEventListener('click', (ev) => {
    const cible = ev.target.closest('.cible');
    if (cible) PIVOT.cliquerCible(Number(cible.dataset.x), Number(cible.dataset.y));
  });
  plateau.addEventListener('mouseover', PIVOT.montrerApercu);
  plateau.addEventListener('mouseout', PIVOT.montrerApercu);
};

// ==== Rendu ====
const px = (i) => MARGE + i * PAS;
const autre = (c) => c === 'R' ? 'B' : 'R';
const axeDe = (c) => c === 'R' ? 'H' : 'V';
const dansGrille = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
const nomCase = (x, y) => LETTRES[x] + (y + 1);

function destinations(axe) {
  const dirs = axe === 'H' ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
  const out = [];
  for (const [dx, dy] of dirs) {
    let x = etat.pivot.x + dx, y = etat.pivot.y + dy;
    while (dansGrille(x, y) && etat.cases[y][x] === null) {
      out.push({ x, y });
      x += dx; y += dy;
    }
  }
  return out;
}
function destinationsDiagonale() {
  const dirs = [[-1,-1],[1,-1],[-1,1],[1,1]];
  const out = [];
  for (const [dx, dy] of dirs) {
    let x = etat.pivot.x + dx, y = etat.pivot.y + dy;
    while (dansGrille(x, y) && etat.cases[y][x] === null) {
      out.push({ x, y });
      x += dx; y += dy;
    }
  }
  return out;
}
function pointsLibres() {
  const out = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (etat.cases[y][x] === null) out.push({ x, y });
  return out;
}

PIVOT.updateModeButtons = function() {
  document.querySelectorAll('#modes button').forEach((b) => {
    b.classList.toggle('btn-vert', b.dataset.mode === mode);
  });
};

PIVOT.render = function() {
  if (!etat) return;
  PIVOT.renderPlateau();
  PIVOT.renderPanneau();
  PIVOT.renderStatut();
};

PIVOT.renderStatut = function() {
  const el = document.getElementById('statut');
  if (!el) return;
  if (etat.gagnant) {
    el.textContent = (etat.noms[etat.gagnant]) + ' gagne !';
  } else if (etat.attenteEchange) {
    el.textContent = 'Bleu doit choisir : garder ou échanger les camps.';
  } else if (etat.enTp) {
    el.textContent = 'Téléportation effectuée — déplace maintenant le pivot (glisser/virage/diagonale).';
  } else {
    const c = etat.tour;
    const qui = (c === role) ? 'À toi' : 'À l\'adversaire';
    el.textContent = qui + ' de jouer. (' + NOM_COULEUR[c] + (c === 'R' ? ' : horizontal' : ' : vertical') + ')';
  }
  // Afficher l'échange si besoin (seul Bleu choisit)
  const echange = document.getElementById('echange');
  if (echange) echange.classList.toggle('hidden', !etat.attenteEchange || role !== 'B');
};

PIVOT.renderPlateau = function() {
  const cote = etat.tour;
  const couleurTour = COULEUR[cote];
  let s = '';

  // quadrillage
  for (let i = 0; i < N; i++) {
    s += `<line x1="${px(i)}" y1="${px(0)}" x2="${px(i)}" y2="${px(N - 1)}" stroke="#C5D0DA" stroke-width="1.5"/>`;
    s += `<line x1="${px(0)}" y1="${px(i)}" x2="${px(N - 1)}" y2="${px(i)}" stroke="#C5D0DA" stroke-width="1.5"/>`;
  }
  for (let i = 0; i < N; i++) {
    s += `<text x="${px(i)}" y="${MARGE - 26}" text-anchor="middle" font-size="16" fill="#5D6B79">${LETTRES[i]}</text>`;
    s += `<text x="${px(i)}" y="${TAILLE - MARGE + 38}" text-anchor="middle" font-size="16" fill="#5D6B79">${LETTRES[i]}</text>`;
    s += `<text x="${MARGE - 34}" y="${px(i) + 5}" text-anchor="middle" font-size="16" fill="#5D6B79">${i + 1}</text>`;
    s += `<text x="${TAILLE - MARGE + 34}" y="${px(i) + 5}" text-anchor="middle" font-size="16" fill="#5D6B79">${i + 1}</text>`;
  }
  for (const t of etat.traits) {
    s += `<line x1="${px(t.x1)}" y1="${px(t.y1)}" x2="${px(t.x2)}" y2="${px(t.y2)}" stroke="${COULEUR[t.cote]}" stroke-width="7" stroke-linecap="round" opacity="0.85"/>`;
  }
  s += `<line id="apercu" x1="0" y1="0" x2="0" y2="0" stroke="${couleurTour}" stroke-width="7" stroke-linecap="round" opacity="0.35" visibility="hidden"/>`;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = etat.cases[y][x];
      if (c === null) {
        s += `<circle cx="${px(x)}" cy="${px(y)}" r="4" fill="#8795A3"/>`;
      } else if (c.type === 'trace') {
        const col = c.cote ? COULEUR[c.cote] : ENCRE;
        s += `<circle cx="${px(x)}" cy="${px(y)}" r="6" fill="${col}"/>`;
      } else { // borne
        const col = COULEUR[c.cote];
        const a = 11;
        s += `<g stroke="${col}" stroke-width="5" stroke-linecap="round">` +
             `<line x1="${px(x) - a}" y1="${px(y) - a}" x2="${px(x) + a}" y2="${px(y) + a}"/>` +
             `<line x1="${px(x) - a}" y1="${px(y) + a}" x2="${px(x) + a}" y2="${px(y) - a}"/></g>`;
      }
    }
  }

  // Cibles cliquables : uniquement si c'est mon tour
  const monTour = (cote === role) && !etat.gagnant && !etat.attenteEchange;
  if (monTour || (etat.attenteEchange && role === 'B')) {
    let cibles = [];
    if (etat.attenteEchange) {
      // pas de cibles, juste les boutons garder/échanger
    } else if (etat.enTp) {
      // après tp: on doit déplacer (glisser par défaut)
      let m = mode;
      if (m === 'tp' || m === 'borne') m = 'glisser';
      if (m === 'glisser') cibles = destinations(axeDe(cote));
      else if (m === 'virage') cibles = destinations(axeDe(autre(cote)));
      else if (m === 'diagonale') cibles = destinationsDiagonale();
    } else {
      if (mode === 'glisser') cibles = destinations(axeDe(cote));
      else if (mode === 'virage') cibles = destinations(axeDe(autre(cote)));
      else if (mode === 'diagonale') cibles = destinationsDiagonale();
      else if (mode === 'borne') cibles = pointsLibres();
      else if (mode === 'tp') cibles = pointsLibres().filter(p => !(p.x === etat.pivot.x && p.y === etat.pivot.y));
    }
    for (const d of cibles) {
      s += `<g class="cible" data-x="${d.x}" data-y="${d.y}">` +
           `<circle class="halo-cible" cx="${px(d.x)}" cy="${px(d.y)}" r="17" fill="${couleurTour}" fill-opacity="0.15" stroke="${couleurTour}" stroke-width="2.5" stroke-dasharray="4 3"/>` +
           `<circle cx="${px(d.x)}" cy="${px(d.y)}" r="30" fill="transparent"/></g>`;
    }
  }

  // pivot
  s += `<circle class="pulse" cx="${px(etat.pivot.x)}" cy="${px(etat.pivot.y)}" r="24" fill="${couleurTour}" opacity="0.3"/>`;
  s += `<circle cx="${px(etat.pivot.x)}" cy="${px(etat.pivot.y)}" r="14" fill="${ENCRE}"/>`;
  s += `<circle cx="${px(etat.pivot.x)}" cy="${px(etat.pivot.y)}" r="5" fill="#F7F9FB"/>`;

  document.getElementById('plateau').innerHTML =
    `<svg viewBox="0 0 ${TAILLE} ${TAILLE}">${s}</svg>`;
};

// Affiche une carte d'inventaire (moi ou adversaire).
// `cardEl` : élément DOM de la carte
// `coteCamp` : 'R' ou 'B' (camp du joueur concerné)
// `estMoi` : true si c'est mon inventaire
PIVOT.renderCarteInventaire = function(cardEl, coteCamp, estMoi) {
  if (!cardEl || !etat) return;
  const s = etat.stock[coteCamp];
  const actif = etat.tour === coteCamp && !etat.gagnant;
  cardEl.classList.toggle('actif', actif);
  // Couleur de pastille selon le camp
  const pastille = cardEl.querySelector('.pastille');
  if (pastille) pastille.style.background = COULEUR[coteCamp];
  // Couleur de la bordure si actif
  if (actif) {
    cardEl.classList.add(coteCamp);
    cardEl.style.borderColor = COULEUR[coteCamp];
    cardEl.style.boxShadow = `0 4px 0 ${COULEUR[coteCamp]}`;
  } else {
    cardEl.classList.remove('R', 'B');
    cardEl.style.borderColor = '';
    cardEl.style.boxShadow = '';
  }
  // Nom + info camp
  const nom = cardEl.querySelector('.nom');
  if (nom) {
    if (estMoi) {
      nom.textContent = 'Moi (' + NOM_COULEUR[coteCamp] + ')';
    } else {
      nom.textContent = (adversairePseudo || 'Adversaire') + ' (' + NOM_COULEUR[coteCamp] + ')';
    }
  }
  const campInfo = cardEl.querySelector('.camp-info');
  if (campInfo) campInfo.textContent = coteCamp === 'R' ? '↔ horizontal' : '↕ vertical';

  // Inventaire affiché : capacité restante dans la partie / capacité de départ (DB)
  const invDebut = estMoi ? inventaireMoi : inventaireAdversaire;
  const invDebutPivot = invDebut ? (invDebut.pivot || 0) : '?';
  const invDebutTp = invDebut ? (invDebut.tp || 0) : '?';
  const invDebutDiag = invDebut ? (invDebut.diagonale || 0) : '?';

  const stock = cardEl.querySelector('.stock');
  if (stock) {
    stock.innerHTML =
      `<span class="stock-item">❌ Bornes: <span class="pts">${'●'.repeat(s.bornes)}${'○'.repeat(3 - s.bornes)}</span></span>` +
      `<span class="stock-item">🔄 Virage: ${s.virage}/${invDebutPivot}</span>` +
      `<span class="stock-item">⚡ TP: ${s.tp}/${invDebutTp}</span>` +
      `<span class="stock-item">↗️ Diag: ${s.diagonale}/${invDebutDiag}</span>`;
  }
};

PIVOT.renderPanneau = function() {
  // Afficher deux cartes : Moi (card-me) + Adversaire (card-adv)
  const monCamp = role;
  const advCamp = autre(role);
  PIVOT.renderCarteInventaire(document.getElementById('card-me'), monCamp, true);
  PIVOT.renderCarteInventaire(document.getElementById('card-adv'), advCamp, false);
  // Aide
  const aide = document.getElementById('aide');
  const aides = {
    glisser: 'Clique un point surligné pour glisser sur ton axe.',
    borne: 'Clique un point libre pour y poser une borne. Le pivot ne bouge pas.',
    virage: 'Virage : glisse sur l\'axe adverse. Coûte 1 virage.',
    diagonale: 'Diagonale : glisse en diagonale. Coûte 1 diagonale.',
    tp: 'Téléportation : clique un point libre n\'importe où, puis déplace le pivot.'
  };
  if (aide) aide.textContent = aides[mode] || '';
  PIVOT.updateModeButtons();
};

// ==== Clic sur une cible ====
PIVOT.cliquerCible = function(x, y) {
  if (!etat || etat.gagnant) return;
  if (etat.attenteEchange) return;
  if (etat.tour !== role) { PIVOT.toast('Ce n\'est pas ton tour.', 'error'); return; }

  const sock = PIVOT._socket;
  if (!sock) return;
  const cote = role;

  // Cas TP en attente
  if (etat.enTp) {
    let depType = mode;
    if (depType === 'tp' || depType === 'borne') depType = 'glisser';
    sock.emit('play.action', { type: 'tp_suite', deplacement: { type: depType, to: { x, y } } });
    PIVOT.sounds && PIVOT.sounds.play(depType === 'virage' ? 'virage' : (depType === 'diagonale' ? 'diagonale' : 'move'));
    return;
  }

  if (mode === 'borne') {
    sock.emit('play.action', { type: 'borne', to: { x, y } });
    PIVOT.sounds && PIVOT.sounds.play('borne');
    return;
  }
  if (mode === 'tp') {
    sock.emit('play.action', { type: 'tp', to: { x, y } });
    PIVOT.sounds && PIVOT.sounds.play('tp');
    return;
  }
  // glisser, virage, diagonale
  sock.emit('play.action', { type: mode, to: { x, y } });
  PIVOT.sounds && PIVOT.sounds.play(mode === 'virage' ? 'virage' : (mode === 'diagonale' ? 'diagonale' : 'move'));
  // Revenir en mode Glisser après envoi du coup (sera reaffiné si le serveur confirme)
  mode = 'glisser';
};

PIVOT.envoyerEchange = function(garder) {
  const sock = PIVOT._socket;
  if (!sock) return;
  sock.emit('play.action', { type: 'echange', garder });
};

PIVOT.montrerApercu = function(ev) {
  const apercu = document.getElementById('apercu');
  if (!apercu || !etat) return;
  const cible = ev.target.closest ? ev.target.closest('.cible') : null;
  if (cible && mode !== 'borne' && mode !== 'tp') {
    apercu.setAttribute('x1', px(etat.pivot.x));
    apercu.setAttribute('y1', px(etat.pivot.y));
    apercu.setAttribute('x2', px(Number(cible.dataset.x)));
    apercu.setAttribute('y2', px(Number(cible.dataset.y)));
    apercu.setAttribute('visibility', 'visible');
  } else {
    apercu.setAttribute('visibility', 'hidden');
  }
};

// ==== Écran de fin style Brawl Stars ====
PIVOT.renderFin = function(data) {
  // Son de fin
  if (etat && etat.gagnant === role) {
    PIVOT.sounds && PIVOT.sounds.play('win');
    if (data.montees && data.montees.length) {
      setTimeout(() => PIVOT.sounds && PIVOT.sounds.play('rankup'), 800);
    }
  } else {
    PIVOT.sounds && PIVOT.sounds.play('lose');
  }

  // BUG FIX : utiliser data.winner (envoyé par le serveur) plutôt que etat.gagnant
  // car match.end arrive AVANT le match.update qui mettrait à jour etat.gagnant.
  const gagnantCote = data.winner || (etat && etat.gagnant) || null;
  const won = (gagnantCote === role);

  // Inventaire DB réel (envoyé par le serveur, rafraîchi à la fin du match).
  // data.inventaireMoi et data.inventaireAdversaire sont les vrais stocks DB
  // (post-consommation des capacités utilisées pendant la partie).
  const monInvDB = data.inventaireMoi || { tp: '?', diagonale: '?', pivot: '?' };
  const advInvDB = data.inventaireAdversaire || { tp: '?', diagonale: '?', pivot: '?' };

  // Construire un écran de fin plein écran par-dessus la page
  // On retire un éventuel précédent
  const old = document.getElementById('end-screen');
  if (old) old.remove();

  const reasonText = data.forfait
    ? (won ? 'Victoire par forfait' : 'Perdu par forfait (déconnexion ou abandon)')
    : (won ? 'L\'adversaire est bloqué !' : 'Tu es bloqué — plus aucun mouvement.');

  // En-tête VICTOIRE / DÉFAITE
  const titleColor = won ? '#06D6A0' : '#E63946';
  const titleText = won ? 'VICTOIRE' : 'DÉFAITE';

  // Récompenses
  let recH = '';
  if (typeof data.pc === 'number') recH += `<div class="reward-line"><span class="reward-icon">🪙</span><span class="reward-amount">${data.pc >= 0 ? '+' : ''}${data.pc} PC</span></div>`;
  if (typeof data.tr === 'number') recH += `<div class="reward-line"><span class="reward-icon">🏆</span><span class="reward-amount">${data.tr >= 0 ? '+' : ''}${data.tr} TR</span></div>`;
  if (typeof data.eloDelta === 'number') recH += `<div class="reward-line"><span class="reward-icon">🎯</span><span class="reward-amount">${data.eloDelta >= 0 ? '+' : ''}${data.eloDelta} Elo</span></div>`;
  if (data.montees && data.montees.length) {
    recH += '<div class="rankup-block">';
    recH += '<div class="rankup-title">⭐ MONTÉE DE RANK !</div>';
    for (const m of data.montees) {
      recH += `<div class="rankup-line">→ ${escapeHtml(m.rang)} (${escapeHtml(m.recompenses || '')})</div>`;
    }
    recH += '</div>';
  }

  // Inventaire DB réel — affiché côte à côte
  function invHtml(inv, label) {
    return `<div class="inv-end">
      <div class="inv-end-label">${escapeHtml(label)}</div>
      <div class="inv-end-grid">
        <div class="inv-end-item"><div class="icon">🔄</div><div>${inv.pivot !== undefined ? inv.pivot : '?'} virages</div></div>
        <div class="inv-end-item"><div class="icon">⚡</div><div>${inv.tp !== undefined ? inv.tp : '?'} TP</div></div>
        <div class="inv-end-item"><div class="icon">↗️</div><div>${inv.diagonale !== undefined ? inv.diagonale : '?'} diag</div></div>
      </div>
    </div>`;
  }

  const end = document.createElement('div');
  end.id = 'end-screen';
  end.className = 'end-screen';
  end.innerHTML = `
    <div class="end-card">
      <div class="end-title" style="color:${titleColor};text-shadow:3px 3px 0 rgba(0,0,0,0.4);">${titleText}</div>
      <div class="end-subtitle">${won ? 'Tu remportes la partie !' : ((adversairePseudo || 'Adversaire') + ' gagne')}</div>
      <div class="end-reason">${escapeHtml(reasonText)}</div>

      <div class="end-section">
        <div class="end-section-title">Récompenses</div>
        ${recH || '<div class="muted">Aucune récompense.</div>'}
      </div>

      <div class="end-section">
        <div class="end-section-title">Inventaire</div>
        <div class="end-inv-row">
          ${invHtml(monInvDB, 'Moi')}
          ${invHtml(advInvDB, adversairePseudo || 'Adversaire')}
        </div>
      </div>

      <div class="end-buttons">
        <button class="btn btn-large" onclick="window.location.href='/'">🏠 Menu</button>
        <button class="btn btn-vert btn-large" onclick="window.location.href='/play'">🔄 Rejouer</button>
      </div>
    </div>
  `;
  document.body.appendChild(end);

  // Confettis si on a gagné
  if (won) PIVOT.lancerConfettis();
};

// Confettis
PIVOT.lancerConfettis = function() {
  const cont = document.createElement('div');
  cont.className = 'confetti-container';
  document.body.appendChild(cont);
  const colors = ['#FFC107', '#FF6B35', '#06D6A0', '#9B5DE5', '#E63946', '#5BC0EB'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 0.5) + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    cont.appendChild(p);
  }
  setTimeout(() => cont.remove(), 3500);
};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
