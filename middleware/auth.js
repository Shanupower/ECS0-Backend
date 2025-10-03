import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../config/environment.js'

export const requireAuth = (req, res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ error: 'unauthorized' })
    
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload
    next()
  } catch (error) {
    console.error('Auth error:', error.message)
    return res.status(401).json({ error: 'unauthorized' })
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
