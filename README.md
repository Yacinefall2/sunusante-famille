# SunuSanté Famille — Node.js/Express + React + PostgreSQL

Réécriture du projet (initialement en Next.js) en architecture séparée :

- **Backend/** — API REST Node.js + Express + PostgreSQL (via Drizzle ORM)
- **Frontend/** — Application React (Vite) + React Router + Tailwind CSS

## Prérequis

- Node.js 20+ (hors Docker ; les images Docker utilisent Node 20)
- PostgreSQL 16 (local, distant, ou celui de docker compose)
- Docker et Docker Compose v2 (option A)

## Option A — Lancer avec Docker (recommandé)

Le projet est entièrement dockerisé : PostgreSQL, backend et frontend démarrent
ensemble avec une seule commande.

```bash
cp .env.example .env        # puis remplir les variables obligatoires (voir ci-dessous)
docker compose --profile dev up --build   # avec MailHog et pgAdmin (développement)
# ou : docker compose up --build          # sans les outils de développement
```

Variables **obligatoires** dans `.env` (docker compose refuse de démarrer sans
elles) : `POSTGRES_PASSWORD`, `PGADMIN_PASSWORD`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`. Générer un secret :
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
L'image backend tourne en `NODE_ENV=production` : elle exige des secrets JWT
d'au moins 32 caractères (différents l'un de l'autre) et `COOKIE_SECURE=true`
(qui fonctionne aussi sur http://localhost). Voir le tableau complet des
variables et la section « Sécurité en production » dans
[DOCUMENTATION.md](DOCUMENTATION.md).

Adresses par défaut (ports réglables dans `.env`) :

| Service | Adresse | Variable de port |
|---|---|---|
| Frontend (React servi par Nginx) | http://localhost:8080 | `FRONTEND_PORT` |
| Backend (API Express, accès direct) | http://localhost:4000/api/health | `BACKEND_PORT` |
| PostgreSQL | 127.0.0.1:5432 | `DB_HOST_PORT` |
| pgAdmin (profil `dev`) | http://localhost:5050 | `PGADMIN_PORT` |
| MailHog, interface web (profil `dev`) | http://localhost:8025 | `MAILHOG_UI_PORT` |
| MailHog, SMTP (profil `dev`) | 127.0.0.1:1025 | `MAILHOG_SMTP_PORT` |

Si vous changez `FRONTEND_PORT`, alignez `FRONTEND_URL` (liens des courriels
et seule origine autorisée à appeler l'API).

L'API, PostgreSQL et les outils ne sont joignables que depuis la machine
elle-même (`127.0.0.1`), jamais depuis le réseau. pgAdmin et MailHog ne
démarrent qu'avec le profil `dev`. Par défaut les courriels partent vers
MailHog (`SMTP_HOST=mailhog`) : sans le profil `dev`, configurez un vrai
serveur SMTP (Gmail, Brevo...) dans `.env`.

Au démarrage, le conteneur backend applique automatiquement les migrations
versionnées du dossier `Backend/drizzle/` (`node src/db/migrate.js`, lancé
par `docker-entrypoint.sh`) avant de lancer le serveur — aucune commande
manuelle n'est nécessaire. Une base créée par l'ancien `drizzle-kit push` est
reprise automatiquement au premier démarrage. Le backend tourne sous
l'utilisateur `node` (non root) ; le service `uploads-permissions` rend le
volume des fichiers téléversés inscriptible par cet utilisateur avant son
démarrage.

### Rappels et notifications

Le service `worker` (même image que le backend) passe toutes les minutes :
rappels de rendez-vous (J-3 et J-1), de vaccin (7 jours avant la prochaine
dose) et de prise de médicament (à l'heure, une relance 30 min plus tard),
dans l'application et par courriel selon les préférences de chacun. Un
courriel non remis après 3 tentatives est signalé dans l'application à la
personne et à l'administrateur familial. Fuseau de référence : `APP_TIMEZONE`
(Africa/Dakar par défaut). Journal : `docker compose logs -f worker`.

### Comptes et connexion

- **Mot de passe oublié** (`/mot-de-passe-oublie`) : un lien valable 1 heure,
  à usage unique, est envoyé par courriel ; une nouvelle demande annule la
  précédente. Changer son mot de passe ferme toutes les sessions ouvertes.
- **Limite des tentatives** : 5 échecs de mot de passe sur une même adresse
  depuis une même connexion (20 toutes connexions confondues, 30 sur une même
  connexion toutes adresses confondues) bloquent pendant 15 minutes, sans
  prolongation. S'applique aussi au mot de passe redemandé dans « Mon compte ».
  Les routes d'authentification et publiques sont en outre limitées à 100
  requêtes par adresse IP et par quart d'heure.
- **Mon compte** (`/compte`, clic sur son nom en haut à droite) : changer son
  nom, son adresse (confirmée par un lien envoyé à la nouvelle, avis envoyé à
  l'ancienne) ou son mot de passe (alerte par courriel, autres appareils
  déconnectés), télécharger ses données (JSON) et supprimer son compte.
- **Sécurité** : fichiers téléversés vérifiés par leur contenu et servis avec
  un type imposé, en-têtes de sécurité (helmet côté API, `security-headers.conf`
  côté Nginx), cookies `SameSite=Strict`, contrôle de l'origine des requêtes,
  jetons d'invitation et de vérification stockés sous forme d'empreinte,
  jeton de fiche d'urgence chiffré, réponses de l'API jamais mises en cache,
  objet des courriels de rappel sans donnée de santé, 20 invitations ou liens
  médecin par compte et par 24 heures, 500 Mo de fichiers par famille.

### Partage médecin et fiche d'urgence

Page « Partage & urgence » (`/partage`) :

- **Lien médecin** (2 h, 24 h ou 7 jours, révocable à tout moment) : envoyé par courriel à l'adresse
  du médecin saisie à la création, avec un bouton d'accès ; il n'est jamais
  affiché à la famille. Si le courriel ne part pas, le lien est supprimé. À
  usage unique : la page affiche d'abord « Dossier médical de X partagé avec
  vous » et un bouton « Ouvrir le dossier » ; c'est ce clic (et non le simple
  chargement, que les robots des messageries déclenchent) qui réserve le lien
  à l'appareil du médecin jusqu'à l'expiration. Une ouverture depuis un autre
  appareil est refusée et signalée. Vue en lecture seule `/medecin/:jeton`,
  imprimable (pas d'export PDF). Un document confidentiel ne peut être partagé
  que par le titulaire du dossier.
- **Fiche d'urgence** : rien n'est publié par défaut, le titulaire coche chaque
  information. QR code vers `/urgence/:jeton` (régénérable : l'ancien cesse de
  fonctionner), carte imprimable et image d'écran de verrouillage avec les
  informations vitales en clair. Chaque consultation est journalisée et signalée.

Les liens sont construits à partir de `FRONTEND_URL` : en production, elle
doit être l'adresse publique de l'application.

### Exports

- **Dossier en PDF** (UC-27) : bouton « Exporter en PDF » sur une fiche et dans
  « Mon compte », pour toute personne qui peut lire ce dossier.
- **Données de la famille** (UC-09, parents) : archive ZIP (un PDF par
  dossier lisible, fichiers des documents, `donnees-famille.json`, journal
  d'activité). Mot de passe ressaisi, puis lien de téléchargement à usage
  unique valable 1 h envoyé par courriel, utilisable seulement connecté avec
  le même compte. L'archive est préparée dans `uploads/exports/` (volume
  partagé avec le worker) et effacée après téléchargement ou expiration.

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
# éditer .env : DATABASE_URL, secrets JWT, FRONTEND_URL (voir DOCUMENTATION.md §3.5)
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
├── .env.example             # variables d'environnement pour Docker (à copier en .env)
├── Backend/
│   ├── Dockerfile
│   ├── docker-entrypoint.sh # applique les migrations (src/db/migrate.js) puis lance le serveur
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
