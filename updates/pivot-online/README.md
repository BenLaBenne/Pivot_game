# PIVOT Online

Plateforme web **multiplayer** pour le jeu de société abstrait **PIVOT** (règles **v2**).

Le projet est livré comme un **fichier ZIP prêt à déployer sur [render.com](https://render.com)**. Toutes les tables de la base de données sont créées automatiquement au démarrage — aucune migration manuelle n'est requise.

---

## Présentation

PIVOT est un jeu abstrait à deux joueurs, 5 à 15 minutes, sur une grille 7×7. Un **pivot partagé** est déplacé à tour de rôle : Rouge ne peut le déplacer qu'horizontalement, Bleu que verticalement. Le but est de **piéger l'adversaire** : tu gagnes quand il n'a plus aucun mouvement possible — ni glissement, ni virage, ni diagonale, ni téléportation, même s'il lui reste des bornes.

Règles complètes : voir `pivot_regles_v2.md` (fourni dans le ZIP).

Cette plateforme ajoute à la version navigateur solo un univers complet :
- Authentification (pseudo + mot de passe, JWT)
- Matchmaking ranked par Elo (±50, élargi progressivement)
- Salons privés (code à 6 caractères + lien)
- Tournois (bracket à élimination, min 3, max 20)
- Boutique : capacités à l'unité + 5 niveaux de coffres
- Système de rank à **18 paliers** (6 tiers × 3 niveaux) avec récompenses automatiques
- Classement public (par TR, par tier, par win rate) avec pagination
- Profils publics avec bouton **Signaler**
- **Page admin** : gestion des comptes (suppression, ban, don d'objets, promotion admin), gestion des signalements, logs admin
- **Sons** générés via Web Audio API (clics, mouvements, victoire, montée de rank, ouverture de coffre, etc.)
- **Bouton Quitter** pendant une partie : l'adversaire reçoit la moitié des gains, message envoyé
- **Écran de fin style Brawl Stars** : VICTOIRE/DÉFAITE en gros, inventaire restant des deux joueurs, récompenses, montées de rank, bouton retour menu
- **Menu déroulant des règles** pendant une partie
- Inventaire en partie affiché clairement : **Moi** vs **Adversaire** avec les valeurs de départ (DB)
- Retour automatique en mode **Glisser** après chaque utilisation de capacité

## Stack technique

- **Backend** : Node.js 18+ / Express 4
- **Temps réel** : Socket.io 4 (matchmaking, coups en live, fin de match)
- **Base de données** : PostgreSQL (service PostgreSQL gratuit de render.com)
- **Auth** : bcrypt 5 (hash des mots de passe) + jsonwebtoken 9 (JWT)
- **Frontend** : HTML + CSS + JS vanilla (pas de framework, pas de build)
- **Auto-création DB** : `init-db.js` exécute tous les `CREATE TABLE IF NOT EXISTS` au démarrage

## Installation locale

```bash
# 1. Dézipper
unzip pivot-online.zip
cd pivot-online

# 2. Installer les dépendances
npm install

# 3. Copier .env.example en .env et remplir DATABASE_URL
cp .env.example .env
#  → édite .env, mets ta DATABASE_URL PostgreSQL

# 4. Lancer (le serveur crée les tables au démarrage)
npm start

# 5. Ouvrir http://localhost:3000
```

Pour générer uniquement le schéma DB sans lancer le serveur :
```bash
npm run init-db
```

## Déploiement sur render.com

Le `render.yaml` est fourni dans le ZIP. Procédure :

1. Crée un compte sur [render.com](https://render.com).
2. Connecte ton repo GitHub (ou crée un nouveau repo et pousse le contenu du ZIP dedans).
3. Clique sur **New +** → **Blueprint** sur render.com. Render détecte le `render.yaml` et crée :
   - un **Web Service** Node.js (`pivot-online`)
   - une **base PostgreSQL** gratuite (`pivot-db`)
4. Render injecte automatiquement la variable `DATABASE_URL` (depuis la DB), génère un `JWT_SECRET`, et définit `NODE_ENV=production` et `PORT`.
5. Au premier démarrage, le script `init-db.js` (lancé par `server.js`) crée toutes les tables.
6. Le site est accessible sur `https://pivot-online.onrender.com` (URL exacte à vérifier après déploiement).

### Contraintes à connaître

- **Plan gratuit** : le service "sleep" après 15 min d'inactivité. Le premier démarrage peut prendre 30-60 s. Pas grave pour un projet perso.
- **PostgreSQL gratuit** : 90 jours de rétention, 1 GB de stockage. Suffisant.
- **WebSockets** : supportés par render.com (socket.io fonctionne out of the box).
- **Build** : `npm install` suffit. Pas de build frontend complexe (vanilla HTML/CSS/JS).
- **Start command** : `npm start` (défini comme `node server.js` dans `package.json`).

## Variables d'environnement

Voir `.env.example`. Les variables utilisées sont :

| Variable        | Description                                            | Obligatoire |
|-----------------|--------------------------------------------------------|-------------|
| `DATABASE_URL`  | URL de connexion PostgreSQL                            | Oui         |
| `JWT_SECRET`    | Secret pour signer les JWT                             | Oui         |
| `PORT`          | Port d'écoute (render.com l'injecte automatiquement)  | Non (défaut 3000) |
| `NODE_ENV`      | `production` ou `development`                          | Non         |
| `DATABASE_SSL`  | Mettre à `false` pour désactiver SSL sur la DB locale  | Non         |

## Routes API REST

### Auth (`/api/auth`)
- `POST /api/auth/signup` — `{ pseudo, password }` → `{ token, user }`
- `POST /api/auth/login` — `{ pseudo, password }` → `{ token, user }`
- `GET /api/auth/me` (Bearer) — profil complet de l'utilisateur connecté

### Shop (`/api/shop`)
- `GET /api/shop/info` (Bearer) — catalogue + inventaire + PC + coffres en stock
- `POST /api/shop/buy-capacite` (Bearer) — `{ type: 'tp'\|'diagonale'\|'pivot', quantite }`
- `POST /api/shop/buy-chest` (Bearer) — `{ niveau: 1..5 }`
- `POST /api/shop/open-chest` (Bearer) — `{ chestId }`

### Rooms (`/api/rooms`)
- `POST /api/rooms/create` (Bearer) — crée un salon, renvoie `{ code, link }`
- `POST /api/rooms/join` (Bearer) — `{ code }` rejoint le salon
- `GET /api/rooms/:code` (Bearer) — état du salon

### Tournaments (`/api/tournaments`)
- `GET /api/tournaments` — liste des tournois publics en attente
- `POST /api/tournaments` (Bearer) — `{ name, isPrivate }` crée un tournoi
- `GET /api/tournaments/:id` — détail (inscrits)
- `POST /api/tournaments/:id/join` (Bearer) — `[{ code }]` rejoindre
- `POST /api/tournaments/:id/start` (Bearer) — lance le tournoi (créateur uniquement)

### Leaderboard (`/api/leaderboard`)
- `GET /api/leaderboard?tier=Plastique&sort=tr&page=1` — liste paginée
- `GET /api/leaderboard/user/:pseudo` — profil public d'un joueur

### Reports (`/api/reports`)
- `POST /api/reports` (Bearer) — `{ reportedId, reason, details? }` crée un signalement
- `GET /api/reports/reasons` — liste des raisons possibles (`triche`, `comportement_toxique`, `pseudo_inapproprie`, `spam`, `autre`)

### Admin (`/api/admin`) — toutes les routes exigent `is_admin = true`
- `GET /api/admin/stats` — statistiques globales (utilisateurs, bannis, admins, matchs, signalements ouverts, PC total)
- `GET /api/admin/users?page=1&search=` — liste paginée des utilisateurs (avec inventaire, is_admin, banned)
- `POST /api/admin/users/:id/delete` — supprime un compte (interdit si admin)
- `POST /api/admin/users/:id/ban` — `{ reason }` bannit un compte (interdit si admin)
- `POST /api/admin/users/:id/unban` — débannit
- `POST /api/admin/users/:id/give` — `{ pc?, tp?, diagonale?, pivot?, coffre? }` donne des objets en quantité arbitraire
- `POST /api/admin/users/:id/set-admin` — `{ isAdmin }` promeut/rétrograde admin
- `POST /api/admin/users/:id/reset-stats` — réinitialise Elo/TR/streak
- `GET /api/admin/reports?status=open` — liste des signalements par statut
- `POST /api/admin/reports/:id/resolve` — `{ note, dismiss }` résout ou écarte un signalement
- `GET /api/admin/logs` — historique des actions admin (200 dernières)

### Divers
- `GET /api/health` — health check utilisé par render.com

## Events Socket.io

Le client se connecte avec `{ auth: { token: '<JWT>' } }`. Events :

**Client → Serveur**
- `queue.join` — entre dans la file de matchmaking
- `queue.leave` — quitte la file
- `room.create` — crée un salon privé
- `room.join` `{ code }` — rejoint un salon
- `tournament.join` `{ id, code? }` — s'inscrit à un tournoi
- `tournament.start` `{ id }` — lance un tournoi (créateur)
- `play.action` — intention de coup (voir ci-dessous)
- `play.quit` — abandonne la partie (l'adversaire reçoit la moitié des gains)
- `disconnect`

**Serveur → Client**
- `queue.update` `{ position }`
- `match.start` `{ matchId, role: 'R'|'B', adversaire, etat, inventaireMoi, inventaireAdversaire }`
- `match.update` `etat` (vue publique du plateau)
- `match.end` `{ winner, pc, tr, eloDelta, montees, forfait, quit }`
- `match.error` `{ error }`
- `match.quit-notify` `{ message }` — informe l'adversaire qu'il a été quitté
- `room.update` `{ code, status }`
- `tournament.update` `{ id, ... }`

### Format des actions de jeu (`play.action`)

Toutes les actions renvoient `{ ok: true }` ou `{ ok: false, err }` via `match.error`.

- Glisser : `{ type: 'glisser', to: { x, y } }`
- Virage : `{ type: 'virage', to: { x, y } }` — coûte 1 virage
- Diagonale : `{ type: 'diagonale', to: { x, y } }` — coûte 1 diagonale
- Poser une borne : `{ type: 'borne', to: { x, y } }` — coût: 1 borne
- Téléporter : `{ type: 'tp', to: { x, y } }` — coûte 1 tp
- Déplacement après tp : `{ type: 'tp_suite', deplacement: { type: 'glisser'\|'virage'\|'diagonale', to: {x,y} } }`
- Choix d'échange des camps : `{ type: 'echange', garder: bool }` (envoyé par Bleu après le premier coup)

## Schéma de la base de données

Voir `init-db.js` pour la liste complète. Tables principales :

- `users` (pseudo unique, password_hash, elo, trophies, pc_balance, win_streak, best_streak, matches_played/won/lost, **is_admin**, **banned**, **banned_reason**, **banned_at**)
- `user_inventory` (user_id, ability_type 'tp'|'diagonale'|'pivot', quantity)
- `user_chests` (id, user_id, chest_level, status 'unopened'|'opened')
- `matches` (player1_id, player2_id, winner_id, match_type, status, elo_change, pc_earned, tr_earned, room_code, tournament_id)
- `private_rooms` (code, host_id, status)
- `tournaments` (name, creator_id, status, is_private, code, max_players)
- `tournament_players` (tournament_id, user_id, eliminated, round_reached)
- `tournament_matches` (tournament_id, round, match_index, player1_id, player2_id, winner_id, status)
- `purchases` (audit des achats en boutique)
- `rank_history` (historique des montées de rank)
- `chest_openings` (audit des coffres ouverts)
- **`reports`** (reporter_id, reported_id, reason, details, status 'open'|'resolved'|'dismissed', admin_id, admin_note)
- **`admin_logs`** (admin_id, action, target_id, details) — audit des actions admin

### Promouvoir un admin

Pour qu'un utilisateur devienne admin, il faut manuellement positionner `is_admin = TRUE` dans la table `users` (via la console SQL de render.com par exemple) :

```sql
UPDATE users SET is_admin = TRUE WHERE pseudo = 'ton_pseudo';
```

Une fois admin, l'utilisateur voit un lien **Admin** dans la barre de navigation et peut accéder à la page `/admin`.

Le serveur est l'arbitre unique : tous les coups sont validés côté serveur, l'inventaire est décrémenté immédiatement à l'utilisation, et les montées de rank sont créditées automatiquement.

## Économie

### Pivot Coins (PC)
- Victoire ranked : 15 PC (+2 par victoire consécutive, plafonné +20)
- Défaite ranked : 5 PC
- Salon privé : moitié
- Tournoi : 15 / 5 + récompenses de tournoi

### Capacités (achat à l'unité)
- Téléportation : 3 PC
- Diagonale : 2 PC
- Pivot (virage) : 1 PC
- Bornes : toujours 3 en partie (gratuites)

### Coffres (5 niveaux)

| Niveau | Prix (PC) | Exemples de contenu |
|--------|-----------|---------------------|
| 1 | 2  | 1 TP OU 3 Pivot OU 1 Diag + 1 Pivot |
| 2 | 5  | 1 TP + 1 Pivot OU 1 Diag + 2 Pivot OU 2 Diag |
| 3 | 12 | 2 TP OU 1 TP + 1 Diag + 2 Pivot OU 3 Diag + 1 Pivot |
| 4 | 25 | 3 TP + 1 Diag OU 2 TP + 2 Diag + 2 Pivot OU 5 Diag |
| 5 | 50 | 5 TP + 2 Diag OU 4 TP + 3 Diag + 5 Pivot OU 10 Diag + 5 Pivot |

À l'ouverture, le serveur tire au sort une des combinaisons possibles.

## Système de Rank (18 paliers)

6 tiers × 3 niveaux : Plastique 1-3, Bronze 1-3, Argent 1-3, Fer 1-3, Or 1-3, Legendary 1-3.

### Trophées (TR)
- Victoire ranked : +25 TR
- Défaite ranked : -10 TR (ne descend pas sous 0)
- Salon privé : moitié (+12 / -5)
- Tournoi : +40 TR par victoire

### Seuils
| Rank | TR  | Rank | TR   | Rank | TR   |
|------|-----|------|------|------|------|
| Plastique 1 | 0    | Bronze 1 | 150  | Argent 1 | 500 |
| Plastique 2 | 50   | Bronze 2 | 250  | Argent 2 | 650 |
| Plastique 3 | 100  | Bronze 3 | 350  | Argent 3 | 800 |
| Fer 1 | 1000 | Fer 2 | 1200 | Fer 3 | 1400 |
| Or 1 | 1700 | Or 2 | 2000 | Or 3 | 2300 |
| Legendary 1 | 2700 | Legendary 2 | 3100 | Legendary 3 | 3500 |

### Récompenses
- À chaque montée de niveau : 30-350 PC + (capacité ou coffre selon tier)
- À chaque montée de tier : 100-1500 PC + coffre + capacités

Voir `ranks.js` pour les valeurs exactes.

## Règles v2 (résumé)

Le serveur (`game/rules.js` et `game/state.js`) implémente strictement les règles v2 :

- Grille 7×7, pivot partagé départ D4
- Rouge = horizontal, Bleu = vertical
- **3 bornes** par joueur (gratuites)
- **2 virages** par joueur (au lieu de 1 en v1)
- **1 téléportation** par joueur, suivie obligatoirement d'un déplacement
- **1 diagonale** par joueur
- **Perte si aucun mouvement possible** (glissement, virage, diagonale, tp), même s'il reste des bornes — une borne ne sauve pas
- Échange des camps après le premier coup (Bleu choisit garder ou échanger)
- Inventaire consommé à l'utilisation (anti-triche: vérifié en DB)

## Sécurité & robustesse

- Mots de passe hashés avec bcrypt (sel automatique, 10 rounds)
- Toutes les requêtes SQL utilisent des requêtes paramétrées (pas de concaténation)
- JWT avec expiration (7 jours)
- Validation des inputs côté serveur
- Anti-triche : le serveur vérifie l'inventaire DB avant de valider un tp/diagonale/virage
- Déconnexion en match → forfait après 60 s (simplifié: forfait immédiat sur déconnexion)
- Logs des matchs, achats, montées de rank et ouvertures de coffres en DB

## UI

L'UI est volontairement très colorée et ressemble à Brawl Stars :
- Dégradé bleu-violet-orange en fond
- Boutons jaune/orange 3D avec animation de press
- Cards arrondies avec bordure foncée épaisse
- Icônes en emojis (🪙 PC, 🏆 TR, ⚡ TP, ↗️ Diagonale, 🔄 Pivot, 🎁 Coffres)
- Confettis à l'ouverture d'un coffre et à la victoire
- Responsive mobile-first, jouable sur téléphone

## License

Projet personnel. Aucune licence spécifique.
