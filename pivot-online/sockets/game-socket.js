// sockets/game-socket.js — WebSockets pour matchmaking, parties privées et tournois.
//
// Events clients -> serveur:
//   - 'queue.join'   : entre dans la file de matchmaking
//   - 'queue.leave'  : quitte la file
//   - 'room.create'  : crée un salon privé
//   - 'room.join'    : rejoint un salon par code
//   - 'play.action'  : envoie une intention de coup (voir game/state.js)
//   - 'tournament.join' : s'inscrit à un tournoi
//   - 'tournament.start' : le créateur lance le tournoi
//   - 'disconnect'
//
// Events serveur -> clients:
//   - 'queue.update'   : position dans la file
//   - 'match.start'    : { matchId, role: 'R'|'B', adversaire, etat }
//   - 'match.update'   : nouvel état du plateau (vuePublique)
//   - 'match.end'      : { winner, gain/loss PC/TR/Elo, récompenses rank }
//   - 'match.error'    : erreur de validation d'un coup
//   - 'room.update'    : état du salon
//   - 'tournament.update' : état du tournoi

const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { appliquerElo } = require('../elo');
const matchmaking = require('../matchmaking');
const rules = require('../game/rules');
const state = require('../game/state');
const { verifierMontees, rangPourTR } = require('../ranks');

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';

// Maps en mémoire:
const matchsEnCours = new Map();    // matchId -> { etat, type, p1: socketId, p2: socketId, p1Id, p2Id, room_code, tournament_id }
const socketToUser = new Map();    // socketId -> { userId, pseudo, elo }
const userToSocket = new Map();    // userId -> socketId
const socketToMatch = new Map();   // socketId -> matchId
const rooms = new Map();           // code -> { host: socketId, guest: socketId, status, matchId }

function authFromToken(token) {
  try { return jwt.verify(token, JWT_SECRET()); }
  catch (e) { return null; }
}

function register(io) {
  // Middlew: authentifier chaque connexion
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Token manquant.'));
    const payload = authFromToken(token);
    if (!payload) return next(new Error('Token invalide.'));
    socket.userId = payload.id;
    socket.pseudo = payload.pseudo;
    next();
  });

  io.on('connection', (socket) => {
    console.log(`[socket] Connexion de ${socket.pseudo} (${socket.userId}).`);
    socketToUser.set(socket.id, { userId: socket.userId, pseudo: socket.pseudo });
    userToSocket.set(socket.userId, socket.id);

    // === Matchmaking ===
    socket.on('queue.join', async () => {
      // Charger l'Elo et l'inventaire de l'utilisateur
      const r = await pool.query('SELECT elo FROM users WHERE id = $1', [socket.userId]);
      if (r.rowCount === 0) return socket.emit('match.error', { error: 'Utilisateur introuvable.' });
      const elo = r.rows[0].elo;
      matchmaking.ajouter({ socketId: socket.id, userId: socket.userId, pseudo: socket.pseudo, elo });
      socket.emit('queue.update', { position: matchmaking.taille() });
      // Chercher un adversaire
      const adv = matchmaking.chercherAdversaire(socket.userId, elo);
      if (!adv) return; // patienter
      // Créer le match
      await creerMatch(io, {
        type: 'ranked',
        p1: { socketId: adv.socketId, userId: adv.userId, pseudo: adv.pseudo, elo: adv.elo },
        p2: { socketId: socket.id, userId: socket.userId, pseudo: socket.pseudo, elo }
      });
    });

    socket.on('queue.leave', () => {
      matchmaking.retirer(socket.id);
      socket.emit('queue.update', { position: 0, removed: true });
    });

    // === Salons privés ===
    socket.on('room.create', async () => {
      const code = genCode();
      const ins = await pool.query(
        `INSERT INTO private_rooms (code, host_id, status) VALUES ($1, $2, 'waiting') RETURNING code`,
        [code, socket.userId]
      );
      rooms.set(code, { host: socket.id, guest: null, status: 'waiting', matchId: null });
      socket.join('room_' + code);
      socket.emit('room.update', { code, status: 'waiting', host: true, link: '/room/' + code });
    });

    socket.on('room.join', async (data) => {
      const code = (data && data.code || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return socket.emit('room.error', { error: 'Code invalide.' });
      const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
      if (r.rowCount === 0) return socket.emit('room.error', { error: 'Salon introuvable.' });
      // Mémoriser
      if (!rooms.has(code)) {
        rooms.set(code, { host: null, guest: null, status: r.rows[0].status, matchId: null });
      }
      const room = rooms.get(code);
      if (!room.host) room.host = socket.id;
      else if (!room.guest && room.host !== socket.id) room.guest = socket.id;
      socket.join('room_' + code);
      io.to('room_' + code).emit('room.update', {
        code, status: room.status, host: room.host === socket.id, guest: room.guest === socket.id
      });
      // Si les deux joueurs sont là, lancer le match
      if (room.host && room.guest && room.status === 'waiting') {
        room.status = 'playing';
        const hostUser = socketToUser.get(room.host);
        const guestUser = socketToUser.get(room.guest);
        const e1 = await pool.query('SELECT elo FROM users WHERE id = $1', [hostUser.userId]);
        const e2 = await pool.query('SELECT elo FROM users WHERE id = $1', [guestUser.userId]);
        await creerMatch(io, {
          type: 'private',
          roomCode: code,
          p1: { socketId: room.host, userId: hostUser.userId, pseudo: hostUser.pseudo, elo: e1.rows[0].elo },
          p2: { socketId: room.guest, userId: guestUser.userId, pseudo: guestUser.pseudo, elo: e2.rows[0].elo }
        });
      }
    });

    // === Tournois ===
    socket.on('tournament.join', async (data) => {
      const id = parseInt(data && data.id, 10);
      if (!id) return socket.emit('tournament.error', { error: 'id invalide.' });
      const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
      if (r.rowCount === 0) return socket.emit('tournament.error', { error: 'Tournoi introuvable.' });
      const t = r.rows[0];
      if (t.status !== 'waiting') return socket.emit('tournament.error', { error: 'Tournoi déjà lancé.' });
      if (t.is_private) {
        const code = (data.code || '').toUpperCase();
        if (code !== t.code) return socket.emit('tournament.error', { error: 'Code incorrect.' });
      }
      await pool.query(
        `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, socket.userId]
      );
      socket.join('tournament_' + id);
      io.to('tournament_' + id).emit('tournament.update', { id, joined: socket.pseudo });
    });

    socket.on('tournament.start', async (data) => {
      const id = parseInt(data && data.id, 10);
      if (!id) return socket.emit('tournament.error', { error: 'id invalide.' });
      const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
      if (r.rowCount === 0) return socket.emit('tournament.error', { error: 'Tournoi introuvable.' });
      const t = r.rows[0];
      if (t.creator_id !== socket.userId) return socket.emit('tournament.error', { error: 'Seul le créateur peut lancer.' });
      // Effectuer le tirage + créer les matchs (réutiliser la logique de la route)
      // Pour la simplicité, on redirige vers une logique locale
      const ins = await pool.query(`SELECT user_id FROM tournament_players WHERE tournament_id = $1`, [id]);
      if (ins.rowCount < 3) return socket.emit('tournament.error', { error: 'Min 3 joueurs.' });
      const joueurs = ins.rows.map(x => x.user_id);
      let n = 1; while (n < joueurs.length) n *= 2;
      while (joueurs.length < n) joueurs.push(null);
      for (let i = joueurs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [joueurs[i], joueurs[j]] = [joueurs[j], joueurs[i]];
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE tournaments SET status = 'running' WHERE id = $1`, [id]);
        for (let i = 0; i < joueurs.length; i += 2) {
          const p1 = joueurs[i], p2 = joueurs[i + 1];
          if (p1 === null && p2 === null) continue;
          if (p1 === null) { await client.query('UPDATE tournament_players SET round_reached = 2 WHERE tournament_id = $1 AND user_id = $2', [id, p2]); continue; }
          if (p2 === null) { await client.query('UPDATE tournament_players SET round_reached = 2 WHERE tournament_id = $1 AND user_id = $2', [id, p1]); continue; }
          await client.query(
            `INSERT INTO tournament_matches (tournament_id, round, match_index, player1_id, player2_id, status)
             VALUES ($1, 1, $2, $3, $4, 'pending')`,
            [id, Math.floor(i/2), p1, p2]
          );
        }
        await client.query('COMMIT');
        io.to('tournament_' + id).emit('tournament.update', { id, started: true });
      } catch (e) {
        await client.query('ROLLBACK');
        socket.emit('tournament.error', { error: 'Erreur: ' + e.message });
      } finally {
        client.release();
      }
    });

    // === Coup de jeu ===
    socket.on('play.action', async (data) => {
      const matchId = socketToMatch.get(socket.id);
      if (!matchId) return socket.emit('match.error', { error: 'Aucune partie en cours.' });
      const m = matchsEnCours.get(matchId);
      if (!m) return socket.emit('match.error', { error: 'Partie introuvable.' });
      if (m.etat.gagnant) return socket.emit('match.error', { error: 'Partie déjà terminée.' });

      // Déterminer le camp du joueur
      let cote;
      if (m.p1Id === socket.userId) cote = 'R';
      else if (m.p2Id === socket.userId) cote = 'B';
      else return socket.emit('match.error', { error: 'Vous n\'êtes pas dans cette partie.' });

      // Vérifier l'inventaire DB
      const inv = await chargerInventaire(socket.userId);
      const r = state.appliquerCoup(m.etat, cote, data, inv);
      if (!r.ok) return socket.emit('match.error', { error: r.err });

      // Décrémenter l'inventaire en DB si une capacité a été consommée
      if (r.consomme) {
        for (const [type, qte] of Object.entries(r.consomme)) {
          await pool.query(
            `UPDATE user_inventory SET quantity = GREATEST(0, quantity - $1) WHERE user_id = $2 AND ability_type = $3`,
            [qte, socket.userId, type]
          );
        }
      }

      // Si la partie est finie, finaliser
      if (m.etat.gagnant) {
        await finirMatch(io, matchId);
      } else {
        // Sinon diffuser le nouvel état
        io.to('match_' + matchId).emit('match.update', state.vuePublique(m.etat));
      }
    });

    // === Quitter la partie volontairement ===
    // Le quitter perd par forfait. L'adversaire reçoit la MOITIÉ des gains normaux
    // et est informé par un message. Le match se termine immédiatement.
    socket.on('play.quit', async () => {
      const matchId = socketToMatch.get(socket.id);
      if (!matchId) return socket.emit('match.error', { error: 'Aucune partie en cours.' });
      const m = matchsEnCours.get(matchId);
      if (!m) return socket.emit('match.error', { error: 'Partie introuvable.' });
      if (m.etat.gagnant) return; // déjà fini

      // Le quitter est le perdant
      let cotePerdant;
      if (m.p1Id === socket.userId) cotePerdant = 'R';
      else if (m.p2Id === socket.userId) cotePerdant = 'B';
      else return socket.emit('match.error', { error: 'Vous n\'êtes pas dans cette partie.' });

      m.etat.gagnant = (cotePerdant === 'R') ? 'B' : 'R';
      m.forfait = true;
      m.quit = true; // → moitié des gains pour l'adversaire

      // Informer l'adversaire qu'il a été quitté
      const advSocketId = (cotePerdant === 'R') ? m.p2 : m.p1;
      io.to(advSocketId).emit('match.quit-notify', {
        message: 'Ton adversaire a quitté la partie. Tu reçois la moitié des gains.'
      });

      await finirMatch(io, matchId);
    });

    // === Déconnexion ===
    socket.on('disconnect', async () => {
      // Retirer de la file
      matchmaking.retirer(socket.id);
      // Marquer l'utilisateur comme déconnecté
      socketToUser.delete(socket.id);
      if (userToSocket.get(socket.userId) === socket.id) userToSocket.delete(socket.userId);
      // Gérer la déconnexion en match: laisser 60s pour revenir (simplifié: l'adversaire gagne)
      const matchId = socketToMatch.get(socket.id);
      if (matchId) {
        const m = matchsEnCours.get(matchId);
        if (m && !m.etat.gagnant) {
          // Forfait: l'adversaire gagne
          const cotePerdant = (m.p1Id === socket.userId) ? 'R' : 'B';
          m.etat.gagnant = (cotePerdant === 'R') ? 'B' : 'R';
          m.forfait = true;
          // Informer l'adversaire
          const advSocketId = (cotePerdant === 'R') ? m.p2 : m.p1;
          io.to(advSocketId).emit('match.quit-notify', {
            message: 'Ton adversaire s\'est déconnecté.'
          });
          await finirMatch(io, matchId);
        }
        socketToMatch.delete(socket.id);
      }
    });
  });
}

// Charge l'inventaire DB d'un utilisateur
async function chargerInventaire(userId) {
  const r = await pool.query(
    `SELECT ability_type, quantity FROM user_inventory WHERE user_id = $1`,
    [userId]
  );
  const inv = { tp: 0, diagonale: 0, pivot: 0 };
  for (const row of r.rows) inv[row.ability_type] = row.quantity;
  return inv;
}

// Crée un match et notifie les deux joueurs
async function creerMatch(io, opts) {
  const { type, p1, p2, roomCode, tournamentId } = opts;
  // Sauver le match en DB
  const db = await pool.query(
    `INSERT INTO matches (player1_id, player2_id, match_type, status, room_code, tournament_id)
     VALUES ($1, $2, $3, 'playing', $4, $5) RETURNING id`,
    [p1.userId, p2.userId, type, roomCode || null, tournamentId || null]
  );
  const matchId = 'm_' + db.rows[0].id;
  const etat = rules.nouvelEtat(type);
  etat.noms = { R: p1.pseudo, B: p2.pseudo };
  etat.ids = { R: p1.userId, B: p2.userId };

  // Charger l'inventaire DB des deux joueurs pour initialiser le stock de la partie
  const invP1 = await chargerInventaire(p1.userId);
  const invP2 = await chargerInventaire(p2.userId);
  // Bornes toujours 3 (gratuites). Les autres capacités viennent de l'inventaire DB.
  // Cap minimum: au moins 1 virage (règle anti-blocage).
  etat.stock.R = { bornes: 3, virage: Math.max(1, invP1.pivot || 0), tp: invP1.tp || 0, diagonale: invP1.diagonale || 0 };
  // Virage v2: max 2 par partie. On plafonne à 2 pour éviter qu'un riche joueur ait 50 virages.
  etat.stock.R.virage = Math.min(2, etat.stock.R.virage);
  etat.stock.R.tp = Math.min(1, etat.stock.R.tp);
  etat.stock.R.diagonale = Math.min(1, etat.stock.R.diagonale);
  etat.stock.B = { bornes: 3, virage: Math.min(2, Math.max(1, invP2.pivot || 0)), tp: Math.min(1, invP2.tp || 0), diagonale: Math.min(1, invP2.diagonale || 0) };

  const m = {
    dbId: db.rows[0].id,
    etat, type,
    p1: p1.socketId, p2: p2.socketId,
    p1Id: p1.userId, p2Id: p2.userId,
    invDebut: { R: invP1, B: invP2 },
    roomCode, tournamentId,
    startedAt: Date.now()
  };
  matchsEnCours.set(matchId, m);
  socketToMatch.set(p1.socketId, matchId);
  socketToMatch.set(p2.socketId, matchId);
  io.sockets.sockets.get(p1.socketId)?.join('match_' + matchId);
  io.sockets.sockets.get(p2.socketId)?.join('match_' + matchId);

  // Informer les deux
  io.to(p1.socketId).emit('match.start', {
    matchId, role: 'R', adversaire: { pseudo: p2.pseudo, elo: p2.elo },
    etat: state.vuePublique(etat),
    inventaireMoi: invP1,
    inventaireAdversaire: invP2
  });
  io.to(p2.socketId).emit('match.start', {
    matchId, role: 'B', adversaire: { pseudo: p1.pseudo, elo: p1.elo },
    etat: state.vuePublique(etat),
    inventaireMoi: invP2,
    inventaireAdversaire: invP1
  });
  io.to('match_' + matchId).emit('match.update', state.vuePublique(etat));
  return matchId;
}

// Termine un match: calcule les gains, met à jour la DB, notifie les deux joueurs
async function finirMatch(io, matchId) {
  const m = matchsEnCours.get(matchId);
  if (!m) return;
  if (m.finished) return;
  m.finished = true;

  const e = m.etat;
  const gagnantId = e.ids[e.gagnant];
  const perdantId = e.ids[(e.gagnant === 'R') ? 'B' : 'R'];

  // Calcul Elo
  const eR = await pool.query('SELECT elo, trophies, pc_balance, win_streak FROM users WHERE id = $1', [m.p1Id]);
  const eB = await pool.query('SELECT elo, trophies, pc_balance, win_streak FROM users WHERE id = $1', [m.p2Id]);
  const eloP1 = eR.rows[0].elo, eloP2 = eB.rows[0].elo;
  const scoreP1 = (e.gagnant === 'R') ? 1 : 0;
  const { newA, newB, deltaA, deltaB } = appliquerElo(eloP1, eloP2, scoreP1);

  // Calcul PC et TR selon le type de match
  let pcGagnant, pcPerdant, trGagnant, trPerdant;
  if (m.type === 'ranked') {
    pcGagnant = 15; pcPerdant = 5;
    trGagnant = 25; trPerdant = -10;
  } else if (m.type === 'private') {
    pcGagnant = 8; pcPerdant = 3;
    trGagnant = 12; trPerdant = -5;
  } else { // tournament
    pcGagnant = 15; pcPerdant = 5;
    trGagnant = 40; trPerdant = -10;
  }

  // Si l'adversaire a quitté volontairement (m.quit), il ne reçoit que la MOITIÉ des gains
  // et le perdant ne reçoit rien (pas de PC, pas de TR, juste la défaite).
  if (m.quit) {
    pcGagnant = Math.floor(pcGagnant / 2);
    trGagnant = Math.floor(trGagnant / 2);
    pcPerdant = 0;
    trPerdant = Math.floor(trPerdant / 2); // moitié de la perte
  } else if (m.forfait) {
    // Forfait (déconnexion): l'adversaire gagne normalement, le perdant a les gains de défaite normaux.
  }

  // Win streak (uniquement en ranked)
  let streakBonus = 0;
  if (m.type === 'ranked') {
    const oldStreak = eR.rows[0].win_streak; // on prend du gagnant
    const newStreak = (gagnantId === m.p1Id) ? oldStreak + 1 : 0;
    // En fait: recharger le bon
    const g = gagnantId === m.p1Id ? eR.rows[0] : eB.rows[0];
    const newStreakG = (m.forfait ? g.win_streak : g.win_streak + 1);
    streakBonus = Math.min(20, Math.max(0, newStreakG * 2) - Math.max(0, g.win_streak * 2));
    streakBonus = Math.max(0, streakBonus);
  }

  const pcGagnantFinal = pcGagnant + streakBonus;

  // Mise à jour DB
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Gagnant
    await client.query(
      `UPDATE users SET pc_balance = pc_balance + $1, trophies = GREATEST(0, trophies + $2),
       win_streak = CASE WHEN $3 = 'ranked' THEN win_streak + 1 WHEN $3 = 'tournament' THEN win_streak + 1 ELSE win_streak END,
       matches_played = matches_played + 1, matches_won = matches_won + 1,
       best_streak = GREATEST(best_streak, win_streak + 1)
       WHERE id = $4`,
      [pcGagnantFinal, trGagnant, m.type, gagnantId]
    );
    // Perdant
    await client.query(
      `UPDATE users SET pc_balance = pc_balance + $1, trophies = GREATEST(0, trophies + $2),
       win_streak = 0,
       matches_played = matches_played + 1, matches_lost = matches_lost + 1
       WHERE id = $3`,
      [pcPerdant, trPerdant, perdantId]
    );
    // Elo
    await client.query('UPDATE users SET elo = $1 WHERE id = $2', [newA, m.p1Id]);
    await client.query('UPDATE users SET elo = $1 WHERE id = $2', [newB, m.p2Id]);
    // Match
    await client.query(
      `UPDATE matches SET status = 'finished', winner_id = $1, elo_change = $2, pc_earned = $3, tr_earned = $4, finished_at = NOW() WHERE id = $5`,
      [gagnantId, deltaA, pcGagnantFinal, trGagnant, m.dbId]
    );

    // Vérifier montées de rank du gagnant
    const gagnantUser = gagnantId === m.p1Id ? eR.rows[0] : eB.rows[0];
    const oldTr = gagnantUser.trophies;
    const newTr = oldTr + trGagnant;
    const montees = await verifierMontees(gagnantId, oldTr, newTr);

    await client.query('COMMIT');

    // Notifier
    const recapGagnant = {
      winner: e.gagnant,
      pc: pcGagnantFinal, tr: trGagnant, eloDelta: (gagnantId === m.p1Id ? deltaA : deltaB),
      forfait: !!m.forfait,
      quit: !!m.quit,
      montees
    };
    const recapPerdant = {
      winner: e.gagnant,
      pc: pcPerdant, tr: trPerdant, eloDelta: (perdantId === m.p1Id ? deltaA : deltaB),
      forfait: !!m.forfait,
      quit: !!m.quit
    };
    io.to(m.p1).emit('match.end', (m.p1Id === gagnantId) ? recapGagnant : recapPerdant);
    io.to(m.p2).emit('match.end', (m.p2Id === gagnantId) ? recapGagnant : recapPerdant);
    io.to('match_' + matchId).emit('match.update', state.vuePublique(e));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[socket] finirMatch erreur:', err);
  } finally {
    client.release();
  }

  // Nettoyer
  setTimeout(() => {
    matchsEnCours.delete(matchId);
    socketToMatch.delete(m.p1);
    socketToMatch.delete(m.p2);
  }, 5000);
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { register };
