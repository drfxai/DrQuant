#!/bin/bash
# DrFX Quant — Quick Re-deploy
set -e
APP_DIR="/var/www/drfx-quant"
cd "$APP_DIR"
echo "📈 Pulling latest code..."
git pull origin main 2>/dev/null || true
echo "📦 Installing dependencies..."
npm install --production
echo "🔄 Restarting..."
pm2 restart drfx-quant
echo "✅ DrFX Quant v5.0 redeployed"
