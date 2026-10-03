# ── Frontend SunuSanté Famille — build React/Vite ─────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

# ── Étape finale : Nginx sert les fichiers statiques + proxy /api ───────────
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# 127.0.0.1 et non localhost : dans le conteneur, localhost résout vers IPv6
# (::1) alors que nginx n'écoute qu'en IPv4.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]
