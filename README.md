# ECS Backend - Financial Services API

A production-ready Node.js backend API for ECS Financial Services, built with Express.js and ArangoDB.

## 🚀 Quick Deployment

**One-Click EC2 Deployment:**

```bash
git clone <your-repo-url>
cd ECS0-Backend
chmod +x deploy-ec2.sh
./deploy-ec2.sh
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment guide.

## ✨ Features

- **🔐 Authentication**: JWT-based authentication with role-based access control
- **👥 User Management**: Complete user CRUD operations with branch-based filtering
- **👤 Customer Management**: 28,203+ customer records with pagination and search
- **🧾 Receipt Management**: Receipt processing with file upload support
- **🏢 Branch Management**: 22 branch locations with multi-location support
- **📊 Statistics**: Real-time analytics and reporting
- **📤 Export**: Data export functionality (CSV/Excel)
- **📁 File Uploads**: Secure file upload handling for receipts and documents
- **🔄 PM2 Process Management**: Auto-restart, monitoring, and logging

## 📊 Database Overview

- **77 Users** - Complete user accounts with authentication
- **28,203 Customers** - Full customer/investor database
- **22 Branches** - All branch locations and configurations
- **Production Ready** - Optimized indexes and constraints

## 🛠️ Technology Stack

- **Backend**: Node.js 18+ with Express.js
- **Database**: ArangoDB (Multi-model NoSQL)
- **Authentication**: JWT with bcrypt password hashing
- **Process Management**: PM2 for production deployment
- **File Handling**: Multer for secure file uploads
- **Security**: CORS, rate limiting, input validation

## 🚀 Quick Start

### Local Development

1. **Prerequisites:**

   - Node.js 18.11.0+
   - ArangoDB 3.8+ (or Docker)

2. **Setup:**

   ```bash
   git clone <repository-url>
   cd ECS0-Backend
   npm install
   cp env.example .env
   npm run setup-db
   npm run dev
   ```

3. **Access:**
   - API: `http://localhost:8080`
   - Health Check: `http://localhost:8080/health`

### Default Credentials

- **Admin**: `ECS001` / `password123`
- **Test User**: `TEST001` / `password123`

## 📚 API Documentation

Complete API documentation with 45+ endpoints available in [API-DOCUMENTATION.md](./API-DOCUMENTATION.md)

### Key Endpoints

| Category      | Endpoint                    | Description                      |
| ------------- | --------------------------- | -------------------------------- |
| **Auth**      | `POST /api/auth/login`      | User authentication              |
| **Users**     | `GET /api/users`            | User management (Admin)          |
| **Customers** | `GET /api/customers`        | Customer listing with pagination |
| **Branches**  | `GET /api/branches`         | Branch information               |
| **Stats**     | `GET /api/stats/summary`    | System statistics                |
| **Export**    | `GET /api/export/customers` | Data export                      |

## 🏗️ Project Structure

```
ECS0-Backend/
├── server.js                    # Main application
├── ecosystem.config.js          # PM2 configuration
├── deploy-ec2.sh               # EC2 deployment script
├── config/
│   ├── database.js             # Database connection
│   └── environment.js          # Environment variables
├── routes/                     # API route handlers
│   ├── auth.js                 # Authentication
│   ├── users.js                # User management
│   ├── customers.js            # Customer management
│   ├── branches.js             # Branch management
│   └── ...
├── middleware/
│   ├── auth.js                 # JWT authentication
│   └── upload.js               # File upload handling
├── scripts/
│   ├── dump-data.js            # Data export
│   └── import-data.js          # Data import
└── data/                       # Data dumps for deployment
```

## 🔧 Available Scripts

### Development

- `npm run dev` - Development server with auto-reload
- `npm start` - Production server

### Database

- `npm run setup-db` - Set up ArangoDB database and collections
- `npm run dump-data` - Export data to JSON files
- `npm run import-data` - Import data from JSON files

### PM2 Management

- `npm run pm2:start` - Start with PM2
- `npm run pm2:restart` - Restart application
- `npm run pm2:stop` - Stop application
- `npm run pm2:logs` - View logs

### Deployment

- `npm run deploy` - Complete deployment (setup + import + start)

## 🔒 Security Features

- **JWT Authentication** with role-based access control
- **Branch-based Data Filtering** for user isolation
- **Rate Limiting** on authentication endpoints
- **Password Hashing** with bcrypt (10 rounds)
- **Input Validation** and sanitization
- **CORS Protection** with configurable origins
- **File Upload Security** with size limits and type validation

## 📊 Database Schema

### Collections & Indexes

| Collection    | Key Features                    | Indexes                                        |
| ------------- | ------------------------------- | ---------------------------------------------- |
| **users**     | Authentication, roles, branches | `emp_code` (unique), `is_active`               |
| **customers** | Investor data, relationships    | `investor_id` (unique), `pan` (unique, sparse) |
| **branches**  | Location data, managers         | `branch_name` (unique), `is_active`            |
| **receipts**  | Transaction records             | `user_id`, `emp_code`, `date`, `is_deleted`    |

## 🌐 Production Deployment

### EC2 Ubuntu Deployment

1. **Run deployment script:**

   ```bash
   ./deploy-ec2.sh
   ```

2. **Features included:**
   - ✅ PM2 process management
   - ✅ Auto-restart on crashes
   - ✅ Complete data import
   - ✅ Production configuration
   - ✅ Comprehensive logging
   - ✅ Startup script for server reboots

### Environment Configuration

| Variable     | Production Value      | Description        |
| ------------ | --------------------- | ------------------ |
| `PORT`       | 8080                  | Server port        |
| `NODE_ENV`   | production            | Environment        |
| `ARANGO_URL` | http://localhost:8529 | Database URL       |
| `JWT_SECRET` | [secure-key]          | JWT signing secret |

## 📈 Performance & Monitoring

- **PM2 Process Management** with auto-restart
- **Memory Monitoring** (restart if > 1GB)
- **Comprehensive Logging** with timestamps
- **Health Check Endpoints** for monitoring
- **Database Connection Pooling** for optimal performance

## 🚨 Troubleshooting

### Common Issues

1. **Application not starting:**

   ```bash
   npm run pm2:status
   npm run pm2:logs
   ```

2. **Database connection issues:**

   ```bash
   curl http://localhost:8080/health
   ```

3. **Port conflicts:**
   ```bash
   sudo netstat -tlnp | grep :8080
   ```

## 📞 Support

- **Health Check**: `GET /health` - Database connectivity
- **API Status**: `GET /` - Application status
- **Logs**: `npm run pm2:logs` - Application logs

## 📄 License

Proprietary software for ECS Financial Services.

---

**Ready for production deployment! 🚀**

For detailed deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)
