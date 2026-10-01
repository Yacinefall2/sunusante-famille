#!/bin/sh
set -e

echo "⏳ Application du schéma PostgreSQL (drizzle-kit push)..."
npx drizzle-kit push --force || echo "⚠️  drizzle-kit push a échoué ou n'était pas nécessaire, on continue."

echo "🚀 Démarrage du serveur Express..."
exec node server.js