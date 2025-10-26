#!/bin/bash

# ECS Backend - Docker Startup Script
# This script starts the entire application stack with Docker

set -e

echo "🐳 Starting ECS Backend with Docker..."
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

echo "✅ Docker and Docker Compose are installed"
echo ""

# Stop and remove existing containers
echo "🧹 Cleaning up existing containers..."
docker-compose down 2>/dev/null || true
echo ""

# Build and start containers
echo "🏗️  Building and starting containers..."
docker-compose up -d --build
echo ""

# Wait for ArangoDB to be ready
echo "⏳ Waiting for ArangoDB to be ready..."
sleep 10

# Check if ArangoDB is healthy
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if docker-compose exec -T arangodb wget -q --spider http://localhost:8529/_api/version 2>/dev/null; then
        echo "✅ ArangoDB is ready"
        break
    fi
    attempt=$((attempt + 1))
    echo "   Waiting for ArangoDB... ($attempt/$max_attempts)"
    sleep 2
done

if [ $attempt -eq $max_attempts ]; then
    echo "❌ ArangoDB failed to start"
    docker-compose logs arangodb
    exit 1
fi

echo ""

# Setup database
echo "📊 Setting up database..."
docker-compose exec -T backend npm run setup-db
echo ""

# Import data
echo "📥 Importing data..."
docker-compose exec -T backend npm run import-data
echo ""

# Check backend health
echo "🏥 Checking backend health..."
sleep 5
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        echo "✅ Backend is healthy"
        break
    fi
    attempt=$((attempt + 1))
    echo "   Waiting for backend... ($attempt/$max_attempts)"
    sleep 2
done

if [ $attempt -eq $max_attempts ]; then
    echo "❌ Backend failed to start"
    docker-compose logs backend
    exit 1
fi

echo ""
echo "✨ =========================================="
echo "✨  ECS Backend is running successfully!"
echo "✨ =========================================="
echo ""
echo "🔗 Backend API:       http://localhost:8080"
echo "🔗 ArangoDB Web UI:   http://localhost:8529"
echo "🔗 Health Check:      http://localhost:8080/health"
echo ""
echo "📊 Default Credentials:"
echo "   Admin: ECS001 / password123"
echo ""
echo "📝 Useful Commands:"
echo "   View logs:        docker-compose logs -f"
echo "   Stop services:    docker-compose down"
echo "   Restart:          docker-compose restart"
echo "   Shell access:     docker-compose exec backend sh"
echo ""
echo "✅ Setup complete!"

