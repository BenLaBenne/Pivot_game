// sockets/game-socket.js — WebSockets pour matchmaking, parties privées et tournois.
//
// Events clients -> serveur:
//   - 'queue.join'   : entre dans la file de matchmaking
//   - 'queue.leave'  : quitte la file
//   - 'room.create'  : crée un salon privé
//   - 'room.join'    : rejoint un salon par code
//   - 'room.leave'   : quitte le salon (et le supprime si vide)
//   - 'play.action'  : envoie une intention de coup (voir game/state.js)
//   - 'play.quit'    : abandonne la partie (l'adversaire reçoit la moitié des gains)
//   - 'tournament.join'    : s'inscrit à un tournoi
//   - 'tournament.leave'   : se désinscrit d'un tournoi (et le supprime si vide)
//   - 'tournament.start'   : le créateur lance le tournoi
//   - 'disconnect'         : déconnexion propre + forfait match en cours
//
// Events serveur -> clients:
//   - 'queue.update'   : position dans la file
//   - 'match.start'    : { matchId, role, adversaire, etat, inventaireMoi, inventaireAdversaire }
//   - 'match.update'   : nouvel état du plateau (vuePublique)
//   - 'match.end'      : { winner, pc, tr, eloDelta, montees, forfait, quit, inventaireMoi, inventaireAdversaire }
//   - 'match.error'    : erreur de validation d'un coup
//   - 'match.quit-notify' : { message } informe l'adversaire qu'il a été quitté
//   - 'room.update'    : état du salon
//   - 'room.closed'    : le salon a été supprimé (vide ou host parti)
//   - 'tournament.update' : état du tournoi
//   - 'tournament.closed'  : le tournoi a été supprimé (vide ou creator parti)

const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { appliquerElo } = require('../elo');
const matchmaking = require('../matchmaking');
const rules = require('../game/rules');
const state = require('../game/state');
const { verifierMontees, rangPourTR } = require('../ranks');

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';

// Maps en mémoire:
const matchsEnCours = new Map();    // matchId -> { etat, type, p1, p2, p1Id, p2Id, roomCode, tournamentId, ... }
const socketToUser = new Map();    // socketId -> { userId, pseudo, elo }
const userToSocket = new Map();    // userId -> socketId
const socketToMatch = new Map();   // socketId -> matchId
const rooms = new Map();           // code -> { host: socketId, guest: socketId, status, matchId, hostId, guestId }
const socketRooms = new Map();     // socketId -> Set de codes de salons rejoints
const socketTournaments = new Map(); // socketId -> Set de tournois rejoints

function authFromToken(token) {
  try { return jwt.verify(token, JWT_SECRET()); }
  catch (e) { return null; }
}

// Marque un salon comme "finished" et le supprime (DB + mémoire).
// Tous les sockets encore dans le salon sont notifiés par 'room.closed'.
async function closeRoom(io, code, reason) {
  try {
    await pool.query(`DELETE FROM private_rooms WHERE code = $1`, [code]);
  } catch (e) { console.error('[room] closeRoom DB:', e); }
  rooms.delete(code);
  // Notifier les sockets encore dans le salon
  io.to('room_' + code).emit('room.closed', { code, reason: reason || 'Salon fermé.' });
  // Nettoyer les mappings socketRooms
  for (const [sid, codes] of socketRooms.entries()) {
    if (codes && codes.has(code)) {
      codes.delete(code);
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave('room_' + code);
    }
  }
}

// Supprime un tournoi de la DB + mémoire. Notifie les inscrits encore connectés.
// Utilisé quand le tournoi devient vide (creator parti + aucun inscrit) ou quand
// tous les matchs sont finis (simplifié ici: on le garde en DB pour l'historique).
async function deleteTournament(io, tournamentId, reason) {
  try {
    // Supprimer en cascade (tournament_players, tournament_matches)
    await pool.query(`DELETE FROM tournament_matches WHERE tournament_id = $1`, [tournamentId]);
    await pool.query(`DELETE FROM tournament_players WHERE tournament_id = $1`, [tournamentId]);
    await pool.query(`DELETE FROM tournaments WHERE id = $1`, [tournamentId]);
  } catch (e) { console.error('[tournament] deleteTournament DB:', e); }
  // Notifier les inscrits encore connectés
  io.to('tournament_' + tournamentId).emit('tournament.closed', {
    id: tournamentId, reason: reason || 'Tournoi supprimé.'
  });
  // Nettoyer socketTournaments
  for (const [sid, tids] of socketTournaments.entries()) {
    if (tids && tids.has(tournamentId)) {
      tids.delete(tournamentId);
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave('tournament_' + tournamentId);
    }
  }
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
    socketRooms.set(socket.id, new Set());
    socketTournaments.set(socket.id, new Set());

    // Room par utilisateur — permet d'émettre vers un user même après reconnexion
    // (le nouveau socket rejoindra automatiquement cette room à la connexion).
    socket.join('user_' + socket.userId);

    // === Matchmaking ===
    socket.on('queue.join', async () => {
      const r = await pool.query('SELECT elo FROM users WHERE id = $1', [socket.userId]);
      if (r.rowCount === 0) return socket.emit('match.error', { error: 'Utilisateur introuvable.' });
      const elo = r.rows[0].elo;
      matchmaking.ajouter({ socketId: socket.id, userId: socket.userId, pseudo: socket.pseudo, elo });
      socket.emit('queue.update', { position: matchmaking.taille() });
      const adv = matchmaking.chercherAdversaire(socket.userId, elo);
      if (!adv) return;
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
      try {
        await pool.query(
          `INSERT INTO private_rooms (code, host_id, status) VALUES ($1, $2, 'waiting')`,
          [code, socket.userId]
        );
      } catch (e) {
        return socket.emit('room.error', { error: 'Erreur création salon.' });
      }
      rooms.set(code, {
        host: socket.id, hostId: socket.userId,
        guest: null, guestId: null,
        status: 'waiting', matchId: null
      });
      socket.join('room_' + code);
      socketRooms.get(socket.id).add(code);
      socket.emit('room.update', { code, status: 'waiting', host: true, link: '/room/' + code });
    });

    socket.on('room.join', async (data) => {
      const code = (data && data.code || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return socket.emit('room.error', { error: 'Code invalide.' });
      const r = await pool.query(`SELECT * FROM private_rooms WHERE code = $1`, [code]);
      if (r.rowCount === 0) return socket.emit('room.error', { error: 'Salon introuvable.' });
      if (!rooms.has(code)) {
        rooms.set(code, { host: null, hostId: null, guest: null, guestId: null, status: r.rows[0].status, matchId: null });
      }
      const room = rooms.get(code);
      // Si on est l'host qui revient (reconnexion), reprendre son rôle
      if (room.hostId === socket.userId) room.host = socket.id;
      else if (room.guestId === socket.userId) room.guest = socket.id;
      // Sinon, on est un nouvel invité
      else if (!room.host) { room.host = socket.id; room.hostId = socket.userId; }
      else if (!room.guest && room.hostId !== socket.userId) {
        room.guest = socket.id; room.guestId = socket.userId;
      } else {
        return socket.emit('room.error', { error: 'Salon complet.' });
      }
      socket.join('room_' + code);
      socketRooms.get(socket.id).add(code);
      io.to('room_' + code).emit('room.update', {
        code, status: room.status,
        host: room.host === socket.id, guest: room.guest === socket.id
      });
      // Si les deux sont là et qu'on n'a pas encore lancé, lancer le match
      if (room.host && room.guest && room.status === 'waiting') {
        room.status = 'playing';
        const hostUser = socketToUser.get(room.host);
        const guestUser = socketToUser.get(room.guest);
        const e1 = await pool.query('SELECT elo FROM users WHERE id = $1', [hostUser.userId]);
        const e2 = await pool.query('SELECT elo FROM users WHERE id = $1', [guestUser.userId]);
        try {
          await creerMatch(io, {
            type: 'private',
            roomCode: code,
            p1: { socketId: room.host, userId: hostUser.userId, pseudo: hostUser.pseudo, elo: e1.rows[0].elo },
            p2: { socketId: room.guest, userId: guestUser.userId, pseudo: guestUser.pseudo, elo: e2.rows[0].elo }
          });
        } catch (e) {
          console.error('[room] match creation error:', e);
          socket.emit('room.error', { error: 'Erreur lors du lancement du match.' });
        }
      }
    });

    // Quitter volontairement un salon (bouton "Quitter")
    socket.on('room.leave', async (data) => {
      const code = (data && data.code || '').toUpperCase();
      if (!code) return;
      const room = rooms.get(code);
      socket.leave('room_' + code);
      const codes = socketRooms.get(socket.id);
      if (codes) codes.delete(code);

      if (!room) return;

      const wasHost = (room.hostId === socket.userId);
      const wasGuest = (room.guestId === socket.userId);

      if (wasHost) {
        // L'host quitte → fermer le salon (pas de salon sans host)
        await closeRoom(io, code, 'L\'hôte a fermé le salon.');
      } else if (wasGuest) {
        // L'invité quitte → revenir en 'waiting', libérer la place
        room.guest = null;
        room.guestId = null;
        if (room.status === 'playing') room.status = 'waiting';
        await pool.query(`UPDATE private_rooms SET status = 'waiting' WHERE code = $1`, [code]);
        io.to('room_' + code).emit('room.update', {
          code, status: room.status, host: false, guest: false,
          guestLeft: true
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
      // Vérifier la capacité
      const nb = await pool.query('SELECT COUNT(*)::int AS n FROM tournament_players WHERE tournament_id = $1', [id]);
      if (nb.rows[0].n >= t.max_players) return socket.emit('tournament.error', { error: 'Tournoi plein.' });
      await pool.query(
        `INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, socket.userId]
      );
      socket.join('tournament_' + id);
      socketTournaments.get(socket.id).add(id);
      // Broadcaster la liste mise à jour
      const inscrits = await pool.query(
        `SELECT u.pseudo FROM tournament_players tp JOIN users u ON u.id = tp.user_id WHERE tp.tournament_id = $1`,
        [id]
      );
      io.to('tournament_' + id).emit('tournament.update', {
        id, joined: socket.pseudo,
        inscrits: inscrits.rows.map(r => r.pseudo)
      });
    });

    // Quitter volontairement un tournoi (bouton "Quitter")
    // Si c'est le créateur qui quitte AVANT le lancement, le tournoi est supprimé.
    // Si c'est un joueur, il est désinscrit. Si plus aucun inscrit, supprimer aussi.
    socket.on('tournament.leave', async (data) => {
      const id = parseInt(data && data.id, 10);
      if (!id) return;
      const t = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
      if (t.rowCount === 0) return;
      const tournoi = t.rows[0];

      // Si tournoi déjà lancé (running), on ne peut plus quitter normalement
      // (les matchs en cours sont forfait — géré par play.quit/disconnect).
      // Pour simplifier, on permet seulement la désinscription tant que le tournoi est 'waiting'.
      if (tournoi.status !== 'waiting') {
        return socket.emit('tournament.error', { error: 'Tournoi déjà lancé : tu ne peux plus te désinscrire. Abandonne tes matchs si nécessaire.' });
      }

      await pool.query(`DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`, [id, socket.userId]);
      socket.leave('tournament_' + id);
      socketTournaments.get(socket.id).delete(id);

      // Recharger la liste des inscrits
      const restants = await pool.query(
        `SELECT u.pseudo FROM tournament_players tp JOIN users u ON u.id = tp.user_id WHERE tp.tournament_id = $1`,
        [id]
      );

      // Cas 1 : le créateur a quitté → supprimer le tournoi (personne ne peut le lancer)
      if (tournoi.creator_id === socket.userId) {
        await deleteTournament(io, id, 'Le créateur a supprimé le tournoi.');
        return;
      }

      // Cas 2 : plus aucun inscrit → supprimer
      if (restants.rowCount === 0) {
        await deleteTournament(io, id, 'Tournoi vide : supprimé.');
        return;
      }

      // Cas 3 : il reste des inscrits → notifier
      io.to('tournament_' + id).emit('tournament.update', {
        id, left: socket.pseudo,
        inscrits: restants.rows.map(r => r.pseudo)
      });
    });

    socket.on('tournament.start', async (data) => {
      const id = parseInt(data && data.id, 10);
      if (!id) return socket.emit('tournament.error', { error: 'id invalide.' });
      const r = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [id]);
      if (r.rowCount === 0) return socket.emit('tournament.error', { error: 'Tournoi introuvable.' });
      const t = r.rows[0];
      if (t.creator_id !== socket.userId) return socket.emit('tournament.error', { error: 'Seul le créateur peut lancer.' });
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

      let cote;
      if (m.p1Id === socket.userId) cote = 'R';
      else if (m.p2Id === socket.userId) cote = 'B';
      else return socket.emit('match.error', { error: 'Vous n\'êtes pas dans cette partie.' });

      const inv = await chargerInventaire(socket.userId);
      const r = state.appliquerCoup(m.etat, cote, data, inv);
      if (!r.ok) return socket.emit('match.error', { error: r.err });

      if (r.consomme) {
        for (const [type, qte] of Object.entries(r.consomme)) {
          await pool.query(
            `UPDATE user_inventory SET quantity = GREATEST(0, quantity - $1) WHERE user_id = $2 AND ability_type = $3`,
            [qte, socket.userId, type]
          );
        }
      }

      if (m.etat.gagnant) {
        await finirMatch(io, matchId);
      } else {
        io.to('match_' + matchId).emit('match.update', state.vuePublique(m.etat));
      }
    });

    // === Quitter la partie volontairement ===
    socket.on('play.quit', async () => {
      const matchId = socketToMatch.get(socket.id);
      if (!matchId) return socket.emit('match.error', { error: 'Aucune partie en cours.' });
      const m = matchsEnCours.get(matchId);
      if (!m) return socket.emit('match.error', { error: 'Partie introuvable.' });
      if (m.etat.gagnant) return;

      let cotePerdant;
      if (m.p1Id === socket.userId) cotePerdant = 'R';
      else if (m.p2Id === socket.userId) cotePerdant = 'B';
      else return socket.emit('match.error', { error: 'Vous n\'êtes pas dans cette partie.' });

      m.etat.gagnant = (cotePerdant === 'R') ? 'B' : 'R';
      m.forfait = true;
      m.quit = true;

      const advId = (cotePerdant === 'R') ? m.p2Id : m.p1Id;
      io.to('user_' + advId).emit('match.quit-notify', {
        message: 'Ton adversaire a quitté la partie. Tu reçois la moitié des gains.'
      });

      await finirMatch(io, matchId);
    });

    // === Sync : le client demande l'état actuel du match ===
    // Permet de récupérer l'état si on a raté un match.update / match.end.
    socket.on('match.sync', async () => {
      const matchId = socketToMatch.get(socket.id);
      if (!matchId) return socket.emit('match.error', { error: 'Aucune partie en cours.' });
      const m = matchsEnCours.get(matchId);
      if (!m) return socket.emit('match.error', { error: 'Partie introuvable.' });

      // Vérifier que le socket est bien dans ce match
      if (m.p1Id !== socket.userId && m.p2Id !== socket.userId) {
        return socket.emit('match.error', { error: 'Vous n\'êtes pas dans cette partie.' });
      }

      // Renvoyer l'état public actuel
      socket.emit('match.update', state.vuePublique(m.etat));

      // Si la partie est déjà finie mais que le client n'a pas reçu match.end,
      // lui renvoyer un match.end minimal (sans récompenses — déjà créditées).
      if (m.etat.gagnant) {
        const cote = (m.p1Id === socket.userId) ? 'R' : 'B';
        const gagnant = m.p1Id === m.p1Id ? 'R' : 'B'; // = m.etat.gagnant
        const won = (m.etat.gagnant === cote);
        const invFinal = await chargerInventaire(socket.userId);
        const advId = (m.p1Id === socket.userId) ? m.p2Id : m.p1Id;
        const invAdvFinal = await chargerInventaire(advId);
        socket.emit('match.end', {
          winner: m.etat.gagnant,
          pc: 0, tr: 0, eloDelta: 0,
          forfait: !!m.forfait,
          quit: !!m.quit,
          montees: [],
          inventaireMoi: invFinal,
          inventaireAdversaire: invAdvFinal,
          sync: true  // indique au client que c'est un sync (récompenses déjà créditées)
        });
        console.log(`[socket] match.sync pour ${socket.pseudo}: partie déjà finie, match.end renvoyé.`);
      } else {
        console.log(`[socket] match.sync pour ${socket.pseudo}: partie en cours, état renvoyé.`);
      }
    });

    // === Déconnexion ===
    socket.on('disconnect', async () => {
      console.log(`[socket] Déconnexion de ${socket.pseudo} (${socket.userId}).`);
      // 1. Retirer de la file de matchmaking
      matchmaking.retirer(socket.id);

      // 2. Gérer le match en cours → forfait (adversaire gagne)
      const matchId = socketToMatch.get(socket.id);
      if (matchId) {
        const m = matchsEnCours.get(matchId);
        if (m && !m.etat.gagnant) {
          const cotePerdant = (m.p1Id === socket.userId) ? 'R' : 'B';
          m.etat.gagnant = (cotePerdant === 'R') ? 'B' : 'R';
          m.forfait = true;
          const advId = (cotePerdant === 'R') ? m.p2Id : m.p1Id;
          io.to('user_' + advId).emit('match.quit-notify', {
            message: 'Ton adversaire s\'est déconnecté.'
          });
          await finirMatch(io, matchId);
        }
        socketToMatch.delete(socket.id);
      }

      // 3. Gérer les salons privés dont ce socket est host ou guest
      const codes = socketRooms.get(socket.id) || new Set();
      for (const code of [...codes]) {
        const room = rooms.get(code);
        if (!room) continue;
        if (room.hostId === socket.userId) {
          // L'host s'est déconnecté → fermer le salon
          await closeRoom(io, code, 'L\'hôte s\'est déconnecté.');
        } else if (room.guestId === socket.userId) {
          // L'invité s'est déconnecté → revenir en 'waiting'
          room.guest = null;
          room.guestId = null;
          if (room.status === 'playing') room.status = 'waiting';
          try {
            await pool.query(`UPDATE private_rooms SET status = 'waiting' WHERE code = $1`, [code]);
          } catch (e) {}
          io.to('room_' + code).emit('room.update', {
            code, status: room.status, host: false, guest: false,
            guestLeft: true
          });
        }
      }

      // 4. Gérer les tournois dont ce socket est inscrit
      const tids = socketTournaments.get(socket.id) || new Set();
      for (const tid of [...tids]) {
        try {
          const t = await pool.query(`SELECT * FROM tournaments WHERE id = $1`, [tid]);
          if (t.rowCount === 0) continue;
          const tournoi = t.rows[0];
          if (tournoi.status !== 'waiting') continue; // en cours = on garde l'inscription

          // Si c'est le créateur qui part → supprimer le tournoi
          if (tournoi.creator_id === socket.userId) {
            await deleteTournament(io, tid, 'Le créateur s\'est déconnecté.');
            continue;
          }
          // Sinon, juste se désinscrire
          await pool.query(`DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2`, [tid, socket.userId]);
          const restants = await pool.query(
            `SELECT u.pseudo FROM tournament_players tp JOIN users u ON u.id = tp.user_id WHERE tp.tournament_id = $1`,
            [tid]
          );
          if (restants.rowCount === 0) {
            await deleteTournament(io, tid, 'Tournoi vide : supprimé.');
          } else {
            io.to('tournament_' + tid).emit('tournament.update', {
              id: tid, left: socket.pseudo,
              inscrits: restants.rows.map(r => r.pseudo)
            });
          }
        } catch (e) { console.error('[socket] disconnect tournament cleanup:', e); }
      }

      // 5. Nettoyer les maps globales
      socketToUser.delete(socket.id);
      if (userToSocket.get(socket.userId) === socket.id) userToSocket.delete(socket.userId);
      socketRooms.delete(socket.id);
      socketTournaments.delete(socket.id);
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
  const db = await pool.query(
    `INSERT INTO matches (player1_id, player2_id, match_type, status, room_code, tournament_id)
     VALUES ($1, $2, $3, 'playing', $4, $5) RETURNING id`,
    [p1.userId, p2.userId, type, roomCode || null, tournamentId || null]
  );
  const matchId = 'm_' + db.rows[0].id;
  const etat = rules.nouvelEtat(type);
  etat.noms = { R: p1.pseudo, B: p2.pseudo };
  etat.ids = { R: p1.userId, B: p2.userId };

  // Initialiser le stock depuis les inventaires DB
  const invP1 = await chargerInventaire(p1.userId);
  const invP2 = await chargerInventaire(p2.userId);
  etat.stock.R = { bornes: 3, virage: Math.min(2, Math.max(1, invP1.pivot || 0)), tp: Math.min(1, invP1.tp || 0), diagonale: Math.min(1, invP1.diagonale || 0) };
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

// Termine un match: calcule les gains, met à jour la DB, notifie les deux joueurs.
//
// BUG FIX (précédemment) : si une erreur DB se produisait entre BEGIN et les emit,
// m.etat.gagnant était déjà positionné mais les events match.end / match.update
// n'étaient jamais envoyés. Les joueurs ne voyaient ni l'écran de fin, ni le plateau
// mis à jour, et un nouveau coup déclenchait "Partie déjà terminée".
//
// SOLUTION :
// 1. On précharge les inventaires AVANT la transaction (pour avoir un fallback).
// 2. On fait les mises à jour DB dans un try/catch.
// 3. On émet TOUJOURS les events dans un bloc finally, avec les vraies valeurs
//    si la DB a réussi, ou des valeurs de fallback (pc=0, tr=0, montees=[]) sinon.
// 4. On utilise io.to('user_<userId>') plutôt que io.to(socketId) pour que les
//    events arrivent même si le socket s'est reconnecté entre-temps.
async function finirMatch(io, matchId) {
  const m = matchsEnCours.get(matchId);
  if (!m) return;
  if (m.finished) return;
  m.finished = true;

  const e = m.etat;
  const gagnantId = e.ids[e.gagnant];
  const perdantId = e.ids[(e.gagnant === 'R') ? 'B' : 'R'];

  // Précharger les inventaires AVANT toute transaction (fallback si DB down).
  let invP1Final, invP2Final;
  try {
    invP1Final = await chargerInventaire(m.p1Id);
    invP2Final = await chargerInventaire(m.p2Id);
  } catch (e2) {
    invP1Final = { tp: 0, diagonale: 0, pivot: 0 };
    invP2Final = { tp: 0, diagonale: 0, pivot: 0 };
  }

  // Recaps par défaut (en cas d'erreur DB)
  let recapGagnant = {
    winner: e.gagnant,
    pc: 0, tr: 0, eloDelta: 0,
    forfait: !!m.forfait,
    quit: !!m.quit,
    montees: [],
    inventaireMoi: gagnantId === m.p1Id ? invP1Final : invP2Final,
    inventaireAdversaire: gagnantId === m.p1Id ? invP2Final : invP1Final
  };
  let recapPerdant = {
    winner: e.gagnant,
    pc: 0, tr: 0, eloDelta: 0,
    forfait: !!m.forfait,
    quit: !!m.quit,
    inventaireMoi: perdantId === m.p1Id ? invP1Final : invP2Final,
    inventaireAdversaire: perdantId === m.p1Id ? invP2Final : invP1Final
  };

  // Calcul Elo + gains
  let eloP1 = 1000, eloP2 = 1000;
  let newA = eloP1, newB = eloP2, deltaA = 0, deltaB = 0;
  let pcGagnantFinal = 0, pcPerdant = 0, trGagnant = 0, trPerdant = 0;
  let montees = [];

  const client = await pool.connect();
  let dbOk = false;
  try {
    // Charger les données users
    const eR = await pool.query('SELECT elo, trophies, pc_balance, win_streak FROM users WHERE id = $1', [m.p1Id]);
    const eB = await pool.query('SELECT elo, trophies, pc_balance, win_streak FROM users WHERE id = $1', [m.p2Id]);
    if (eR.rowCount === 0 || eB.rowCount === 0) {
      throw new Error('Un des joueurs est introuvable en DB.');
    }
    eloP1 = eR.rows[0].elo; eloP2 = eB.rows[0].elo;
    const scoreP1 = (e.gagnant === 'R') ? 1 : 0;
    ({ newA, newB, deltaA, deltaB } = appliquerElo(eloP1, eloP2, scoreP1));

    let pcGagnant, trGagnant;
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
    if (m.quit) {
      pcGagnant = Math.floor(pcGagnant / 2);
      trGagnant = Math.floor(trGagnant / 2);
      pcPerdant = 0;
      trPerdant = Math.floor(trPerdant / 2);
    }

    let streakBonus = 0;
    if (m.type === 'ranked') {
      const g = gagnantId === m.p1Id ? eR.rows[0] : eB.rows[0];
      const newStreakG = (m.forfait ? g.win_streak : g.win_streak + 1);
      streakBonus = Math.min(20, Math.max(0, newStreakG * 2) - Math.max(0, g.win_streak * 2));
      streakBonus = Math.max(0, streakBonus);
    }
    pcGagnantFinal = pcGagnant + streakBonus;

    // Le gagnant a-t-il franchi un nouveau palier ? Calculé AVANT la transaction
    // pour pouvoir afficher les montees dans le recap.
    const gagnantUser = gagnantId === m.p1Id ? eR.rows[0] : eB.rows[0];
    const oldTr = gagnantUser.trophies;
    const newTr = oldTr + trGagnant;

    // Transaction DB — UNIQUEMENT des UPDATE/INSERT, JAMAIS d'appel à pool.query
    // ici (sinon self-deadlock : la transaction attendrait verifierMontees qui
    // attendrait le COMMIT de la transaction pour relâcher son lock sur users).
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET pc_balance = pc_balance + $1, trophies = GREATEST(0, trophies + $2),
       win_streak = CASE WHEN $3 = 'ranked' THEN win_streak + 1 WHEN $3 = 'tournament' THEN win_streak + 1 ELSE win_streak END,
       matches_played = matches_played + 1, matches_won = matches_won + 1,
       best_streak = GREATEST(best_streak, win_streak + 1)
       WHERE id = $4`,
      [pcGagnantFinal, trGagnant, m.type, gagnantId]
    );
    await client.query(
      `UPDATE users SET pc_balance = pc_balance + $1, trophies = GREATEST(0, trophies + $2),
       win_streak = 0,
       matches_played = matches_played + 1, matches_lost = matches_lost + 1
       WHERE id = $3`,
      [pcPerdant, trPerdant, perdantId]
    );
    await client.query('UPDATE users SET elo = $1 WHERE id = $2', [newA, m.p1Id]);
    await client.query('UPDATE users SET elo = $1 WHERE id = $2', [newB, m.p2Id]);
    await client.query(
      `UPDATE matches SET status = 'finished', winner_id = $1, elo_change = $2, pc_earned = $3, tr_earned = $4, finished_at = NOW() WHERE id = $5`,
      [gagnantId, deltaA, pcGagnantFinal, trGagnant, m.dbId]
    );
    await client.query('COMMIT');

    // ===== APRÈS COMMIT : créditer les montées de rank (utilise pool, hors transaction) =====
    // Si verifierMontees échoue, le match est déjà enregistré — on perd juste les
    // récompenses de montée (mais pas le PC/TR/Elo du match lui-même).
    try {
      montees = await verifierMontees(gagnantId, oldTr, newTr);
    } catch (eM) {
      console.error('[socket] verifierMontees erreur (non bloquant):', eM.message);
      montees = [];
    }

    // Recharger les inventaires APRES les montées de rank (pour inclure les récompenses)
    try {
      invP1Final = await chargerInventaire(m.p1Id);
      invP2Final = await chargerInventaire(m.p2Id);
    } catch (e3) { /* on garde les inventaires pré-chargés */ }

    // Construire les recaps avec les vraies valeurs
    recapGagnant = {
      winner: e.gagnant,
      pc: pcGagnantFinal, tr: trGagnant, eloDelta: (gagnantId === m.p1Id ? deltaA : deltaB),
      forfait: !!m.forfait, quit: !!m.quit, montees,
      inventaireMoi: gagnantId === m.p1Id ? invP1Final : invP2Final,
      inventaireAdversaire: gagnantId === m.p1Id ? invP2Final : invP1Final
    };
    recapPerdant = {
      winner: e.gagnant,
      pc: pcPerdant, tr: trPerdant, eloDelta: (perdantId === m.p1Id ? deltaA : deltaB),
      forfait: !!m.forfait, quit: !!m.quit,
      inventaireMoi: perdantId === m.p1Id ? invP1Final : invP2Final,
      inventaireAdversaire: perdantId === m.p1Id ? invP2Final : invP1Final
    };

    // Marquer le salon comme 'finished' si match privé
    if (m.roomCode) {
      try {
        await pool.query(`UPDATE private_rooms SET status = 'finished' WHERE code = $1`, [m.roomCode]);
        const room = rooms.get(m.roomCode);
        if (room) room.status = 'finished';
      } catch (e4) {}
    }
    dbOk = true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e5) {}
    console.error('[socket] finirMatch erreur DB:', err.message);
    // On conserve les recaps par défaut (pc=0, tr=0, montees=[])
    // → les joueurs verront quand même l'écran de fin, sans récompenses créditées.
  } finally {
    client.release();

    // ===== Toujours émettre, même en cas d'erreur DB =====
    // Utiliser io.to('user_<userId>') pour viser l'utilisateur par son id plutôt
    // que par son socketId (qui peut avoir changé suite à une reconnexion).
    try {
      io.to('user_' + m.p1Id).emit('match.end', (m.p1Id === gagnantId) ? recapGagnant : recapPerdant);
      io.to('user_' + m.p2Id).emit('match.end', (m.p2Id === gagnantId) ? recapGagnant : recapPerdant);
      io.to('match_' + matchId).emit('match.update', state.vuePublique(e));
      console.log(`[socket] finirMatch ${matchId}: events envoyés (dbOk=${dbOk})`);
    } catch (emitErr) {
      console.error('[socket] finirMatch: erreur emit:', emitErr.message);
    }
  }

  setTimeout(() => {
    matchsEnCours.delete(matchId);
    if (m.p1) socketToMatch.delete(m.p1);
    if (m.p2) socketToMatch.delete(m.p2);
  }, 5000);
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { register };
