# Documentation technique — SunuSanté Famille

Guide complet pour comprendre, faire évoluer et dépanner le projet.

---

## 1. Vue d'ensemble de l'architecture

```
┌─────────────┐      HTTP/JSON       ┌─────────────┐      SQL       ┌──────────────┐
│  Frontend   │  ───────────────►    │   Backend   │  ───────────►  │  PostgreSQL  │
│  React+Vite │   /api/*  (proxy)    │   Express   │   Drizzle ORM  │              │
│  (Nginx)    │  ◄───────────────    │             │  ◄───────────  │              │
└─────────────┘        JSON          └─────────────┘                └──────────────┘
   port 8080               port 4000                                    port 5432
 (FRONTEND_PORT)         (BACKEND_PORT)                              (DB_HOST_PORT)
```

- **Frontend** : application React (Vite) — une "single page app" (SPA). Toute la
  navigation se fait côté navigateur via `react-router-dom`, sans rechargement de page.
- **Backend** : API REST Express. Chaque ressource (`members`, `appointments`, ...)
  a son propre fichier de routes dans `Backend/src/routes/`.
- **Base de données** : PostgreSQL, avec le schéma décrit en JavaScript via
  **Drizzle ORM** (`Backend/src/db/schema.js`). Drizzle génère et exécute le SQL,
  vous n'écrivez jamais de SQL brut sauf besoin spécifique.
- **Docker** : `docker-compose.yml` démarre les 3 services ensemble sur un réseau
  Docker interne. Le frontend (Nginx) sert les fichiers statiques et fait office de
  reverse-proxy vers le backend pour toutes les requêtes `/api/*`.

---

## 2. Structure des dossiers

```
.
├── docker-compose.yml       # orchestration des 3 services
├── .env.example              # variables d'environnement pour Docker (à copier en .env)
├── README.md                  # démarrage rapide
├── DOCUMENTATION.md           # ce fichier
│
├── Backend/
│   ├── server.js               # point d'entrée : démarre Express sur PORT
│   ├── drizzle.config.js       # config Drizzle (chemin du schéma, connexion DB)
│   ├── docker-entrypoint.sh    # applique les migrations (src/db/migrate.js) puis lance le serveur
│   ├── Dockerfile
│   ├── .env.example
│   └── src/
│       ├── app.js               # déclare le serveur Express + branche les routes
│       ├── db/
│       │   ├── index.js          # connexion PostgreSQL (pool + instance drizzle)
│       │   └── schema.js         # définition des tables (LA source de vérité du modèle de données)
│       └── routes/
│           ├── families.js       # GET/POST/DELETE /api/families
│           ├── members.js        # GET/POST/PUT/DELETE /api/members
│           ├── appointments.js   # GET/POST/PUT/DELETE /api/appointments
│           ├── treatments.js     # GET/POST/PUT/DELETE /api/treatments
│           ├── vaccinations.js   # GET/POST/DELETE /api/vaccinations
│           ├── documents.js      # GET/POST/DELETE /api/documents
│           ├── dashboard.js      # GET /api/dashboard (agrégation multi-tables)
│           └── health.js         # GET /api/health (vérifie la connexion DB)
│
└── Frontend/
    ├── index.html                # point d'entrée HTML
    ├── vite.config.js            # config Vite + proxy /api en dev
    ├── tailwind.config.js
    ├── nginx.conf                # config Nginx utilisée en Docker (prod)
    ├── Dockerfile
    └── src/
        ├── main.jsx                # point d'entrée React (Router, Toaster, Provider)
        ├── App.jsx                 # déclaration des routes (react-router-dom)
        ├── index.css                # styles globaux + Tailwind
        ├── context/
        │   └── FamilyContext.jsx    # état global : famille sélectionnée, liste des familles
        ├── lib/
        │   └── utils.js              # helpers (dates, couleurs, constantes partagées)
        ├── components/
        │   ├── layout/                # Sidebar, Topbar, AppShell (structure de page)
        │   ├── members/                # MemberAvatar
        │   └── ui/                     # Button, Input, Select, Textarea, Modal, Badge
        └── pages/
            ├── Dashboard.jsx
            ├── Membres.jsx
            ├── RendezVous.jsx
            ├── Traitements.jsx
            ├── Vaccinations.jsx
            └── Documents.jsx
```

---

## 3. Backend — comment faire les modifications courantes

### 3.1 Ajouter un champ à une table existante

Exemple : ajouter un champ `phoneNumber` aux membres.

1. **Modifier le schéma** — `Backend/src/db/schema.js` :
   ```js
   export const members = pgTable("members", {
     // ...champs existants
     phoneNumber: varchar("phone_number", { length: 30 }),
   });
   ```
2. **Générer puis appliquer la migration** (voir §5.1) :
   - `cd Backend && npm run db:generate -- --name ajout_telephone_membre` : crée un
     fichier SQL dans `Backend/drizzle/`, à relire puis à versionner avec git ;
   - en local : `npm run db:migrate` ; en Docker : `docker compose up --build backend`
     (l'entrypoint applique les migrations à chaque démarrage).
3. **Mettre à jour la route** concernée (`Backend/src/routes/members.js`) pour lire/écrire
   le nouveau champ dans les blocs `POST` et `PUT` (`values({...})` et `set({...})`).
4. **Mettre à jour le frontend** : ajouter le champ dans `defaultForm`, dans le formulaire
   JSX (`<Input .../>`), et dans l'affichage de la fiche membre (`Frontend/src/pages/Membres.jsx`).

### 3.2 Ajouter une nouvelle table / ressource

Exemple : ajouter une table `allergies` séparée des membres.

1. **Déclarer la table** dans `Backend/src/db/schema.js` (copier le style des tables
   existantes : `serial("id").primaryKey()`, clé étrangère avec `.references(...)`).
2. **Créer le fichier de routes** `Backend/src/routes/allergies.js` en copiant la
   structure d'un fichier existant simple, par ex. `vaccinations.js` (GET / POST / DELETE).
3. **Brancher la route** dans `Backend/src/app.js` :
   ```js
   import allergiesRouter from "./routes/allergies.js";
   app.use("/api/allergies", allergiesRouter);
   ```
4. **Générer et appliquer la migration** : `npm run db:generate -- --name <description>`,
   puis `npm run db:migrate` (ou reconstruire le conteneur backend en Docker).
5. Côté frontend, créer la page ou le composant correspondant (voir section 4).

### 3.3 Ajouter un nouvel endpoint sur une ressource existante

Chaque fichier de `Backend/src/routes/` est un `express.Router()` classique. Pour ajouter
un endpoint, par exemple une recherche : `GET /api/members/search?q=...` :

```js
router.get("/search", async (req, res) => {
  const { q } = req.query;
  const results = await db.select().from(members).where(ilike(members.firstName, `%${q}%`));
  res.json(results);
});
```
Pensez à importer `ilike` (ou l'opérateur voulu) depuis `drizzle-orm`.

### 3.4 Comprendre les conventions utilisées

- Toutes les routes suivent le même schéma : `try { ... } catch (error) { console.error(error); res.status(500).json({ error: "Erreur serveur" }); }`.
- Les filtres par `familyId` passent systématiquement par une sous-requête sur `members`
  (voir `appointments.js`, `treatments.js`, etc.) car ces tables sont liées à `members`,
  pas directement à `families`.
- Les suppressions PostgreSQL sont en cascade (`onDelete: "cascade"` dans le schéma) :
  supprimer un membre supprime automatiquement ses rendez-vous, traitements, etc.
  supprimer une famille supprime tous ses membres (et donc toutes leurs données).

### 3.5 Variables d'environnement

En Docker, toutes se règlent dans le fichier `.env` à la racine (modèle :
`.env.example`) ; hors Docker, le backend lit `Backend/.env` (modèle :
`Backend/.env.example`). « Obligatoire » : docker compose (ou le serveur)
refuse de démarrer sans elle.

| Variable | Rôle | Défaut / exemple |
|---|---|---|
| `POSTGRES_USER` | Utilisateur PostgreSQL (Docker) | `postgres` |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL (Docker) — **obligatoire** | — |
| `POSTGRES_DB` | Nom de la base (Docker) | `santefamille` |
| `PGADMIN_EMAIL` | Identifiant pgAdmin (profil `dev`) | `admin@santefamille.com` |
| `PGADMIN_PASSWORD` | Mot de passe pgAdmin — **obligatoire** (même sans le profil `dev`) | — |
| `DATABASE_URL` | Connexion PostgreSQL (hors Docker ; construite automatiquement en Docker) | `postgresql://postgres:…@127.0.0.1:5432/santefamille` |
| `PORT` | Port d'écoute d'Express (dans le conteneur : 4000) | `4000` |
| `NODE_ENV` | `production` (défaut de l'image Docker) : secrets faibles ou `COOKIE_SECURE` ≠ `true` empêchent le démarrage ; `development` : simple avertissement | `production` (Docker) |
| `JWT_ACCESS_SECRET` | Signature des sessions (15 min) — **obligatoire**, ≥ 32 caractères | chaîne aléatoire |
| `JWT_REFRESH_SECRET` | Signature des renouvellements (30 j) — **obligatoire**, ≥ 32 caractères, différent du précédent | chaîne aléatoire |
| `COOKIE_SECURE` | Cookies envoyés en HTTPS uniquement — `true` obligatoire en production | `true` (Docker) |
| `EMERGENCY_TOKEN_KEY` | Clé de chiffrement des jetons de fiche d'urgence (facultative ; dérivée de `JWT_ACCESS_SECRET` à défaut) | chaîne aléatoire |
| `FRONTEND_URL` | Adresse publique de l'application : liens des courriels, seule origine autorisée (CORS, contrôle d'origine) | `http://localhost:8080` |
| `APP_TIMEZONE` | Fuseau des rappels (« aujourd'hui », heures de prise) | `Africa/Dakar` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Serveur d'envoi des courriels | `mailhog` / `1025` / `false` |
| `SMTP_USER` / `SMTP_PASS` | Identifiants SMTP (vides pour MailHog) | — |
| `SMTP_FROM` | Expéditeur des courriels | `SunuSanté Famille <no-reply@santefamille.local>` |
| `MAIL_WEBHOOK_SECRET` | Secret des rebonds de courriel : en-tête `X-Webhook-Secret` sur `POST /api/webhooks/mail` (préférable), ou adresse `/api/webhooks/mail/<secret>` ; vide = désactivé | — |
| `FRONTEND_PORT` | Port hôte du frontend | `8080` |
| `BACKEND_PORT` | Port hôte de l'API (127.0.0.1 seulement) | `4000` |
| `DB_HOST_PORT` | Port hôte de PostgreSQL (127.0.0.1 seulement) | `5432` |
| `PGADMIN_PORT` | Port hôte de pgAdmin (profil `dev`) | `5050` |
| `MAILHOG_SMTP_PORT` / `MAILHOG_UI_PORT` | Ports hôte de MailHog (profil `dev`) | `1025` / `8025` |
| `TEST_DATABASE_URL` | Base des tests automatisés (nom finissant par `_test`) | `postgresql://postgres:postgres@127.0.0.1:15432/santefamille_test` |

Les outils de développement (pgAdmin, MailHog) ne démarrent qu'avec le profil
`dev` : `docker compose --profile dev up`. La base de test, avec le profil
`test` : `docker compose --profile test up -d db-test`.

---

## 4. Frontend — comment faire les modifications courantes

### 4.1 Ajouter une nouvelle page

1. Créer `Frontend/src/pages/MaPage.jsx` — copier la structure d'une page existante
   simple comme `Vaccinations.jsx` : `AppShell`, chargement de données via `useEffect` +
   `fetch`, formulaire dans une `Modal`.
2. Déclarer la route dans `Frontend/src/App.jsx` :
   ```jsx
   import MaPage from "./pages/MaPage.jsx";
   // ...
   <Route path="/ma-page" element={<MaPage />} />
   ```
3. Ajouter l'entrée dans le menu de navigation — `Frontend/src/components/layout/Sidebar.jsx`
   (tableau `navItems`) et éventuellement dans `Frontend/src/components/layout/Topbar.jsx`
   (objet `pageTitles`, pour afficher le bon titre en haut de page).

### 4.2 Ajouter un champ à un formulaire existant

Dans la page concernée (ex. `Frontend/src/pages/Membres.jsx`) :
1. Ajouter la clé dans `defaultForm`.
2. Ajouter le champ dans le JSX de la `Modal` de formulaire :
   `<Input label="..." value={form.monChamp} onChange={f("monChamp")} />`
3. Le helper `f("monChamp")` (déjà présent dans chaque page) gère automatiquement la
   mise à jour de l'état — aucune autre modification n'est nécessaire côté état local.
4. Vérifier que le backend accepte bien ce champ (voir section 3.1).

### 4.3 Créer un nouveau composant réutilisable

- Composants génériques (boutons, champs, badges...) → `Frontend/src/components/ui/`
- Composants liés aux membres → `Frontend/src/components/members/`
- Composants de structure de page (menu, en-tête...) → `Frontend/src/components/layout/`

Convention : composants fonctionnels, `export function NomDuComposant(props) { ... }`,
style avec les classes Tailwind directement dans le JSX (pas de fichiers `.css` séparés).

### 4.4 Modifier le style global

- Couleurs, espacements, etc. : classes Tailwind directement dans les composants.
- Pour étendre la palette Tailwind (nouvelles couleurs, polices) : `Frontend/tailwind.config.js`.
- Styles globaux (scrollbar, animations) : `Frontend/src/index.css`.

### 4.5 Comprendre les appels API depuis le frontend

Toutes les requêtes utilisent `fetch("/api/...")` avec des chemins **relatifs** (pas
d'URL complète). Cela fonctionne dans les deux environnements :
- **En développement** (`npm run dev`), Vite redirige `/api/*` vers `http://localhost:4000`
  grâce au proxy défini dans `Frontend/vite.config.js`.
- **En Docker (production)**, Nginx redirige `/api/*` vers le service `backend` grâce à
  `Frontend/nginx.conf`.

Ne jamais coder en dur `http://localhost:4000` dans le code React : cela casserait le
fonctionnement en Docker.

### 4.6 État global : `FamilyContext`

`Frontend/src/context/FamilyContext.jsx` fournit à toute l'application :
- `families` : liste des familles
- `selectedFamily` : famille actuellement affichée
- `setSelectedFamily(f)` : changer de famille active
- `loadFamilies()` : recharger la liste (à appeler après création/suppression d'une famille)

Utilisation dans une page : `const { selectedFamily } = useFamily();`

---

## 5. Base de données

### 5.1 Modifier le schéma

Toute modification de structure (nouvelle table, nouveau champ, changement de type)
se fait **uniquement** dans `Backend/src/db/schema.js`. Ne jamais modifier la base de
données directement en SQL — cela désynchroniserait le schéma Drizzle de la réalité.

Après modification, le changement passe par une **migration versionnée** :

1. `cd Backend && npm run db:generate -- --name <description>` : drizzle-kit compare
   le schéma au dernier état enregistré (`Backend/drizzle/meta/`) et écrit un fichier
   SQL dans `Backend/drizzle/`. Le relire (et le compléter si des données doivent
   être converties), puis le versionner avec git.
2. Appliquer : en local `npm run db:migrate` ; en Docker, reconstruire et redémarrer
   le backend (`docker compose up --build backend`) — `docker-entrypoint.sh` lance
   `node src/db/migrate.js` à chaque démarrage, qui n'applique que les migrations
   manquantes (et s'arrête en erreur plutôt que de démarrer sur un schéma incohérent).

`drizzle-kit push` n'est plus utilisé : il modifiait la base sans trace et pouvait
supprimer des colonnes avant que leurs données soient converties. drizzle-kit est une
dépendance de développement : il n'est pas installé dans l'image Docker.

### 5.2 Se connecter directement à la base (debug)

En Docker :
```bash
docker compose exec db psql -U postgres -d santefamille
```
Commandes utiles une fois connecté : `\dt` (lister les tables), `\d members` (décrire
la table `members`), `SELECT * FROM members;`.

### 5.3 Réinitialiser complètement la base

```bash
docker compose down -v   # supprime aussi le volume db_data (⚠️ perte de toutes les données)
docker compose up --build
```

---

## 6. Docker — commandes utiles

| Action                                        | Commande                                              |
|------------------------------------------------|--------------------------------------------------------|
| Démarrer tous les services                     | `docker compose up`                                     |
| Démarrer en reconstruisant les images           | `docker compose up --build`                              |
| Démarrer en arrière-plan                        | `docker compose up -d`                                    |
| Voir les logs en direct (tous les services)     | `docker compose logs -f`                                   |
| Voir les logs d'un seul service                 | `docker compose logs -f backend`                             |
| Redémarrer un seul service                      | `docker compose restart backend`                                |
| Reconstruire un seul service après modif code   | `docker compose up --build backend`                               |
| Arrêter les services (garde les données)        | `docker compose down`                                               |
| Arrêter et supprimer les données PostgreSQL      | `docker compose down -v`                                             |
| Ouvrir un shell dans le conteneur backend        | `docker compose exec backend sh`                                      |
| Lister les conteneurs actifs                     | `docker compose ps`                                                     |

**Important** : pendant le développement actif (modifications fréquentes), il est plus
rapide de travailler **hors Docker** (option B du README, avec `npm run dev` sur les deux
projets) et de ne se servir de Docker que pour valider le résultat final ou déployer.
Docker rebuild l'image à chaque changement de code, ce qui est plus lent que le rechargement
à chaud de Vite/nodemon.

### 6.1 Activer le rechargement à chaud en Docker (optionnel, avancé)

Par défaut, les Dockerfiles copient le code au moment du build (pas de live-reload). Pour du
développement actif directement en conteneur, il faudrait ajouter des volumes montés dans
`docker-compose.yml` (ex. `./Backend:/app`) et utiliser `nodemon`/`vite dev` comme commande
de démarrage plutôt que `node server.js`/le build Nginx. Ce n'est pas configuré par défaut
ici pour garder une image de production simple et légère.

---

## 7. Dépannage courant

| Symptôme                                                  | Cause probable / solution                                                                 |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `docker compose up` échoue sur le service `backend`         | Vérifier que `db` est bien "healthy" (`docker compose ps`) ; consulter `docker compose logs backend` |
| Le frontend affiche une erreur réseau sur les appels `/api`  | Vérifier que le service `backend` tourne et que `Frontend/nginx.conf` pointe bien vers `backend:4000` |
| Modifications du code non visibles après `docker compose up` | Ajouter `--build` pour forcer la reconstruction de l'image concernée                             |
| Le backend s'arrête au démarrage : « Échec des migrations »   | Lire `docker compose logs backend` : une migration de `Backend/drizzle/` n'a pas pu s'appliquer ; corriger puis relancer |
| Le backend s'arrête : « Secrets JWT trop faibles » ou « COOKIE_SECURE doit valoir "true" » | `NODE_ENV=production` (défaut Docker) : secrets d'au moins 32 caractères, différents, et `COOKIE_SECURE=true` dans `.env` (voir §9) |
| `docker compose up` : « La variable … est requise »         | Remplir dans `.env` les variables obligatoires (`POSTGRES_PASSWORD`, `PGADMIN_PASSWORD`, secrets JWT) |
| Erreur CORS en développement local (hors Docker)               | Vérifier que `FRONTEND_URL` dans `Backend/.env` correspond bien à l'URL du frontend (`http://localhost:5173`) |
| « Origine refusée » (403) sur toute modification                | L'adresse utilisée dans le navigateur ne correspond ni à `FRONTEND_URL` ni à l'hôte reçu par l'API : aligner `FRONTEND_URL` (et `FRONTEND_PORT`) |
| Erreur 429 « Trop de requêtes » / « Trop de tentatives »         | Limites par adresse IP et par compte (en mémoire) : attendre 15 minutes, ou redémarrer le backend en développement |
| Les données disparaissent après un `docker compose down`        | Normal si vous avez utilisé `-v` (supprime le volume). Sans `-v`, les données PostgreSQL persistent |
| Port déjà utilisé (`5432`, `4000` ou `8080`)                       | Un autre service tourne déjà sur ce port ; changer `DB_HOST_PORT`, `BACKEND_PORT` ou `FRONTEND_PORT` dans `.env` (et aligner `FRONTEND_URL`) |

---

## 8. Aller plus loin

Déjà en place : comptes avec vérification de l'adresse, sessions (JWT en cookies
`httpOnly`), « Mot de passe oublié », limite des tentatives de connexion, accès
dossier par dossier, téléversement réel des fichiers (`multer`, servis uniquement
aux comptes autorisés) et tests d'API (Vitest + Supertest).

Pistes restantes :

- **Mise en ligne** : voir §9 ; sauvegardes régulières de PostgreSQL et du volume
  `uploads_data`.
- **Limites de tentatives et de requêtes** : les compteurs sont en mémoire (un seul
  serveur, remis à zéro au redémarrage). Avec plusieurs instances, les stocker en base
  ou dans Redis.
- **Tests de l'interface** : `vitest` + `@testing-library/react` côté frontend.

---

## 9. Sécurité en production

L'application manipule des **données de santé** : les règles ci-dessous ne sont pas
optionnelles pour une mise en ligne.

1. **HTTPS obligatoire.** Servir l'application uniquement en HTTPS (certificat Let's
   Encrypt via un reverse proxy — Caddy, Traefik, Nginx — placé devant le conteneur
   `frontend`, ou hébergeur qui le fournit). Rediriger tout le HTTP vers HTTPS.
2. **`COOKIE_SECURE=true`.** Les cookies de session ne voyagent alors qu'en HTTPS. Avec
   `NODE_ENV=production` (défaut de l'image Docker), le backend **refuse de démarrer**
   sinon. En local, `true` fonctionne aussi sur `http://localhost` (Chrome, Edge,
   Firefox) ; pour un essai en HTTP sur une autre adresse (IP du réseau local, Safari),
   utiliser `NODE_ENV=development` et `COOKIE_SECURE=false` — jamais en production.
3. **Secrets forts.** `JWT_ACCESS_SECRET` et `JWT_REFRESH_SECRET` : au moins 32
   caractères aléatoires, différents l'un de l'autre, jamais la valeur d'exemple (le
   backend refuse de démarrer en production sinon). Générer :
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
   Définir aussi `EMERGENCY_TOKEN_KEY` (même méthode) : sans elle, la clé de
   chiffrement des jetons de fiche d'urgence est dérivée de `JWT_ACCESS_SECRET`, et
   changer ce dernier empêcherait de réafficher les QR codes (ceux déjà imprimés
   restent valables ; il suffit de les régénérer). Mots de passe PostgreSQL et pgAdmin
   longs et uniques. Ne jamais versionner le fichier `.env`.
4. **HSTS.** Une fois le HTTPS en place et vérifié, activer l'en-tête
   `Strict-Transport-Security` (ligne prête, en commentaire, dans
   `Frontend/security-headers.conf`, ou à poser par le reverse proxy). Ne pas
   l'activer avant : le navigateur refuserait ensuite le site en HTTP pendant un an.
5. **`FRONTEND_URL`** = adresse publique exacte (`https://…`) : elle sert aux liens des
   courriels et c'est la seule origine autorisée à appeler l'API.
6. **API jamais exposée directement.** Le backend fait confiance à un seul proxy
   (`trust proxy` = 1 : l'en-tête `X-Forwarded-For` posé par Nginx) pour connaître
   l'adresse IP des visiteurs (limites par IP). Laisser le port 4000 lié à
   `127.0.0.1` comme dans `docker-compose.yml`. Si un reverse proxy HTTPS est ajouté
   devant Nginx, il y a deux proxys : adapter `app.set("trust proxy", …)` dans
   `Backend/src/app.js`.
7. **Rebonds de courriel.** Si `MAIL_WEBHOOK_SECRET` est défini, le transmettre de
   préférence dans l'en-tête `X-Webhook-Secret` (`POST /api/webhooks/mail`) plutôt
   que dans l'adresse, qui finit dans les journaux d'accès.

Déjà en place : conteneur backend non root, dépendances de production seulement dans
l'image, réponses de l'API en `Cache-Control: no-store`, limites par adresse IP sur les
routes d'authentification et publiques (100 requêtes par quart d'heure), limite des
tentatives de mot de passe (par adresse, par IP, blocage de 15 minutes non
prolongeable), jetons stockés sous forme d'empreinte (et chiffrés pour la fiche
d'urgence), lien médecin ouvert seulement par un clic (pas par les robots des
messageries), objet des courriels de rappel sans donnée de santé, quota de 500 Mo de
fichiers par famille.
