#!/bin/bash

# ECS Backend - Minimal EC2 Deployment Script
# For Ubuntu EC2 instances

set -e

echo "🚀 Deploying ECS Backend on Ubuntu EC2..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Update system
print_status "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
print_status "Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install ArangoDB
print_status "Installing ArangoDB..."
wget -q https://download.arangodb.com/arangodb310/DEBIAN/Release.key
sudo apt-key add Release.key
echo 'deb https://download.arangodb.com/arangodb310/DEBIAN/ /' | sudo tee /etc/apt/sources.list.d/arangodb.list
sudo apt-get update
sudo apt-get install -y arangodb3=3.10.0-1
rm Release.key

# Install PM2
print_status "Installing PM2..."
sudo npm install -g pm2

# Start ArangoDB
print_status "Starting ArangoDB..."
sudo systemctl start arangodb3
sudo systemctl enable arangodb3

# Set ArangoDB password (change this!)
print_status "Setting ArangoDB password..."
sudo arangodb --server.password "ecs2024!" || true

# Install dependencies
print_status "Installing application dependencies..."
npm install

# Setup database
print_status "Setting up ArangoDB database..."
npm run setup-db

# Start application
print_status "Starting application..."
pm2 start server.js --name "ecs-backend"
pm2 save
pm2 startup

# Configure firewall
print_status "Configuring firewall..."
sudo ufw --force enable
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443

# Create .env if not exists
if [ ! -f ".env" ]; then
    print_status "Creating .env file..."
    cat > .env << EOF
PORT=8080
ARANGO_URL=http://localhost:8529
ARANGO_USERNAME=root
ARANGO_PASSWORD=ecs2024!
ARANGO_DATABASE=ecs_backend
JWT_SECRET=ecs_jwt_secret_2024_change_in_production
CORS_ORIGIN=*
EOF
fi

print_status "✅ Deployment completed!"
echo ""
echo "🌐 Application running on: http://$(curl -s ifconfig.me):8080"
echo "📊 PM2 Status:"
pm2 status
echo ""
echo "🔧 Useful commands:"
echo "   pm2 logs ecs-backend    # View logs"
echo "   pm2 restart ecs-backend # Restart app"
echo "   pm2 status              # Check status"
echo ""
print_warning "🔒 Remember to change passwords in .env file!"
