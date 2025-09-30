#!/bin/bash

# ECS Backend EC2 Deployment Script
# This script sets up the ECS Backend on Ubuntu EC2 instance

set -e

echo "🚀 Starting ECS Backend EC2 Deployment..."
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    print_warning "Running as root. Consider using a non-root user for production."
fi

# Update system packages
print_status "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js (LTS version)
print_status "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    print_status "Node.js already installed: $(node --version)"
fi

# Install PM2 globally
print_status "Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    print_status "PM2 already installed: $(pm2 --version)"
fi

# Create application directory
APP_DIR="/opt/ecs-backend"
print_status "Setting up application directory: $APP_DIR"

sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

# Copy application files
print_status "Copying application files..."
cp -r . $APP_DIR/
cd $APP_DIR

# Create logs directory
mkdir -p logs

# Install dependencies
print_status "Installing Node.js dependencies..."
npm install --production

# Install PM2 startup script
print_status "Setting up PM2 startup script..."
sudo pm2 startup
pm2 save

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    print_status "Creating .env file..."
    cp env.example .env
    print_warning "Please update .env file with your production settings!"
fi

# Set up ArangoDB connection (assuming ArangoDB is already installed)
print_status "Setting up database..."
npm run setup-db

# Import data
print_status "Importing data..."
npm run import-data

# Start application with PM2
print_status "Starting application with PM2..."
npm run pm2:start

# Save PM2 configuration
pm2 save

# Check status
print_status "Checking application status..."
npm run pm2:status

# Show logs
print_status "Showing recent logs..."
npm run pm2:logs --lines 10

echo ""
echo "🎉 Deployment completed successfully!"
echo "=========================================="
echo "Application is running on port 8080"
echo "PM2 process name: ecs-backend"
echo ""
echo "Useful commands:"
echo "  pm2 status                    - Check application status"
echo "  pm2 logs ecs-backend         - View application logs"
echo "  pm2 restart ecs-backend      - Restart application"
echo "  pm2 stop ecs-backend         - Stop application"
echo ""
echo "Application directory: $APP_DIR"
echo "Logs directory: $APP_DIR/logs"
echo ""
echo "🔐 Default login credentials:"
echo "  Admin: ECS001 / password123"
echo "  Test User: TEST001 / password123"
echo ""
print_status "Deployment completed! 🚀"
