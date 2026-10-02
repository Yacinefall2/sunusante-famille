#!/bin/sh
set -e

# Migrations versionnées (dossier drizzle/). En cas d'échec, le conteneur
# s'arrête : mieux vaut ne pas démarrer que tourner sur un schéma incohérent.
echo "⏳ Application des migrations PostgreSQL..."
node src/db/migrate.js

echo "🚀 Démarrage du serveur Express..."
exec node server.js
