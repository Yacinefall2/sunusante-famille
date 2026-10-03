# ── Backend SunuSanté Famille — Node.js + Express + PostgreSQL (Drizzle) ──────────
FROM node:20-alpine

WORKDIR /app

# Installer toutes les dépendances (drizzle-kit est nécessaire au démarrage
# pour appliquer le schéma via l'entrypoint)
COPY package*.json ./
RUN npm install --no-audit --no-fund

# Copier le reste du code source
COPY . .

RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
