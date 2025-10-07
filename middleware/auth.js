import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../config/environment.js'

export const requireAuth = (req, res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    
    // Enhanced debugging for authentication issues
    console.log(`[Auth Debug] Request: ${req.method} ${req.path}`)
    console.log(`[Auth Debug] Authorization header present: ${!!req.headers.authorization}`)
    console.log(`[Auth Debug] Token extracted: ${!!token}`)
    console.log(`[Auth Debug] JWT_SECRET configured: ${!!JWT_SECRET}`)
    
    if (!token) {
      console.log(`[Auth Debug] No token found in Authorization header`)
      return res.status(401).json({ 
        error: 'unauthorized', 
        detail: 'No token provided. Include Authorization: Bearer <token> header.',
        debug: {
          hasAuthHeader: !!req.headers.authorization,
          authHeaderValue: req.headers.authorization ? 'Bearer ***' : 'none'
        }
      })
    }
    
    const payload = jwt.verify(token, JWT_SECRET)
    console.log(`[Auth Debug] Token verified successfully for user: ${payload.emp_code || payload.sub}`)
    req.user = payload
    next()
  } catch (error) {
    console.error(`[Auth Debug] Token verification failed:`, error.message)
    console.error(`[Auth Debug] Error type:`, error.name)
    
    let errorDetail = 'Token verification failed'
    if (error.name === 'TokenExpiredError') {
      errorDetail = 'Token has expired'
    } else if (error.name === 'JsonWebTokenError') {
      errorDetail = 'Invalid token format or signature'
    } else if (error.name === 'NotBeforeError') {
      errorDetail = 'Token not active yet'
    }
    
    return res.status(401).json({ 
      error: 'unauthorized', 
      detail: errorDetail,
      debug: {
        errorType: error.name,
        errorMessage: error.message
      }
    })
  }
}

export const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) return res.status(403).json({ error: 'forbidden' })
  next()
}

export const requireBranch = (req, res, next) => {
  if (!req.user || !req.user.branch) return res.status(403).json({ error: 'branch_required' })
  next()
}

export const requireBranchAccess = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  
  // Admin and branch users can access any branch
  if (req.user.role === 'admin' || req.user.role === 'branch') {
    return next()
  }
  
  // For regular users, check if they have access to the requested branch
  const requestedBranch = req.params.branchCode || req.query.branch_code
  if (requestedBranch) {
    const userBranchLower = req.user.branch?.toLowerCase()
    const requestedBranchLower = requestedBranch.toLowerCase()
    
    if (userBranchLower !== requestedBranchLower) {
      return res.status(403).json({ error: 'branch_access_denied' })
    }
  }
  
  next()
}
