# 🐳 Quick Start - Docker Deployment

## Windows (Your Current System)

### Option 1: PowerShell Script (Easiest)
```powershell
.\docker-start.ps1
```

### Option 2: Manual Commands
```powershell
# Start everything
docker-compose up -d --build

# Wait 15 seconds for ArangoDB
Start-Sleep -Seconds 15

# Setup database
docker-compose exec backend npm run setup-db

# Import data
docker-compose exec backend npm run import-data

# Check status
docker-compose ps
```

### Option 3: Using NPM Scripts
```powershell
npm run docker:build
npm run docker:up
# Wait 15 seconds
docker-compose exec backend npm run setup-db
docker-compose exec backend npm run import-data
```

## Access Your Application

- **Backend API**: http://localhost:8080
- **ArangoDB UI**: http://localhost:8529
- **Health Check**: http://localhost:8080/health

**Login**: `ECS001` / `password123`

## Common Commands

```powershell
# View logs
docker-compose logs -f

# Stop everything
docker-compose down

# Restart
docker-compose restart

# Access backend shell
docker-compose exec backend sh

# View running containers
docker-compose ps
```

## Troubleshooting

### Port 8080 Already in Use
Kill the process first:
```powershell
netstat -ano | findstr :8080
taskkill /PID <PID> /F
```

Then restart Docker:
```powershell
docker-compose down
docker-compose up -d
```

### Can't Connect to Database
```powershell
# Restart ArangoDB
docker-compose restart arangodb

# Check logs
docker-compose logs arangodb
```

### Fresh Start (Clean Everything)
```powershell
# Stop and remove everything including data
docker-compose down -v

# Start fresh
.\docker-start.ps1
```

## What's Running?

- **2 Containers**:
  - `ecs-backend` - Your Node.js API
  - `ecs-arangodb` - Database with all your data
  
- **Data Volumes**:
  - `arangodb_data` - Database files (persistent)
  - `./uploads` - Receipt files
  - `./data` - JSON data dumps

## Next Steps

1. ✅ Start with `.\docker-start.ps1`
2. ✅ Visit http://localhost:8080/health
3. ✅ Login to http://localhost:8080
4. ✅ Access ArangoDB UI at http://localhost:8529

**That's it! Your entire backend + database is running! 🚀**

