# SunuSanté Famille — Node.js/Express + React + PostgreSQL

Réécriture du projet (initialement en Next.js) en architecture séparée :

- **Backend/** — API REST Node.js + Express + PostgreSQL (via Drizzle ORM)
- **Frontend/** — Application React (Vite) + React Router + Tailwind CSS

## Prérequis

- Node.js 18+
- PostgreSQL (local ou distant)

## Option A — Lancer avec Docker (recommandé)

Le projet est entièrement dockerisé : PostgreSQL, backend et frontend démarrent
ensemble avec une seule commande.

```bash
cp .env.example .env        # éditer si besoin (identifiants PostgreSQL, CORS)
docker compose up --build
```

- Frontend (React servi par Nginx) : http://localhost:8080
- Backend (API Express) : http://localhost:4000/api/health
- PostgreSQL : exposé sur le port 5432 de la machine hôte

Au démarrage, le conteneur backend applique automatiquement les migrations
versionnées du dossier `Backend/drizzle/` avant de lancer le serveur — aucune
commande manuelle n'est nécessaire. Une base créée par l'ancien
`drizzle-kit push` est reprise automatiquement au premier démarrage.

### Rappels et notifications

Le service `worker` (même image que le backend) passe toutes les minutes :
rappels de rendez-vous (J-3 et J-1), de vaccin (7 jours avant la prochaine
dose) et de prise de médicament (à l'heure, une relance 30 min plus tard),
dans l'application et par courriel selon les préférences de chacun. Un
courriel non remis après 3 tentatives est signalé dans l'application à la
personne et à l'administrateur familial. Fuseau de référence : `APP_TIMEZONE`
(Africa/Dakar par défaut). Journal : `docker compose logs -f worker`.

### Partage médecin et fiche d'urgence

Page « Partage & urgence » (`/partage`) :

- **Lien médecin** (2 h, 24 h ou 7 jours, révocable) : à usage unique, la
  première ouverture le réserve à l'appareil du médecin jusqu'à l'expiration ;
  une ouverture depuis un autre appareil est refusée et signalée. Vue en
  lecture seule `/medecin/:jeton`, imprimable et téléchargeable en PDF.
- **Fiche d'urgence** : rien n'est publié par défaut, le titulaire coche chaque
  information. QR code vers `/urgence/:jeton` (régénérable : l'ancien cesse de
  fonctionner), carte imprimable et image d'écran de verrouillage avec les
  informations vitales en clair. Chaque consultation est journalisée et signalée.

Les liens sont construits à partir de `FRONTEND_URL` : en production, elle
doit être l'adresse publique de l'application.

### Modifier le schéma de la base

1. Modifier `Backend/src/db/schema.js`
2. `cd Backend && npm run db:generate -- --name <description>` : crée un
   fichier SQL dans `Backend/drizzle/` (à relire, puis à versionner avec git)
3. Redémarrer le backend (ou `npm run db:migrate` hors Docker)

### Tests automatisés (backend)

Les tests vérifient notamment l'étanchéité entre familles et les droits
d'administration de l'espace. Ils tournent sur une base jetable dédiée :

```bash
docker compose --profile test up -d db-test   # base de test, port 15432
cd Backend && npm test
```

Pour arrêter :

```bash
docker compose down          # garde les données PostgreSQL (volume db_data)
docker compose down -v       # supprime aussi les données PostgreSQL
```

Pour reconstruire les images après une modification du code :

```bash
docker compose up --build
```

## Option B — Lancer en local (sans Docker)

### 1. Backend

```bash
cd Backend
cp .env.example .env
# éditer .env : DATABASE_URL, PORT, CORS_ORIGIN
npm install
npm run db:migrate   # crée/met à jour les tables à partir des migrations de Backend/drizzle/
npm run dev           # démarre l'API sur http://localhost:4000
```

Endpoints disponibles (tous préfixés par `/api`) :
`/health`, `/families`, `/members`, `/appointments`, `/treatments`, `/vaccinations`, `/documents`, `/dashboard`.

### 2. Frontend

```bash
cd Frontend
npm install
npm run dev            # démarre sur http://localhost:5173
```

En développement, Vite redirige automatiquement les appels `/api/*` vers le backend
(`http://localhost:4000`) via `vite.config.js`.

### 3. Build de production (hors Docker)

```bash
cd Frontend
npm run build           # génère Frontend/dist
```

Pour servir le frontend construit sans passer par Docker, déployez `Frontend/dist`
sur un hébergeur statique (Vercel, Netlify, Nginx...) et pointez-le vers l'URL
publique du backend Express. La méthode recommandée reste toutefois l'option
Docker ci-dessus, qui gère déjà ce proxy via Nginx (`Frontend/nginx.conf`).

## Structure du projet Docker

```
.
├── docker-compose.yml       # orchestre db + backend + frontend
├── .env.example             # variables PostgreSQL / CORS pour Docker
├── Backend/
│   ├── Dockerfile
│   ├── docker-entrypoint.sh # applique le schéma PostgreSQL puis lance le serveur
│   └── .dockerignore
└── Frontend/
    ├── Dockerfile            # build Vite multi-stage → Nginx
    ├── nginx.conf            # sert le SPA + proxy /api vers le backend
    └── .dockerignore
```

## Structure des données (PostgreSQL)

Tables : `families`, `members`, `appointments`, `treatments`, `vaccinations`, `documents`
(voir `Backend/src/db/schema.js`), identiques au schéma d'origine.

## Fonctionnalités

- Gestion multi-familles avec sélection de la famille active
- Membres (fiche médicale : groupe sanguin, allergies, notes)
- Rendez-vous médicaux (statuts : à venir / terminé / annulé)
- Traitements / médicaments (actifs ou terminés)
- Carnet de vaccinations (avec rappels à venir)
- Documents médicaux (ordonnances, résultats, radios, comptes-rendus)
