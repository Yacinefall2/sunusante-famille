# Documentation technique — SantéFamille

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
├── .env.example              # variables PostgreSQL / CORS pour Docker
├── README.md                  # démarrage rapide
├── DOCUMENTATION.md           # ce fichier
│
├── Backend/
│   ├── server.js               # point d'entrée : démarre Express sur PORT
│   ├── drizzle.config.js       # config Drizzle (chemin du schéma, connexion DB)
│   ├── docker-entrypoint.sh    # applique le schéma DB puis lance le serveur
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
2. **Appliquer le changement à la base de données** :
   - En local : `cd Backend && npm run db:push`
   - En Docker : `docker compose restart backend` (l'entrypoint réapplique le schéma
     automatiquement à chaque démarrage), ou directement :
     `docker compose exec backend npx drizzle-kit push --force`
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
4. **Appliquer le schéma** : `npm run db:push` (ou redémarrer le conteneur backend en Docker).
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

### 3.5 Variables d'environnement backend (`Backend/.env`)

| Variable       | Description                                   | Exemple                                                    |
|----------------|------------------------------------------------|--------------------------------------------------------------|
| `PORT`         | Port d'écoute du serveur Express               | `4000`                                                        |
| `DATABASE_URL` | Chaîne de connexion PostgreSQL                 | `postgresql://postgres:postgres@127.0.0.1:5432/santefamille` |
| `CORS_ORIGIN`  | Origine autorisée à appeler l'API (hors Docker)| `http://localhost:5173`                                      |

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

Après modification :
- En local : `cd Backend && npm run db:push`
- En Docker : redémarrer le conteneur backend (`docker compose restart backend`), ou
  `docker compose exec backend npx drizzle-kit push --force`

`db:push` compare le schéma déclaré au schéma réel de la base et applique la différence
directement (pratique en développement). Pour un vrai projet en production avec plusieurs
environnements, on utiliserait plutôt `npm run db:generate` (génère un fichier de migration
SQL versionné dans `Backend/drizzle/`) suivi d'une exécution de migration — voir la
documentation officielle de Drizzle si ce besoin se présente.

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
| `drizzle-kit push` demande une confirmation et bloque         | Utiliser le flag `--force` (déjà inclus dans `docker-entrypoint.sh`) ; en local : `npx drizzle-kit push --force` |
| Erreur CORS en développement local (hors Docker)               | Vérifier que `CORS_ORIGIN` dans `Backend/.env` correspond bien à l'URL du frontend (`http://localhost:5173`) |
| Les données disparaissent après un `docker compose down`        | Normal si vous avez utilisé `-v` (supprime le volume). Sans `-v`, les données PostgreSQL persistent |
| Port déjà utilisé (`5432`, `4000` ou `8080`)                       | Un autre service tourne déjà sur ce port ; modifier le mapping de port dans `docker-compose.yml` (ex. `"5433:5432"`) |

---

## 8. Aller plus loin

- **Authentification** : le projet n'a actuellement aucune authentification (toute
  personne ayant accès à l'URL peut voir/modifier toutes les familles). Pour un usage
  réel, il faudrait ajouter un système de connexion (ex. sessions ou JWT) avant de
  déployer publiquement.
- **Upload de fichiers réel** : la page Documents stocke actuellement un simple lien
  URL (`fileUrl`) plutôt qu'un vrai fichier téléversé. Pour un vrai upload, il faudrait
  ajouter un service de stockage (ex. dossier local avec `multer`, ou un service cloud
  type S3) côté backend.
- **Tests automatisés** : aucun test n'est présent actuellement. Pour en ajouter :
  `vitest` ou `jest` côté backend, `vitest` + `@testing-library/react` côté frontend.