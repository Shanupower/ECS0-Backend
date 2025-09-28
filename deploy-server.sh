#!/bin/bash

# ECS Application Deployment Script
# This script handles deployment on the server

set -e  # Exit on any error

echo "🚀 Starting ECS Deployment..."

# Configuration
PROJECT_NAME="ECS0-Project"
BACKUP_BASE="/root/deployments-backup"
DEPLOY_DIR="/root/ECS0-Project"
REPO_URL="https://github.com/Shanupower/ECS0-Backend.git"

# Create backup directory
mkdir -p "$BACKUP_BASE"

# Create timestamp for backup
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_BASE/ecs-backup-$TIMESTAMP"

echo "📦 Creating backup of current deployment..."
if [ -d "$DEPLOY_DIR" ]; then
    cp -r "$DEPLOY_DIR" "$BACKUP_DIR"
    echo "✅ Backup created: $BACKUP_DIR"
else
    echo "ℹ️  No existing deployment to backup"
fi

echo "🛑 Stopping current services..."
sudo pm2 stop all || echo "No PM2 processes to stop"

echo "📥 Clearing and preparing deployment directory..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

echo "⬇️  Cloning repository..."
git clone "$REPO_URL" .
echo "✅ Repository cloned successfully"

echo "📋 Installing backend dependencies..."
npm install

echo "📋 Installing frontend dependencies..."
cd ECS0
npm install

echo "🏗️  Building frontend..."
npm run build

echo "🔄 Starting services..."
cd ..
PORT=8080 pm2 start server.js --name ECS-Backend --silent
cd ECS0
pm2 start npx --name ECS-Frontend --silent -- serve -s dist -l 3001

echo "💾 Saving PM2 configuration..."
pm2 save --silent

echo "🧹 Cleaning up..."
rm -rf .git

echo "✅ Deployment completed successfully!"
echo "🔗 Services:"
echo "   Frontend: http://localhost:3001"
echo "   Backend:  http://localhost:8080"
echo "   Database: http://localhost:8529"

# Show PM2 status
echo "📊 Current PM2 Status:"
pm2 status --silent
