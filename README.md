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
`JWT_REFRESH_SECRET`, `DOCUMENTS_ENCRYPTION_KEY`. Générer un secret :
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` ;
la clé de chiffrement des documents (32 octets) :
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
— **à sauvegarder à part** (voir « Chiffrement des documents » ci-dessous).
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

### Application installable, hors ligne et notifications push

- **Installer l'application** : menu de l'avatar ou « Mon compte » (Chrome,
  Edge, Android) ; sur iPhone/iPad, Safari → Partager → « Sur l'écran
  d'accueil ». Manifeste `Frontend/public/manifest.webmanifest`, icônes
  `Frontend/public/icons/` (refaites par `npm run icons` dans `Frontend/`).
- **Hors ligne** (§10) : l'interface et les données **déjà consultées sur
  l'appareil** restent lisibles sans réseau (bandeau « Hors ligne — données
  du … ») ; toute écriture exige la connexion (boutons désactivés, requêtes
  refusées). Ces données sont effacées à la déconnexion, au changement de
  compte, à l'expiration de la session et après 7 jours sans connexion.
  Jamais gardés : fichiers des documents, exports, pages publiques.
  Service worker écrit à la main : `Frontend/pwa/service-worker.js`.
- **Notifications push** (Web Push standard, sans service payant) : page
  Notifications → « Cet appareil » → « Recevoir les rappels sur cet
  appareil ». Rappels de prise (avec boutons Pris / Pas pris), de
  rendez-vous, de vaccin, du Village et transferts de gestion, quand la
  préférence « Dans l'application » est cochée. Option par appareil
  « Masquer le détail sur l'écran verrouillé ». Nécessite les clés VAPID
  (facultatives — sans elles le push est désactivé) :
  `cd Backend && npx web-push generate-vapid-keys`, puis `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:…` dans `.env`. Le push exige
  HTTPS (ou `localhost`).
- **Rappels locaux** : application ouverte et hors ligne, les prises du jour
  déjà connues déclenchent l'alerte à l'heure (son et grande alerte en mode
  senior).

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
- **Sécurité** : fichiers téléversés vérifiés par leur contenu, **chiffrés sur
  le disque** (voir ci-dessous) et servis avec un type imposé, en-têtes de sécurité (helmet côté API, `security-headers.conf`
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

### Chiffrement des documents

Les documents médicaux (`uploads/`) et les archives d'export
(`uploads/exports/`) sont **chiffrés sur le disque** (AES-256-GCM) : une copie
du volume des fichiers ou d'une sauvegarde ne livre aucun contenu sans la clé.
Chaque fichier a sa propre clé aléatoire, elle-même chiffrée par la clé
maîtresse `DOCUMENTS_ENCRYPTION_KEY` (32 octets en base64 ou en hexadécimal),
qui n'est jamais en base ni dans le code. Les fichiers sont déchiffrés à la
volée à la consultation, au téléchargement par le lien médecin et dans
l'archive de la famille ; un fichier altéré n'est jamais servi (erreur
journalisée). La base de données, elle, n'est pas chiffrée par ce mécanisme.

- **Générer la clé** :
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  à placer dans `.env` (`DOCUMENTS_ENCRYPTION_KEY=`). Elle est transmise au
  backend et au worker.
- ⚠️ **Perdre cette clé rend tous les documents irrécupérables.** Sauvegardez-la
  **à part** : hors du serveur et hors des sauvegardes de fichiers (gestionnaire
  de mots de passe, coffre-fort de l'équipe…). Une sauvegarde du volume
  `uploads_data` sans la clé est inutilisable — et la clé rangée avec cette
  sauvegarde annulerait la protection.
- En production (`NODE_ENV=production`, défaut de l'image Docker), le backend
  et le worker **refusent de démarrer** si la clé est absente ou invalide. En
  développement, sans clé, une clé est dérivée de `JWT_ACCESS_SECRET` (avec un
  avertissement) : changer ce secret rendrait alors les documents locaux illisibles.
- **Anciens fichiers** (téléversés avant le chiffrement) : chiffrés
  automatiquement au démarrage du backend, sans interruption (copie chiffrée
  vérifiée, puis remplacement de l'original) ; compte rendu dans les journaux :
  `🔐 N document(s) chiffré(s), M déjà chiffré(s), K erreur(s)`.
- **Changer de clé (rotation)** : voir DOCUMENTATION.md §9.1.

### Espace support (administration de la plateforme, acteur A5)

Espace **séparé** de l'application famille, à l'adresse `/admin` (bandeau
permanent « Espace support — aucun accès au contenu médical »). Le support
agit sur les **comptes** et les **métadonnées techniques**, jamais sur les
dossiers : aucune fiche, aucun rendez-vous, traitement, vaccin, document, note,
allergie, fiche d'urgence ni journal de famille ne lui est accessible (vérifié
par `Backend/test/supportCloisonnement.test.js`).

**Créer un compte support** — uniquement en ligne de commande (aucune page ne
le permet). Le mot de passe (24 caractères aléatoires) est affiché une seule
fois, avec le QR code du double facteur à scanner dans une application
d'authentification (Google Authenticator, Microsoft Authenticator, Aegis…) :

```bash
# Docker
docker compose exec backend npm run support:creer -- --email support@exemple.sn --nom "Awa Ndiaye"
docker compose exec backend npm run support:desactiver -- --email support@exemple.sn
docker compose exec backend npm run support:reinitialiser-2fa -- --email support@exemple.sn

# Sans Docker (dans Backend/, base accessible via DATABASE_URL)
npm run support:creer -- --email support@exemple.sn --nom "Awa Ndiaye"
```

- **Connexion** : adresse + mot de passe + code à 6 chiffres (TOTP, un code
  ne sert qu'une fois). 5 échecs bloquent 15 minutes. Session de 30 minutes
  glissantes (cookie `admin_token`, limité à `/api/admin`), déconnexion
  automatique après 30 minutes d'inactivité. Une session famille n'ouvre
  jamais `/api/admin`, une session support n'ouvre aucune route famille.
- **Demandes** (`/admin/demandes`) : « Je n'arrive plus à accéder à mon
  compte » (écran de connexion, UC-50), « Contacter le support » dans
  « Mon compte » (suppression des données UC-51, autre question), « Signaler un
  compte » dans « Comptes & invitations » (UC-52). L'identité est confirmée par
  un lien envoyé à l'adresse du compte ; à défaut (boîte perdue), le support la
  vérifie hors application.
- **Actions** (motif obligatoire, toutes tracées) : lien de réinitialisation
  du mot de passe, déblocage de la connexion, changement d'adresse (identité
  vérifiée hors application), suppression du compte (mêmes règles que « Mon
  compte »), suspension temporaire et réversible d'un compte signalé (levée
  manuelle ou automatique à la date de fin).
- **Journal d'audit** (`/admin/audit`) : ineffaçable (la base refuse toute
  modification ou suppression).
- **Journaux techniques** (`/admin/journaux`, UC-53) : connexions, erreurs
  serveur, courriels, passages du worker, échecs push, limiteurs — métadonnées
  seulement (IP tronquée, destinataire masqué, jamais de corps de requête ni
  de donnée médicale), **purgés après 90 jours** par le worker.

Détails : DOCUMENTATION.md §10.

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
# éditer .env : DATABASE_URL, secrets JWT, DOCUMENTS_ENCRYPTION_KEY, FRONTEND_URL (voir DOCUMENTATION.md §3.5)
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
- Espace support séparé (`/admin`, double facteur) : récupération de compte, suppression des données, suspension d'un compte signalé, journaux techniques et journal d'audit — sans aucun accès au contenu médical
