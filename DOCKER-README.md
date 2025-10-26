# ECS Backend - Docker Deployment Guide

Complete containerized deployment with ArangoDB included. Deploy anywhere with just Docker!

## 🚀 Quick Start

### Prerequisites

- **Docker** (20.10+)
- **Docker Compose** (2.0+)

### One-Command Deployment

#### Linux/Mac:
```bash
chmod +x docker-start.sh
./docker-start.sh
```

#### Windows (PowerShell):
```powershell
docker-compose up -d --build
timeout /t 15
docker-compose exec backend npm run setup-db
docker-compose exec backend npm run import-data
```

## 📦 What's Included

- **Backend API** - Node.js Express application
- **ArangoDB** - NoSQL database with all data
- **77 Users** - Pre-loaded user accounts
- **28,203 Customers** - Complete customer database
- **22 Branches** - All branch locations
- **Persistent Storage** - Data survives container restarts

## 🔧 Manual Setup

### 1. Start Services

```bash
# Build and start containers
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. Initialize Database

```bash
# Setup database structure
docker-compose exec backend npm run setup-db

# Import all data
docker-compose exec backend npm run import-data
```

### 3. Verify Installation

```bash
# Check health
curl http://localhost:8080/health

# Test API
curl http://localhost:8080/api/health
```

## 🌐 Access Points

| Service | URL | Credentials |
|---------|-----|-------------|
| **Backend API** | http://localhost:8080 | N/A |
| **ArangoDB UI** | http://localhost:8529 | root / (empty) |
| **Health Check** | http://localhost:8080/health | N/A |

## 📝 Common Commands

### Service Management

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose down

# Restart services
docker-compose restart

# View status
docker-compose ps
```

### Logs and Monitoring

```bash
# View all logs
docker-compose logs -f

# View backend logs only
docker-compose logs -f backend

# View ArangoDB logs only
docker-compose logs -f arangodb
```

### Database Operations

```bash
# Access backend container shell
docker-compose exec backend sh

# Run database setup
docker-compose exec backend npm run setup-db

# Export data
docker-compose exec backend npm run dump-data

# Import data
docker-compose exec backend npm run import-data
```

### Container Access

```bash
# Backend shell
docker-compose exec backend sh

# ArangoDB shell
docker-compose exec arangodb arangosh
```

## 🔒 Configuration

### Environment Variables

Edit `.env.docker` or create `.env`:

```env
# ArangoDB Password (leave empty for no auth)
ARANGO_PASSWORD=

# JWT Secret (CHANGE IN PRODUCTION!)
JWT_SECRET=your-super-secret-key-here

# CORS Origin
CORS_ORIGIN=*
```

### Using Custom Environment

```bash
# Use custom .env file
docker-compose --env-file .env.production up -d
```

## 🚢 Deployment Options

### Local Development

```bash
docker-compose up -d
```

### Production Server

```bash
# 1. Clone repository
git clone <your-repo>
cd ECS0-Backend

# 2. Configure environment
cp .env.docker .env
nano .env  # Edit with secure values

# 3. Deploy
./docker-start.sh
```

### Cloud Platforms

#### AWS EC2 / DigitalOcean / Linode

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Clone and deploy
git clone <your-repo>
cd ECS0-Backend
chmod +x docker-start.sh
./docker-start.sh
```

#### Docker Swarm

```bash
docker stack deploy -c docker-compose.yml ecs-backend
```

#### Kubernetes

```bash
# Convert compose file to Kubernetes manifests
kompose convert
kubectl apply -f .
```

## 📊 Data Persistence

Data is stored in Docker volumes:

- `arangodb_data` - Database files
- `arangodb_apps` - ArangoDB applications
- `./uploads` - Uploaded receipts (bind mount)
- `./data` - JSON data dumps (bind mount)

### Backup Data

```bash
# Backup database
docker-compose exec backend npm run dump-data

# Backup volumes
docker run --rm -v ecs0-backend_arangodb_data:/data -v $(pwd):/backup alpine tar czf /backup/arangodb-backup.tar.gz /data

# Backup uploads
tar czf uploads-backup.tar.gz uploads/
```

### Restore Data

```bash
# Restore from JSON dumps
docker-compose exec backend npm run import-data

# Restore volume
docker run --rm -v ecs0-backend_arangodb_data:/data -v $(pwd):/backup alpine tar xzf /backup/arangodb-backup.tar.gz -C /
```

## 🔄 Updates and Maintenance

### Update Application

```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose up -d --build
```

### Scale Services

```bash
# Run multiple backend instances
docker-compose up -d --scale backend=3
```

### Clean Up

```bash
# Stop and remove containers
docker-compose down

# Remove containers and volumes
docker-compose down -v

# Remove all (including images)
docker-compose down -v --rmi all
```

## 🚨 Troubleshooting

### Port Already in Use

```bash
# Check what's using port 8080
netstat -tlnp | grep 8080  # Linux
lsof -i :8080              # Mac
netstat -ano | findstr 8080  # Windows

# Change port in docker-compose.yml
ports:
  - "3000:8080"  # Use port 3000 instead
```

### Database Connection Failed

```bash
# Check ArangoDB logs
docker-compose logs arangodb

# Restart ArangoDB
docker-compose restart arangodb

# Wait for health check
docker-compose ps
```

### Backend Won't Start

```bash
# Check backend logs
docker-compose logs backend

# Rebuild container
docker-compose up -d --build backend

# Access container for debugging
docker-compose exec backend sh
```

### Data Not Loading

```bash
# Re-import data
docker-compose exec backend npm run setup-db
docker-compose exec backend npm run import-data

# Check data files exist
ls -la data/
```

## 📈 Performance Tuning

### Resource Limits

Edit `docker-compose.yml`:

```yaml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 512M
```

### Production Optimizations

```yaml
services:
  backend:
    environment:
      NODE_ENV: production
      UV_THREADPOOL_SIZE: 128
  
  arangodb:
    command: ["arangod", "--server.statistics", "false"]
```

## 🔐 Security Recommendations

1. **Change JWT Secret**
   ```env
   JWT_SECRET=$(openssl rand -hex 32)
   ```

2. **Set ArangoDB Password**
   ```env
   ARANGO_PASSWORD=your-secure-password
   ```

3. **Configure CORS**
   ```env
   CORS_ORIGIN=https://your-frontend-domain.com
   ```

4. **Use HTTPS** with Nginx/Caddy reverse proxy

5. **Network Isolation**
   ```yaml
   networks:
     ecs-network:
       internal: true  # No external access
   ```

## 📞 Support

- Check logs: `docker-compose logs -f`
- Verify health: `curl http://localhost:8080/health`
- Container status: `docker-compose ps`
- Resource usage: `docker stats`

## 📄 Default Credentials

- **Admin User**: `ECS001` / `password123`
- **Test User**: `TEST001` / `password123`
- **ArangoDB**: `root` / (empty password)

---

**✨ Your ECS Backend is now fully containerized and portable!**

Deploy anywhere that supports Docker. No manual dependencies required. 🚀

