# ECS Backend - Docker Startup Script for Windows
# PowerShell script to start the entire application stack with Docker

Write-Host "🐳 Starting ECS Backend with Docker..." -ForegroundColor Cyan
Write-Host ""

# Check if Docker is installed
if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker is not installed. Please install Docker Desktop first." -ForegroundColor Red
    exit 1
}

if (!(Get-Command docker-compose -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Docker Compose is not installed. Please install Docker Compose first." -ForegroundColor Red
    exit 1
}

Write-Host "✅ Docker and Docker Compose are installed" -ForegroundColor Green
Write-Host ""

# Stop and remove existing containers
Write-Host "🧹 Cleaning up existing containers..." -ForegroundColor Yellow
docker-compose down 2>$null
Write-Host ""

# Build and start containers
Write-Host "🏗️  Building and starting containers..." -ForegroundColor Cyan
docker-compose up -d --build
Write-Host ""

# Wait for ArangoDB to be ready
Write-Host "⏳ Waiting for ArangoDB to be ready..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Check if ArangoDB is healthy
$maxAttempts = 30
$attempt = 0
$arangoReady = $false

while ($attempt -lt $maxAttempts) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8529/_api/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ ArangoDB is ready" -ForegroundColor Green
            $arangoReady = $true
            break
        }
    }
    catch {
        # Continue waiting
    }
    $attempt++
    Write-Host "   Waiting for ArangoDB... ($attempt/$maxAttempts)" -ForegroundColor Gray
    Start-Sleep -Seconds 2
}

if (-not $arangoReady) {
    Write-Host "❌ ArangoDB failed to start" -ForegroundColor Red
    docker-compose logs arangodb
    exit 1
}

Write-Host ""

# Setup database
Write-Host "📊 Setting up database..." -ForegroundColor Cyan
docker-compose exec -T backend npm run setup-db
Write-Host ""

# Import data
Write-Host "📥 Importing data..." -ForegroundColor Cyan
docker-compose exec -T backend npm run import-data
Write-Host ""

# Check backend health
Write-Host "🏥 Checking backend health..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$attempt = 0
$backendReady = $false

while ($attempt -lt $maxAttempts) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ Backend is healthy" -ForegroundColor Green
            $backendReady = $true
            break
        }
    }
    catch {
        # Continue waiting
    }
    $attempt++
    Write-Host "   Waiting for backend... ($attempt/$maxAttempts)" -ForegroundColor Gray
    Start-Sleep -Seconds 2
}

if (-not $backendReady) {
    Write-Host "❌ Backend failed to start" -ForegroundColor Red
    docker-compose logs backend
    exit 1
}

Write-Host ""
Write-Host "✨ ==========================================" -ForegroundColor Green
Write-Host "✨  ECS Backend is running successfully!" -ForegroundColor Green
Write-Host "✨ ==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "🔗 Backend API:       http://localhost:8080" -ForegroundColor Cyan
Write-Host "🔗 ArangoDB Web UI:   http://localhost:8529" -ForegroundColor Cyan
Write-Host "🔗 Health Check:      http://localhost:8080/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "📊 Default Credentials:" -ForegroundColor Yellow
Write-Host "   Admin: ECS001 / password123"
Write-Host ""
Write-Host "📝 Useful Commands:" -ForegroundColor Yellow
Write-Host "   View logs:        docker-compose logs -f"
Write-Host "   Stop services:    docker-compose down"
Write-Host "   Restart:          docker-compose restart"
Write-Host "   Shell access:     docker-compose exec backend sh"
Write-Host ""
Write-Host "✅ Setup complete!" -ForegroundColor Green

