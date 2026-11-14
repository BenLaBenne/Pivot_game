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
let enTp = false;      // tp local en cours (en attente du 2e coup)
let tpPending = null;  // { to } en attente d'envoi au serveur

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
    sock.emit('queue.join');
    btn.classList.add('hidden');
    btnLeave.classList.remove('hidden');
    document.getElementById('queue-msg').textContent = 'Recherche d\'un adversaire…';
  });
  btnLeave.addEventListener('click', () => {
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
    enTp = false; tpPending = null;
    lobby.classList.add('hidden');
    game.classList.remove('hidden');
    document.getElementById('statut').textContent =
      'Partie contre ' + data.adversaire.pseudo + ' (' + data.adversaire.elo + ' Elo). Tu joues ' +
      (role === 'R' ? 'Rouge (horizontal)' : 'Bleu (vertical)') + '.';
    PIVOT.bindSocket(sock);
    PIVOT.bindPanel();
    PIVOT.render();
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
      if (link) link.textContent = window.location.origin + '/room/' + data.code;
    }
  });

  sock.on('match.start', (data) => {
    role = data.role;
    etat = data.etat;
    enTp = false; tpPending = null;
    const lobby = document.getElementById('room-lobby');
    if (lobby) lobby.classList.add('hidden');
    const game = document.getElementById('game');
    if (game) game.classList.remove('hidden');
    PIVOT.bindPanel();
    PIVOT.render();
  });
};

// ==== Bind socket events ====
PIVOT.bindSocket = function(sock) {
  sock.on('match.update', (data) => {
    etat = data;
    PIVOT.render();
  });
  sock.on('match.end', (data) => {
    PIVOT.renderFin(data);
  });
  sock.on('match.error', (data) => {
    PIVOT.toast(data.error, 'error');
  });
};

// ==== Bind panneau (boutons modes) ====
PIVOT.bindPanel = function() {
  // S'assurer qu'on ne bind qu'une fois
  if (PIVOT._bound) return;
  PIVOT._bound = true;

  document.querySelectorAll('#modes button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      PIVOT.updateModeButtons();
      PIVOT.render();
    });
  });

  const btnGarder = document.getElementById('btn-garder');
  const btnEchanger = document.getElementById('btn-echanger');
  if (btnGarder) btnGarder.addEventListener('click', () => PIVOT.envoyerEchange(true));
  if (btnEchanger) btnEchanger.addEventListener('click', () => PIVOT.envoyerEchange(false));

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
    el.textContent = 'À ' + etat.noms[c] + ' de jouer. (' + NOM_COULEUR[c] + (c === 'R' ? ' : horizontal' : ' : vertical') + ')';
  }
  // Afficher l'échange si besoin
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
  if (monTour || etat.attenteEchange && role === 'B') {
    let cibles = [];
    if (etat.attenteEchange) {
      // pas de cibles, juste les boutons garder/échanger
    } else if (etat.enTp) {
      // après tp: on doit déplacer
      if (mode === 'glisser') cibles = destinations(axeDe(cote));
      else if (mode === 'virage') cibles = destinations(axeDe(autre(cote)));
      else if (mode === 'diagonale') cibles = destinationsDiagonale();
      else cibles = [];  // pas de tp ni borne en mode tp-suite
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

PIVOT.renderPanneau = function() {
  const cote = etat.tour;
  for (const c of ['R', 'B']) {
    const card = document.getElementById('card-' + c);
    if (!card) continue;
    card.classList.toggle('actif', cote === c && !etat.gagnant);
    card.querySelector('.nom').textContent = etat.noms[c] + ' (' + NOM_COULEUR[c] + ')';
    const s = etat.stock[c];
    const stock = card.querySelector('.stock');
    stock.innerHTML =
      `<span class="stock-item">❌ Bornes: <span class="pts">${'●'.repeat(s.bornes)}${'○'.repeat(3 - s.bornes)}</span></span>` +
      `<span class="stock-item">🔄 Virage: ${s.virage}/2</span>` +
      `<span class="stock-item">⚡ TP: ${s.tp}/1</span>` +
      `<span class="stock-item">↗️ Diag: ${s.diagonale}/1</span>`;
  }
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
    // Le prochain clic est le déplacement après tp
    // On détermine si c'est un glisser/virage/diagonale selon le mode sélectionné
    let depType = mode;
    if (depType === 'tp' || depType === 'borne') depType = 'glisser';
    sock.emit('play.action', { type: 'tp_suite', deplacement: { type: depType, to: { x, y } } });
    return;
  }

  if (mode === 'borne') {
    sock.emit('play.action', { type: 'borne', to: { x, y } });
    return;
  }
  if (mode === 'tp') {
    // Envoyer tp, puis le serveur garde en attente du déplacement
    sock.emit('play.action', { type: 'tp', to: { x, y } });
    return;
  }
  // glisser, virage, diagonale
  sock.emit('play.action', { type: mode, to: { x, y } });
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

// ==== Fin de partie ====
PIVOT.renderFin = function(data) {
  // Construire un voile au-dessus du plateau
  const voile = document.createElement('div');
  voile.className = 'voile';
  let h = '<h2>' + (etat && etat.noms[etat.gagnant] || 'Partie') + '</h2>';
  h += '<p>' + (data.forfait ? 'Victoire par forfait (déconnexion).' : 'Le perdant est bloqué.') + '</p>';
  h += '<div class="recap">';
  if (typeof data.pc === 'number') h += `<div>🪙 ${data.pc >= 0 ? '+' : ''}${data.pc} PC</div>`;
  if (typeof data.tr === 'number') h += `<div>🏆 ${data.tr >= 0 ? '+' : ''}${data.tr} TR</div>`;
  if (typeof data.eloDelta === 'number') h += `<div>🎯 ${data.eloDelta >= 0 ? '+' : ''}${data.eloDelta} Elo</div>`;
  if (data.montees && data.montees.length) {
    h += '<div style="color:var(--jaune);font-family:Lilita One,cursive;margin-top:8px;">MONTÉES DE RANK!</div>';
    for (const m of data.montees) {
      h += `<div>→ ${m.rang} (${m.recompenses})</div>`;
    }
  }
  h += '</div>';
  h += '<button class="btn" onclick="window.location.href=\'/\'">Retour à l\'accueil</button>';
  h += '<button class="btn btn-vert" onclick="window.location.href=\'/play\'">Rejouer</button>';
  voile.innerHTML = h;
  // Confettis si on a gagné
  if (data.pc > 0 && etat && etat.gagnant === role) PIVOT.lancerConfettis();
  // Insérer le voile dans le plateau parent
  const plateau = document.getElementById('plateau');
  plateau.style.position = 'relative';
  plateau.appendChild(voile);
};

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
