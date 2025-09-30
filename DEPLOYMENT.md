# ECS Backend - EC2 Deployment Guide

## 🚀 One-Click Deployment

This guide provides a complete one-click deployment solution for the ECS Backend on AWS EC2 Ubuntu instances.

### Prerequisites

- AWS EC2 Ubuntu instance (Ubuntu 20.04+ recommended)
- ArangoDB installed and running on port 8529
- Nginx configured to proxy port 8080 (already set up as per requirements)

### Quick Deployment

1. **Clone the repository on your EC2 instance:**
   ```bash
   git clone <your-repo-url>
   cd ECS0-Backend
   ```

2. **Run the deployment script:**
   ```bash
   chmod +x deploy-ec2.sh
   ./deploy-ec2.sh
   ```

That's it! The application will be deployed and running on port 8080.

## 📦 What Gets Deployed

### Application Structure
```
/opt/ecs-backend/
├── server.js                 # Main application file
├── package.json             # Dependencies and scripts
├── ecosystem.config.js      # PM2 configuration
├── config/                  # Configuration files
├── routes/                  # API routes
├── middleware/              # Express middleware
├── scripts/                 # Utility scripts
├── data/                    # Data dumps
├── uploads/                 # File uploads directory
└── logs/                    # Application logs
```

### Data Included
- **77 Users** - All user accounts with default password `password123`
- **28,203 Customers** - Complete customer database
- **22 Branches** - All branch locations and configurations

### Default Login Credentials
- **Admin User**: `ECS001` / `password123`
- **Test User**: `TEST001` / `password123`

## 🔧 PM2 Management

The application runs under PM2 for process management and auto-restart.

### PM2 Commands
```bash
# Check application status
npm run pm2:status

# View logs
npm run pm2:logs

# Restart application
npm run pm2:restart

# Stop application
npm run pm2:stop

# Delete application from PM2
npm run pm2:delete
```

### PM2 Features
- **Auto-restart** on crashes
- **Memory monitoring** (restart if > 1GB)
- **Log rotation** with timestamps
- **Startup script** (auto-start on server reboot)

## 📊 API Endpoints

The application provides 45+ API endpoints across 9 categories:

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/branch-login` - Branch login

### User Management
- `GET /api/users/me` - Current user profile
- `GET /api/users` - List users (Admin)
- `PATCH /api/users/:id` - Update user
- `PATCH /api/users/:id/password` - Change password

### Customer Management
- `GET /api/customers` - List customers with pagination
- `GET /api/customers/:id` - Get customer details
- `PATCH /api/customers/:id` - Update customer
- `GET /api/customers/search` - Search customers

### Branch Management
- `GET /api/branches` - List all branches
- `PUT /api/branches/:branchCode` - Update branch

### Statistics & Export
- `GET /api/stats/summary` - Overall statistics
- `GET /api/export/customers` - Export customer data

See `API-DOCUMENTATION.md` for complete endpoint documentation.

## 🔒 Security Features

- **JWT Authentication** for all protected endpoints
- **Role-based Access Control** (Admin/User roles)
- **Branch-based Data Filtering** for users
- **Rate Limiting** on authentication endpoints
- **Password Hashing** with bcrypt

## 📁 File Structure

```
ECS0-Backend/
├── server.js                    # Main application
├── package.json                 # Dependencies & scripts
├── ecosystem.config.js          # PM2 configuration
├── deploy-ec2.sh               # Deployment script
├── setup-arangodb.js           # Database setup
├── config/
│   ├── database.js             # Database connection
│   └── environment.js          # Environment variables
├── routes/
│   ├── auth.js                 # Authentication routes
│   ├── users.js                # User management
│   ├── customers.js            # Customer management
│   ├── branches.js             # Branch management
│   ├── receipts.js             # Receipt management
│   ├── stats.js                # Statistics
│   └── export.js               # Data export
├── middleware/
│   ├── auth.js                 # Authentication middleware
│   └── upload.js               # File upload middleware
├── scripts/
│   ├── dump-data.js            # Data export script
│   └── import-data.js          # Data import script
├── data/
│   ├── users.json              # Users data dump
│   ├── customers.json          # Customers data dump
│   ├── branches.json           # Branches data dump
│   └── data-summary.json       # Data summary
└── logs/                       # Application logs
```

## 🚨 Troubleshooting

### Application Not Starting
```bash
# Check PM2 status
npm run pm2:status

# View logs for errors
npm run pm2:logs

# Restart application
npm run pm2:restart
```

### Database Connection Issues
```bash
# Check ArangoDB is running
curl http://localhost:8529/_api/version

# Test database connection
curl http://localhost:8080/health
```

### Port Issues
```bash
# Check if port 8080 is in use
sudo netstat -tlnp | grep :8080

# Check PM2 processes
pm2 list
```

## 🔄 Updates and Maintenance

### Updating the Application
1. Pull latest changes: `git pull`
2. Install dependencies: `npm install`
3. Restart application: `npm run pm2:restart`

### Data Backup
```bash
# Create data backup
npm run dump-data

# Backup files will be in ./data/ directory
```

### Log Monitoring
```bash
# View real-time logs
npm run pm2:logs

# View error logs only
pm2 logs ecs-backend --err

# View combined logs
pm2 logs ecs-backend --raw
```

## 📞 Support

For issues or questions:
1. Check the logs: `npm run pm2:logs`
2. Verify database connection: `curl http://localhost:8080/health`
3. Check PM2 status: `npm run pm2:status`

---

**Deployment completed successfully! 🎉**

The ECS Backend is now running on your EC2 instance with:
- ✅ PM2 process management
- ✅ Auto-restart on crashes
- ✅ Complete data import
- ✅ Production-ready configuration
- ✅ Comprehensive logging
