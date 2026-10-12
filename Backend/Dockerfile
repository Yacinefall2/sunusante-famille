# ── Backend SunuSanté Famille — Node.js + Express + PostgreSQL (Drizzle) ──────────
FROM node:20-alpine

WORKDIR /app

# Dépendances de production seulement, versions exactes du package-lock.json.
# drizzle-kit (dépendance de développement) n'est pas nécessaire au
# démarrage : les migrations sont appliquées par src/db/migrate.js, qui
# n'utilise que drizzle-orm.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copier le reste du code source (voir .dockerignore : ni .env, ni fichiers
# téléversés, ni tests)
COPY . .

# Dossier des fichiers téléversés (monté en volume par docker-compose.yml) :
# créé ici et confié à l'utilisateur « node », qui fait tourner le serveur.
# Le code, lui, reste en lecture seule pour cet utilisateur.
RUN chmod +x docker-entrypoint.sh \
  && mkdir -p /app/uploads \
  && chown node:node /app/uploads

ENV NODE_ENV=production
EXPOSE 4000

# Jamais root : une faille dans le serveur ne donne pas la main sur le conteneur.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
