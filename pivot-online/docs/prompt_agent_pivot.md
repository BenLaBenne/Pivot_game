# PROMPT AGENT IA — Plateforme web PIVOT (multiplayer + shop + ranks)

Tu vas construire une plateforme web complète autour du jeu de société abstrait PIVOT. Le projet est à livrer sous forme d'un **fichier ZIP** prêt à déployer sur render.com.

Tu recevras en pièces jointes deux fichiers à utiliser comme source de vérité :
- `pivot.html` — l'implémentation navigateur **actuelle (v1)** du jeu : 1 pivot partagé, 3 bornes, 1 virage, échange des camps, annulation, détection de victoire. C'est ta base de code pour la logique du jeu.
- `pivot_regles_v2.md` — les **règles v2** (la source de vérité pour la logique) : 1 pivot partagé en D4, 3 bornes, **2 virages**, **1 téléportation**, **1 diagonale**, perte si aucun mouvement possible (même s'il reste des bornes).

**Ta première tâche** est de mettre à jour `pivot.html` pour qu'il respecte la v2 : ajouter les boutons/cibles pour téléportation et diagonale, passer le stock de virages de 1 à 2, appliquer la règle de défaite étendue (borne ne sauve pas). Le HTML v2 sert ensuite de "table de jeu" pour le mode online.

---

## 1. Stack technique

- **Backend** : Node.js + Express
- **Temps réel** : socket.io (obligatoire pour le multiplayer, le matchmaking, les coups en live)
- **Base de données** : PostgreSQL (render.com fournit un service PostgreSQL gratuit)
- **Auth** : bcrypt pour le hash des mots de passe, JWT ou sessions Express-cookie
- **Frontend** : HTML + CSS + JS vanilla (pas de React/Vue). Le serveur Express sert les pages HTML statiques + l'API REST + les WebSockets.
- **Auto-création de la DB** : au démarrage du serveur, exécuter un script `init-db.js` qui crée toutes les tables avec `CREATE TABLE IF NOT EXISTS`. Pas de migration manuelle — le site doit pouvoir démarrer sur une DB vide et tout créer tout seul.

---

## 2. Fonctionnalités — détail complet

### 2.1 Authentification

- **Inscription** : pseudo + mot de passe (hash bcrypt, sel). Pas d'email requis au départ, mais prévoir le champ en DB pour l'ajouter plus tard.
- **Connexion** : pseudo + mot de passe → renvoie un JWT stocké côté client (localStorage ou cookie httpOnly).
- **Pseudo unique** : vérifier à l'inscription.
- **Mot de passe** : minimum 6 caractères.
- Tout est stocké en DB (table `users`).

### 2.2 Classement Elo

- Chaque joueur a un **Elo** (départ à 1000).
- Formule Elo standard : après un match, `Elo_new = Elo_old + K * (score_attendu - score_obtenu)` avec K=32.
- Le Elo est utilisé **uniquement pour le matchmaking**, pas pour l'affichage public (l'affichage public utilise les Trophées / Rank, voir §2.7).

### 2.3 Matchmaking

- Le joueur clique sur "Jouer en ligne" → entre dans une file d'attente.
- Le serveur cherche un adversaire dans la **même tranche de Elo** (±50 Elo par défaut).
- **Si personne trouvé** après 10 secondes, élargir la tranche (±100, puis ±200, etc.) ou prendre le **joueur avec le Elo le plus proche** disponible dans la file.
- Une fois apparié, créer une `match` room, initialiser le plateau v2 (pivot en D4, 3 bornes, 2 virages, 1 tp, 1 diagonale par joueur **selon leur inventaire** — voir §2.6), et lancer la partie.
- Le serveur arbitre : valide chaque coup, applique les règles v2, détecte la victoire, met à jour Elo + PC + TR + win streak.

### 2.4 Salons privés

- Un joueur crée un salon → le serveur génère un **code** (6 caractères alphanumériques) et un **lien** (`/room/CODE`).
- Le joueur partage le lien ou le code. L'adversaire rejoint via le lien ou en tapant le code dans un champ "Rejoindre un salon".
- Le salon a un statut : `waiting`, `playing`, `finished`.
- Pas d'effet sur le Elo (partie amicale), mais **PC et TR quand même distribués** (réduits de moitié par rapport au matchmaking ranked).

### 2.5 Tournois

- **Min 3 joueurs, max 20 joueurs** par tournoi.
- Un joueur crée un tournoi (public ou privé avec code) → autres joueurs rejoignent.
- Quand le seuil min est atteint, le createur peut lancer le tournoi.
- Format : **bracket à élimination** (arbre binaire). Si nombre impair de joueurs, un joueur passe automatiquement au tour suivant (bye).
- Chaque match de tournoi suit les règles v2 + inventaire.
- Récompenses de tournoi (en plus des PC/TR par match) :
  - 1er : 200 PC + coffre niveau 4
  - 2e : 100 PC + coffre niveau 3
  - 3e : 50 PC + coffre niveau 2
  - Participants : 10 PC + coffre niveau 1

### 2.6 Boutique, économie et inventaire

#### Pivot Coins (PC)

- Monnaie principale. Gagnés à chaque partie :
  - **Victoire (matchmaking)** : 15 PC de base
  - **Défaite (matchmaking)** : 5 PC de base
  - **Bonus suite de victoires (win streak)** : +2 PC par victoire consécutive, plafonné à +20 PC (donc 10 victoires de suite = +20 PC max). La streak se réinitialise à la première défaite.
  - **Salon privé** : moitié des montants ci-dessus.
  - **Tournoi** : voir §2.5.

#### Capacités achetables à l'unité

- **Téléportation** : 3 PC l'unité
- **Diagonale** : 2 PC l'unité
- **Pivot (virage)** : 1 PC l'unité
- **Bases (bornes)** : non achetables, toujours 3 par partie.

#### Coffres

Cinq niveaux de coffres, de plus en plus chers avec de meilleurs gains :

| Niveau | Prix (PC) | Valeur garantie | Gains possibles |
|--------|-----------|-----------------|-----------------|
| 1 | 2 | ~3 PC | 1 TP **OU** 3 Pivot **OU** 1 Diagonale + 1 Pivot |
| 2 | 5 | ~8 PC | 1 TP + 1 Pivot **OU** 1 Diagonale + 2 Pivot **OU** 2 Diagonales |
| 3 | 12 | ~15 PC | 2 TP **OU** 1 TP + 1 Diagonale + 2 Pivot **OU** 3 Diagonales + 1 Pivot |
| 4 | 25 | ~30 PC | 3 TP + 1 Diagonale **OU** 2 TP + 2 Diagonales + 2 Pivot **OU** 5 Diagonales |
| 5 | 50 | ~60 PC | 5 TP + 2 Diagonales **OU** 4 TP + 3 Diagonales + 5 Pivot **OU** 10 Diagonales + 5 Pivot |

À l'ouverture du coffre, le serveur tire au sort **une** des combinaisons possibles et crédite l'inventaire.

#### Inventaire (consommable)

- Chaque joueur a un inventaire avec les quantités de : `tp`, `diagonale`, `pivot` (les bases ne sont pas stockées, elles sont toujours 3 en partie).
- **Avant une partie**, le client affiche l'inventaire actuel. Le joueur joue avec **tout** son stock disponible au démarrage de la partie.
- **Quand une capacité est utilisée pendant la partie, elle est consommée** : le serveur décrémente l'inventaire en DB dès validation du coup.
- **À la fin de la partie**, les capacités non utilisées restent en stock.
- Exemple :
  - Avant partie : TP=5, Pivot=2, Diagonale=1
  - Pendante partie : utilise 2 TP + 1 Pivot
  - Après partie : TP=3, Pivot=1, Diagonale=1
- **Cas particulier** : si un joueur n'a **pas** de TP en stock, il ne peut pas téléporter en partie. Idem pour Diagonale et Pivot (virage). Les bases (bornes) sont toujours 3, gratuites.
- **Cap minimum** : un joueur commence toujours avec 1 Pivot (virage) gratuit à l'inscription, pour ne jamais être bloqué sans capacité.

#### Récompenses de Rank (voir §2.7)

Voir section Rank — les montées de niveau/rank distribuent aussi PC, coffres et capacités.

### 2.7 Système de Rank

**18 ranks** au total (6 tiers × 3 niveaux), du plus bas au plus haut :

1. Plastique 1, 2, 3
2. Bronze 1, 2, 3
3. Argent 1, 2, 3
4. Fer 1, 2, 3
5. Or 1, 2, 3
6. Legendary 1, 2, 3

#### Trophées (TR)

- Chaque partie gagnée rapporte des **TR** :
  - Victoire matchmaking : +25 TR
  - Défaite matchmaking : -10 TR (ne descend pas sous 0)
  - Salon privé : moitié (donc +12 / -5)
  - Tournoi : +40 TR par victoire dans le bracket
- **Seuils de TR** pour chaque rank (suggestions, ajustable) :
  - Plastique 1 : 0
  - Plastique 2 : 50
  - Plastique 3 : 100
  - Bronze 1 : 150
  - Bronze 2 : 250
  - Bronze 3 : 350
  - Argent 1 : 500
  - Argent 2 : 650
  - Argent 3 : 800
  - Fer 1 : 1000
  - Fer 2 : 1200
  - Fer 3 : 1400
  - Or 1 : 1700
  - Or 2 : 2000
  - Or 3 : 2300
  - Legendary 1 : 2700
  - Legendary 2 : 3100
  - Legendary 3 : 3500

#### Récompenses

- **À chaque montée de niveau** (ex. Plastique 1 → Plastique 2) : petite récompense proportionnelle au tier.
  - Plastique : 30 PC
  - Bronze : 50 PC + 1 Pivot
  - Argent : 80 PC + 1 Diagonale
  - Fer : 120 PC + coffre niveau 2
  - Or : 200 PC + coffre niveau 3
  - Legendary : 350 PC + coffre niveau 4
- **À chaque montée de tier/rank** (ex. Plastique 3 → Bronze 1) : grosse récompense.
  - Vers Bronze : 100 PC + coffre niveau 2
  - Vers Argent : 200 PC + coffre niveau 3
  - Vers Fer : 400 PC + coffre niveau 4 + 2 TP
  - Vers Or : 700 PC + coffre niveau 5 + 3 Diagonales
  - Vers Legendary : 1500 PC + coffre niveau 5 ×2 + 5 TP + 5 Diagonales

Les récompenses sont créditées automatiquement quand le joueur franchit le seuil.

### 2.8 Classement public

- Page `/leaderboard` qui affiche **tous les joueurs** triés par TR décroissant.
- Affiche : pseudo, rank (badge + nom), TR, Elo (optionnel, pour info), nombre de parties jouées, win rate.
- Filtres possibles : par tier (tous / Plastique / Bronze / … / Legendary), par ordre (TR / parties / win rate).
- Pagination si beaucoup de joueurs.
- Mise à jour en temps réel (socket.io) quand un joueur termine une partie.

### 2.9 Pages de l'app

- `/` — page d'accueil / dashboard : profil (pseudo, rank badge, TR, Elo, PC, inventaire), boutons "Jouer en ligne", "Créer salon privé", "Rejoindre salon", "Tournois", "Boutique", "Classement".
- `/login` et `/signup` — authentification.
- `/play` — matchmaking + table de jeu (HTML v2 mis à jour, intégré dans le layout).
- `/room/:code` — salon privé.
- `/tournaments` — liste des tournois publics + bouton créer.
- `/tournament/:id` — détail d'un tournoi (bracket, inscrits).
- `/shop` — boutique : achat de capacités à l'unité, achat de coffres, ouverture de coffres en stock, inventaire.
- `/leaderboard` — classement public.
- `/profile/:pseudo` — profil public d'un joueur.

---

## 3. UI / Design — style Brawl Stars

L'UI doit clairement **ressembler à Brawl Stars** :

- **Palette** : couleurs vives et saturées. Fond bleu-violet dégradé (#1a2a6c → #b21f1f → #fdbb2d possible, ou des dégradés bleu/jaune/orange plus sympas). Boutons jaune doré (#FFC107) ou orange (#FF6B35) avec bordure foncée épaisse et ombre portée.
- **Typo** : une font ronde et grasse (Lilita One, Baloo, Fredoka, ou similar Google Font) pour les titres et boutons. Texte courant en sans-serif lisible.
- **Boutons** : grands, arrondis, effet 3D (border-bottom épais foncé + box-shadow en bas), animation de "press" au clic (translateY +2px).
- **Cards** : chaque section (profil, inventaire, rank) dans une card arrondie avec bordure blanche épaisse et ombre.
- **Icônes** : utiliser des emojis ou des icônes SVG simples pour PC (pièce), TR (trophée), TP (éclair), Diagonale (flèche diagonale), Pivot (rotation), coffres (cadeau).
- **Rank badges** : dessiner 6 badges de couleur croissante (gris clair → marron → gris argenté → gris foncé → jaune doré → violet brillant) avec le chiffre 1/2/3 dessus. Style cartoon.
- **Animations** : confettis à l'ouverture d'un coffre, animation de montée de rank (badge qui grossit + flash), compteur qui défile pour les gains de PC/TR.
- **Responsive** : mobile-first, le jeu doit être jouable sur téléphone (la grille 7×7 se redimensionne, les boutons sont touchables).
- **Pas de mode sombre** : Brawl Stars est coloré et lumineux.

---

## 4. Schéma de base de données (à créer par `init-db.js`)

Tables principales (noms suggérés, ajuste si besoin) :

```sql
-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  pseudo VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  elo INTEGER DEFAULT 1000,
  trophies INTEGER DEFAULT 0,
  pc_balance INTEGER DEFAULT 0,
  win_streak INTEGER DEFAULT 0,
  matches_played INTEGER DEFAULT 0,
  matches_won INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventaire (capacités consommables)
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ability_type VARCHAR(16) NOT NULL,  -- 'tp', 'diagonale', 'pivot'
  quantity INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, ability_type)
);

-- Coffres en attente d'ouverture (optionnel : on peut ouvrir instantanément)
CREATE TABLE IF NOT EXISTS user_chests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  chest_level INTEGER NOT NULL,
  status VARCHAR(16) DEFAULT 'unopened',  -- 'unopened', 'opened'
  opened_at TIMESTAMP
);

-- Matchs
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  player1_id INTEGER REFERENCES users(id),
  player2_id INTEGER REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  match_type VARCHAR(16) NOT NULL,  -- 'ranked', 'private', 'tournament'
  status VARCHAR(16) DEFAULT 'playing',  -- 'waiting', 'playing', 'finished'
  elo_change INTEGER DEFAULT 0,
  pc_earned INTEGER DEFAULT 0,
  tr_earned INTEGER DEFAULT 0,
  tournament_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP
);

-- Salons privés
CREATE TABLE IF NOT EXISTS private_rooms (
  code VARCHAR(6) PRIMARY KEY,
  host_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tournois
CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(64),
  creator_id INTEGER REFERENCES users(id),
  status VARCHAR(16) DEFAULT 'waiting',  -- 'waiting', 'running', 'finished'
  is_private BOOLEAN DEFAULT FALSE,
  code VARCHAR(6),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  joined_at TIMESTAMP DEFAULT NOW(),
  eliminated BOOLEAN DEFAULT FALSE,
  round_reached INTEGER DEFAULT 0,
  PRIMARY KEY (tournament_id, user_id)
);

-- Historique des achats (audit)
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  item_type VARCHAR(32) NOT NULL,  -- 'tp', 'diagonale', 'pivot', 'chest_1'..'chest_5'
  price_pc INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Au démarrage (`init-db.js`), exécuter ces `CREATE TABLE IF NOT EXISTS` + insérer un inventaire par défaut pour les nouveaux utilisateurs (1 Pivot gratuit à l'inscription).

---

## 5. Logique du jeu (côté serveur)

Le serveur doit être l'arbitre unique : le client envoie des intentions de coup ("je glisse de B1 à E1", "je pose une borne en C3", "je téléporte en F5 puis je glisse en G5", "je fais une diagonale en D2", "je fais un virage en C1"), et le serveur **valide** chaque coup selon les règles v2 du `.md`, met à jour l'état du plateau, broadcast le nouvel état aux deux joueurs via socket.io, décrémente l'inventaire si une capacité est utilisée, et détecte la victoire.

Réutiliser la logique de `pivot.html` (fonctions `destinations`, `peutBouger`, `deplacerPivot`, etc.) côté serveur — porter le JS côté Node.

Règles v2 à respecter scrupuleusement :
- Pivot partagé, départ D4.
- 3 bornes/joueur (gratuites).
- 2 virages/joueur (si en stock).
- 1 tp/joueur (si en stock) → suivi obligatoire d'un déplacement.
- 1 diagonale/joueur (si en stock).
- Perte si aucun mouvement possible (glissement, virage, diagonale, tp), même s'il reste des bornes.
- Échange des camps après le premier coup.
- Inventaire consommé à l'utilisation.

---

## 6. Livrable — fichier ZIP

Le ZIP final doit contenir **tout le projet Node.js prêt à déployer** :

```
pivot-online.zip
├── package.json            (dépendances : express, socket.io, pg, bcrypt, jsonwebtoken, dotenv)
├── server.js               (point d'entrée Express + socket.io + init DB)
├── init-db.js              (création auto des tables)
├── db.js                   (pool PostgreSQL)
├── elo.js                  (formule Elo)
├── matchmaking.js          (file d'attente + appariement)
├── game/
│   ├── rules.js            (logique v2, portée de pivot.html)
│   └── state.js            (état d'une partie, validation des coups)
├── routes/
│   ├── auth.js
│   ├── shop.js
│   ├── rooms.js
│   ├── tournaments.js
│   └── leaderboard.js
├── sockets/
│   └── game-socket.js      (gestion des coups en temps réel)
├── public/
│   ├── index.html          (dashboard)
│   ├── login.html
│   ├── signup.html
│   ├── play.html           (intégration du pivot.html v2)
│   ├── room.html
│   ├── tournaments.html
│   ├── shop.html
│   ├── leaderboard.html
│   ├── profile.html
│   ├── css/style.css       (style Brawl Stars)
│   ├── js/                 (scripts clients : auth, shop, matchmaking, game UI)
│   └── assets/             (icônes, badges de rank, fonts)
├── .env.example            (DATABASE_URL, JWT_SECRET, PORT)
├── .gitignore
├── render.yaml             (config render.com)
└── README.md               (instructions de déploiement)
```

Le serveur doit pouvoir démarrer avec `npm install && npm start` et fonctionner avec juste une `DATABASE_URL` fournie en variable d'environnement.

---

## 7. Déploiement sur render.com

### `render.yaml` à inclure dans le ZIP :

```yaml
services:
  - type: web
    name: pivot-online
    env: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: pivot-db
          property: connectionString
      - key: JWT_SECRET
        generateValue: true
      - key: NODE_ENV
        value: production

databases:
  - name: pivot-db
    plan: free
```

### Instructions pour l'utilisateur (à mettre dans le `README.md`) :

1. Créer un compte sur render.com.
2. Connecter ton repo GitHub (ou utiliser "New Web Service" → uploader le ZIP via un repo).
3. render.com détecte le `render.yaml` et crée automatiquement :
   - Un service web Node.js
   - Une base PostgreSQL gratuite
4. La variable `DATABASE_URL` est automatiquement injectée depuis la DB.
5. Au premier démarrage, le script `init-db.js` crée toutes les tables automatiquement.
6. Le site est accessible sur `https://pivot-online.onrender.com` (URL à vérifier après déploiement).

### Contraintes render.com à respecter :

- **Plan gratuit** : le service "sleep" après 15 min d'inactivité. Le premier démarrage peut prendre 30-60 s. Pas grave pour un projet perso.
- **PostgreSQL gratuit** : 90 jours de rétention, 1 GB de stockage. Suffisant.
- **WebSockets** : supportés par render.com (socket.io fonctionne out of the box).
- **Build** : `npm install` doit suffire. Pas de build frontend complexe (vanilla HTML/CSS/JS).
- **Start command** : `node server.js` ou `npm start` (définir `"start": "node server.js"` dans `package.json`).

---

## 8. README.md à inclure

Le `README.md` du ZIP doit contenir :
- Description du projet (plateforme multiplayer pour le jeu PIVOT).
- Lien vers les règles (`pivot_regles_v2.md`).
- Stack technique.
- Instructions d'installation locale (`npm install`, `cp .env.example .env`, remplir `DATABASE_URL`, `npm start`).
- Instructions de déploiement render.com (cf. §7).
- Liste des routes de l'API REST + des events socket.io.
- Schéma de la DB.
- Notes sur l'économie (PC, coffres, ranks).

---

## 9. Contraintes et qualité

- **Sécurité** : tous les mots de passe hashés (bcrypt), validation des inputs côté serveur, jamais de SQL string concatenation (utiliser des requêtes paramétrées via `pg`), JWT avec expiration.
- **État du jeu côté serveur uniquement** : le client ne fait que des intentions de coup, jamais de calcul de victoire. Le serveur est l'arbitre.
- **Anti-triche** : vérifier que le joueur a bien la capacité en stock avant de valider un tp/diagonale/virage. Décrémenter immédiatement.
- **Robustesse** : si un joueur se déconnecte en pleine partie, il a 60 s pour revenir. Au-delà, il perd par forfait.
- **Logs** : logger les matchs, les achats, les montées de rank pour debug.
- **Performance** : le matchmaking doit répondre en < 30 s même avec peu de joueurs. Les requêtes DB doivent être indexées (index sur `pseudo`, `trophies`, `elo`).

---

## 10. Plan d'exécution suggéré pour l'agent

1. Lire `pivot.html` (v1) et `pivot_regles_v2.md` (règles).
2. Mettre à jour `pivot.html` en v2 (ajouter tp, diagonale, 2 virages, règle de défaite étendue). Tester que ça marche en local.
3. Scaffold le projet Node.js (Express + socket.io + pg).
4. Écrire `init-db.js` (toutes les tables).
5. Écrire l'auth (signup + login + JWT).
6. Porter la logique du jeu côté serveur (`game/rules.js`).
7. Implémenter le matchmaking (file d'attente + appariement Elo).
8. Implémenter le socket de jeu (coups en temps réel, validation, victoire).
9. Implémenter l'inventaire + consommation à l'usage.
10. Implémenter la boutique (achat capacités + coffres + ouverture).
11. Implémenter les salons privés.
12. Implémenter les tournois (bracket).
13. Implémenter le système de rank + TR + récompenses.
14. Implémenter le leaderboard.
15. Construire toutes les pages HTML avec le style Brawl Stars.
16. Écrire le `render.yaml` + `.env.example` + `README.md`.
17. Tout zipper dans `pivot-online.zip`.

---

## Résumé pour l'agent

Tu construis une plateforme web Node.js/HTML/PostgreSQL déployable sur render.com, qui wrappe le jeu PIVOT (règles v2 du .md fourni) avec : authentification, matchmaking Elo, salons privés, tournois, boutique (PC + capacités consommables + 5 niveaux de coffres), système de rank à 18 paliers avec récompenses, classement public, le tout avec une UI très colorée style Brawl Stars. Tout est auto-créé en DB au démarrage. Tu livres un ZIP complet prêt à déployer. Les fichiers `pivot.html` et `pivot_regles_v2.md` sont tes sources de vérité pour la logique du jeu.
