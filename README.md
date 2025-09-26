# ECS Backend

Node.js backend with ArangoDB for ECS (Expense Collection System).

## Quick Start

### Local Development

```bash
npm install
npm run setup-db
npm start
```

### EC2 Deployment

```bash
./ec2-deploy.sh
```

## Environment Variables

Copy `env.example` to `.env` and configure:

- ArangoDB connection
- JWT secret
- Server port

## API Endpoints

- **Auth**: `/api/auth/login`
- **Users**: `/api/users/*`
- **Customers**: `/api/customers/*`
- **Receipts**: `/api/receipts/*`
- **Stats**: `/api/stats/*`
- **Health**: `/health`

## Features

- JWT authentication
- User & customer management
- Receipt processing with file uploads
- Statistics & reporting
- ArangoDB document database
- PM2 process management

## Tech Stack

- Node.js + Express
- ArangoDB
- JWT + bcrypt
- Multer (file uploads)
- PM2 (production)
