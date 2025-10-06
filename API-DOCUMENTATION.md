# ECS Backend API Documentation

## Base URL

```
http://localhost:8080
```

## Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

---

## 🔐 Authentication Endpoints

### POST `/api/auth/login`

**Description**: User login with employee code and password
**Rate Limit**: 100 requests per 15 minutes
**Body**:

```json
{
  "emp_code": "EMP001",
  "password": "password123"
}
```

**Response**:

```json
{
  "token": "jwt-token",
  "user": {
    "id": "user_key",
    "emp_code": "EMP001",
    "role": "admin|user",
    "name": "User Name",
    "branch": "Branch Name",
    "branch_code": "BR001"
  }
}
```

### POST `/api/auth/branch-login`

**Description**: Branch-specific login
**Rate Limit**: 100 requests per 15 minutes
**Body**:

```json
{
  "emp_code": "EMP001",
  "password": "password123",
  "branch_code": "BR001"
}
```

---

## 👥 User Management

### GET `/api/users/me`

**Description**: Get current user profile
**Auth Required**: Yes
**Response**: Current user details

### GET `/api/users`

**Description**: Get all users (Admin only)
**Auth Required**: Yes (Admin role)
**Query Parameters**:

- `page`: Page number (default: 1)
- `size`: Page size (default: 20)
- `search`: Search term
- `role`: Filter by role
- `branch_code`: Filter by branch

### POST `/api/users`

**Description**: Create new user (Admin only)
**Auth Required**: Yes (Admin role)
**Body**:

```json
{
  "emp_code": "EMP001",
  "name": "User Name",
  "email": "user@example.com",
  "role": "user",
  "branch_code": "BR001",
  "password": "password123"
}
```

### PATCH `/api/users/:id`

**Description**: Update user (Admin only)
**Auth Required**: Yes (Admin role)

### PATCH `/api/users/:id/password`

**Description**: Change user password
**Auth Required**: Yes

### DELETE `/api/users/:id`

**Description**: Delete user (Admin only)
**Auth Required**: Yes (Admin role)

---

## 👤 Customer Management

### GET `/api/customers`

**Description**: Get all customers with filtering and pagination
**Auth Required**: Yes
**Query Parameters**:

- `page`: Page number (default: 1)
- `size`: Page size (default: 20, max: 200)
- `sort`: Sort field and direction (e.g., "created_at:desc")
- `search`: Search term
- `includeDeleted`: Include deleted records (0 or 1)

**Response**:

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "size": 20,
    "total": 1000,
    "pages": 50
  }
}
```

### GET `/api/customers/:id`

**Description**: Get customer by ID
**Auth Required**: Yes

### POST `/api/customers`

**Description**: Create new customer
**Auth Required**: Yes
**Body**: Customer data with optional file uploads

### PATCH `/api/customers/:id`

**Description**: Update customer
**Auth Required**: Yes

### DELETE `/api/customers/:id`

**Description**: Delete customer
**Auth Required**: Yes

### GET `/api/customers/search`

**Description**: Search customers with enhanced pagination and filtering
**Auth Required**: Yes
**Query Parameters**:

- `q`: Search query (minimum 2 characters)
- `limit`: Result limit (default: 20, max: 100)
- `page`: Page number (default: 1)
- `sort`: Sort field and direction (e.g., "name:asc", "investor_id:desc")

**Response**:
```json
{
  "customers": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1000,
    "totalPages": 50,
    "hasNext": true,
    "hasPrev": false
  },
  "branch_filter": "HO",
  "user_role": "branch_user"
}
```

### GET `/api/customers/search/advanced`

**Description**: Advanced customer search with fulltext search capabilities
**Auth Required**: Yes
**Query Parameters**:

- `q`: Search query (minimum 2 characters)
- `limit`: Result limit (default: 20, max: 100)
- `page`: Page number (default: 1)
- `sort`: Sort field and direction (default: "name:asc")
- `useFulltext`: Use fulltext search (default: true)

**Response**:
```json
{
  "customers": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1000,
    "totalPages": 50,
    "hasNext": true,
    "hasPrev": false
  },
  "branch_filter": "HO",
  "user_role": "branch_user",
  "search_method": "fulltext"
}
```

---

## 🧾 Receipt Management

### GET `/api/receipts`

**Description**: Get all receipts with filtering
**Auth Required**: Yes
**Query Parameters**:

- `page`: Page number
- `size`: Page size
- `sort`: Sort field and direction
- `emp_code`: Filter by employee
- `investor_id`: Filter by investor
- `date_from`: Start date
- `date_to`: End date
- `product_category`: Filter by category
- `includeDeleted`: Include deleted records

### GET `/api/receipts/emp/:empCode`

**Description**: Get receipts by employee code
**Auth Required**: Yes

### GET `/api/receipts/:id`

**Description**: Get receipt by ID
**Auth Required**: Yes

### POST `/api/receipts`

**Description**: Create new receipt
**Auth Required**: Yes
**Body**: Receipt data with optional file uploads

### PATCH `/api/receipts/:id`

**Description**: Update receipt
**Auth Required**: Yes

### PATCH `/api/receipts/:id/status`

**Description**: Update receipt status
**Auth Required**: Yes
**Body**:

```json
{
  "status": "approved|rejected|pending"
}
```

### DELETE `/api/receipts/:id`

**Description**: Delete receipt
**Auth Required**: Yes

### POST `/api/receipts/:id/restore`

**Description**: Restore deleted receipt (Admin only)
**Auth Required**: Yes (Admin role)

---

## 📁 Receipt Media Management

### POST `/api/receipts/:id/media`

**Description**: Upload media files for receipt
**Auth Required**: Yes
**Content-Type**: multipart/form-data
**Body**: File uploads (screenshots, documents)

### GET `/api/receipts/:id/media`

**Description**: Get all media files for receipt
**Auth Required**: Yes

### GET `/api/receipts/:id/media/:mediaId`

**Description**: Get specific media file
**Auth Required**: Yes

### DELETE `/api/receipts/:id/media/:mediaId`

**Description**: Delete media file
**Auth Required**: Yes

---

## 🏢 Branch Management

### GET `/api/branches`

**Description**: Get all branches
**Auth Required**: Yes

### GET `/api/branches/:branchCode`

**Description**: Get branch details
**Auth Required**: Yes

### GET `/api/branches/:branchCode/stats`

**Description**: Get branch statistics
**Auth Required**: Yes

### GET `/api/branches/:branchCode/receipts`

**Description**: Get receipts for specific branch
**Auth Required**: Yes

### POST `/api/branches`

**Description**: Create new branch (Admin only)
**Auth Required**: Yes (Admin role)

### PUT `/api/branches/:branchCode`

**Description**: Update branch (Admin only)
**Auth Required**: Yes (Admin role)

### DELETE `/api/branches/:branchCode`

**Description**: Delete branch (Admin only)
**Auth Required**: Yes (Admin role)

### POST `/api/branches/:branchCode/users`

**Description**: Add user to branch (Admin only)
**Auth Required**: Yes (Admin role)

---

## 📊 Statistics & Analytics

### GET `/api/stats/summary`

**Description**: Get overall statistics summary
**Auth Required**: Yes
**Response**:

```json
{
  "total_customers": 1000,
  "total_receipts": 5000,
  "total_amount": 1000000,
  "active_users": 50
}
```

### GET `/api/stats/by-category`

**Description**: Get statistics by product category
**Auth Required**: Yes

### GET `/api/stats/by-day`

**Description**: Get daily statistics
**Auth Required**: Yes

### GET `/api/stats/branches`

**Description**: Get branch-wise statistics
**Auth Required**: Yes

---

## 📤 Export Endpoints

### GET `/api/export/receipts`

**Description**: Export receipts data
**Auth Required**: Yes
**Query Parameters**:

- `format`: csv|excel
- `date_from`: Start date
- `date_to`: End date
- `emp_code`: Filter by employee

### GET `/api/export/customers`

**Description**: Export customers data
**Auth Required**: Yes

### GET `/api/export/users`

**Description**: Export users data (Admin only)
**Auth Required**: Yes (Admin role)

### GET `/api/export/branches`

**Description**: Export branches data (Admin only)
**Auth Required**: Yes (Admin role)

---

## 🐛 Issue Management

### POST `/api/issues`

**Description**: Create new issue report
**Body**: Issue details with optional file upload

### GET `/api/issues`

**Description**: Get all issues (Admin only)
**Auth Required**: Yes (Admin role)

### PATCH `/api/issues/:id/status`

**Description**: Update issue status (Admin only)
**Auth Required**: Yes (Admin role)

---

## 🔍 System Endpoints

### GET `/`

**Description**: API server status
**Response**:

```json
{
  "message": "ECS Backend API Server",
  "status": "online",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0"
}
```

### GET `/api/health`

**Description**: API health check
**Response**:

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600
}
```

### GET `/health`

**Description**: Database connection health check
**Response**:

```json
{
  "ok": true
}
```

---

## 📁 File Uploads

### Static Files

Uploaded files are served at:

```
http://localhost:8080/uploads/receipts/<filename>
```

### File Upload Limits

- Maximum file size: 10MB per file
- Maximum files per upload: 10
- Allowed file types: images, PDFs, documents

---

## 🔒 Security Features

### Rate Limiting

- Authentication endpoints: 100 requests per 15 minutes
- Other endpoints: No specific rate limiting

### Role-Based Access Control

- **Admin**: Full access to all endpoints
- **User**: Limited access based on branch and permissions

### Branch-Based Filtering

- Users can only access data from their assigned branch (unless admin)

---

## 📝 Error Responses

### Standard Error Format

```json
{
  "error": "error_code",
  "message": "Human readable error message"
}
```

### Common Error Codes

- `missing_fields`: Required fields are missing
- `invalid_credentials`: Login credentials are invalid
- `unauthorized`: Authentication required
- `forbidden`: Insufficient permissions
- `not_found`: Resource not found
- `validation_error`: Data validation failed

---

## 🚀 Getting Started

1. **Login**: POST to `/api/auth/login` to get JWT token
2. **Set Authorization Header**: Include token in all subsequent requests
3. **Explore Data**: Use GET endpoints to retrieve data
4. **Create Records**: Use POST endpoints to add new data
5. **Update Records**: Use PATCH/PUT endpoints to modify data
6. **Export Data**: Use export endpoints to download data

---

_This API documentation is automatically generated based on the current route definitions._
