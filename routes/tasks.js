import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const TASK_STATUSES = ['pending', 'in_progress', 'done', 'cancelled']
const TASK_PRIORITIES = ['low', 'medium', 'high']

async function ensureTasksCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('tasks')
  const exists = await col.exists()
  if (!exists) {
    await col.create()
  }
  return getCollection('tasks')
}

function normalizeBranch(branch) {
  if (!branch) return null
  return String(branch).trim().toUpperCase()
}

// Get current user's branch from DB (for manager/employee)
async function getCurrentUserBranch(userId) {
  const users = await q(`
    FOR user IN users
    FILTER user._key == @id
    LIMIT 1
    RETURN { branch: user.branch, emp_code: user.emp_code }
  `, { id: userId })
  return users.length ? users[0] : null
}

// Resolve assignee user by _key or emp_code and check branch for manager
async function resolveAssignee(assigneeId, currentUser) {
  if (!assigneeId) return null
  const users = await q(`
    FOR user IN users
    FILTER user._key == @aid OR user.emp_code == @aid
    FILTER user.is_active == true
    LIMIT 1
    RETURN user
  `, { aid: String(assigneeId).trim() })
  if (!users.length) return null
  const u = users[0]
  if (currentUser.role === 'admin') return u
  if (currentUser.role === 'manager') {
    const me = await getCurrentUserBranch(currentUser.sub)
    if (!me || !me.branch) return null
    const assigneeBranch = normalizeBranch(u.branch)
    const myBranch = normalizeBranch(me.branch)
    if (assigneeBranch !== myBranch) return null
    return u
  }
  if (currentUser.role === 'employee' || currentUser.role === 'branch') {
    if (u._key !== currentUser.sub && u.emp_code !== currentUser.emp_code) return null
    return u
  }
  return u
}

// Build list filter: employee sees own, manager sees branch, admin sees all
async function buildListFilter(req) {
  const role = req.user.role
  const sub = req.user.sub
  const empCode = req.user.emp_code

  if (role === 'admin') {
    return { filterAql: '', bindVars: {} }
  }

  if (role === 'manager') {
    const me = await getCurrentUserBranch(sub)
    if (!me || !me.branch) {
      return { filterAql: 'FILTER false', bindVars: {} }
    }
    const branchNorm = normalizeBranch(me.branch)
    return {
      filterAql: 'FILTER task.branch != null && UPPER(TRIM(task.branch)) == @branchNorm',
      bindVars: { branchNorm }
    }
  }

  // employee, branch, or any other: own tasks only (assignee_id = sub or emp_code)
  return {
    filterAql: 'FILTER task.assignee_id == @sub || task.assignee_emp_code == @empCode',
    bindVars: { sub, emp_code: empCode || '' }
  }
}

// POST / - Create task
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, description, assignee_id, due_date, priority } = req.body || {}
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'validation_error', detail: 'title is required' })
    }

    const assignee = await resolveAssignee(assignee_id || req.user.sub, req.user)
    if (!assignee) {
      return res.status(400).json({ error: 'validation_error', detail: 'Invalid or unauthorized assignee' })
    }

    const status = 'pending'
    const priorityVal = TASK_PRIORITIES.includes(priority) ? priority : 'medium'
    const me = await getCurrentUserBranch(req.user.sub)
    const branch = (me && me.branch) ? me.branch : null

    const taskDoc = {
      title: title.trim(),
      description: description ? String(description).trim() : null,
      assignee_id: assignee._key,
      assignee_emp_code: assignee.emp_code,
      assigned_by_id: req.user.sub,
      assigned_by_emp_code: req.user.emp_code || null,
      due_date: due_date || null,
      status,
      priority: priorityVal,
      branch,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const col = await ensureTasksCollection()
    const result = await col.save(taskDoc)
    res.status(201).json({
      id: result._key,
      _key: result._key,
      ...taskDoc
    })
  } catch (error) {
    console.error('Error creating task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET / - List tasks (with optional overdue=1, status, due_from, due_to, assignee_id for admin/manager)
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureTasksCollection()
    const { status, due_from, due_to, assignee_id, overdue, limit = '100', page = '1' } = req.query
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100))
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const skipNum = (pageNum - 1) * limitNum

    const scope = await buildListFilter(req)
    const bindVars = { ...scope.bindVars }

    let filterParts = [scope.filterAql].filter(Boolean)

    if (status) {
      const statusList = status.split(',').map(s => s.trim()).filter(Boolean)
      if (statusList.length) {
        bindVars.statusList = statusList
        filterParts.push('FILTER task.status IN @statusList')
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    if (overdue === '1' || overdue === 'true') {
      filterParts.push('FILTER task.due_date != null && task.due_date < @today')
      filterParts.push('FILTER task.status != "done" && task.status != "cancelled"')
      bindVars.today = today
    }
    if (due_from) {
      bindVars.due_from = due_from
      filterParts.push('FILTER task.due_date >= @due_from')
    }
    if (due_to) {
      bindVars.due_to = due_to
      filterParts.push('FILTER task.due_date <= @due_to')
    }

    if ((req.user.role === 'admin' || req.user.role === 'manager') && assignee_id) {
      bindVars.assignee_filter = String(assignee_id).trim()
      filterParts.push('FILTER task.assignee_id == @assignee_filter || task.assignee_emp_code == @assignee_filter')
    }

    const filterAql = filterParts.length ? filterParts.join(' ') : ''

    const list = await q(`
      FOR task IN tasks
      ${filterAql}
      SORT (task.due_date == null ? 1 : 0), task.due_date ASC, task.created_at DESC
      LIMIT ${skipNum}, ${limitNum}
      RETURN task
    `, bindVars)

    const countResult = await q(`
      FOR task IN tasks
      ${filterAql}
      COLLECT WITH COUNT INTO c
      RETURN c
    `, bindVars)
    const total = countResult[0] ?? 0

    res.json({ items: list, total, page: pageNum, size: limitNum })
  } catch (error) {
    console.error('Error listing tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET /:id - Get single task
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const tasks = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      LIMIT 1
      RETURN task
    `, { id })

    if (!tasks.length) return res.status(404).json({ error: 'not_found', detail: 'Task not found' })
    const task = tasks[0]

    const scope = await buildListFilter(req)
    const canSee = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      ${scope.filterAql}
      LIMIT 1
      RETURN true
    `, { id, ...scope.bindVars })
    if (!canSee.length) return res.status(403).json({ error: 'forbidden', detail: 'Access denied' })

    res.json(task)
  } catch (error) {
    console.error('Error fetching task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// PATCH /:id - Update task
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { title, description, due_date, status, priority } = req.body || {}

    const tasks = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      LIMIT 1
      RETURN task
    `, { id })
    if (!tasks.length) return res.status(404).json({ error: 'not_found', detail: 'Task not found' })
    const task = tasks[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      ${scope.filterAql}
      LIMIT 1
      RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const isAssignee = task.assignee_id === req.user.sub || task.assignee_emp_code === req.user.emp_code
    const isAssigner = task.assigned_by_id === req.user.sub
    const isAdminOrManager = req.user.role === 'admin' || req.user.role === 'manager'

    const updates = { updated_at: new Date().toISOString() }
    if (title !== undefined && (isAssigner || isAdminOrManager)) updates.title = String(title).trim()
    if (description !== undefined && (isAssigner || isAdminOrManager)) updates.description = description ? String(description).trim() : null
    if (due_date !== undefined && (isAssigner || isAdminOrManager)) updates.due_date = due_date || null
    if (priority !== undefined && (isAssigner || isAdminOrManager) && TASK_PRIORITIES.includes(priority)) updates.priority = priority
    if (status !== undefined && TASK_STATUSES.includes(status)) {
      if (isAssignee || isAssigner || isAdminOrManager) updates.status = status
    }

    if (Object.keys(updates).length <= 1) return res.status(400).json({ error: 'no_updates' })

    const col = getCollection('tasks')
    await col.update(id, updates)
    const updated = await q(`FOR t IN tasks FILTER t._key == @id LIMIT 1 RETURN t`, { id })
    res.json(updated[0])
  } catch (error) {
    console.error('Error updating task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// DELETE /:id - Delete (hard delete)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const tasks = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      LIMIT 1
      RETURN task
    `, { id })
    if (!tasks.length) return res.status(404).json({ error: 'not_found' })
    const task = tasks[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR task IN tasks
      FILTER task._key == @id
      ${scope.filterAql}
      LIMIT 1
      RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const isAssigner = task.assigned_by_id === req.user.sub
    if (req.user.role !== 'admin' && req.user.role !== 'manager' && !isAssigner) {
      return res.status(403).json({ error: 'forbidden', detail: 'Only assigner or admin/manager can delete' })
    }

    const col = getCollection('tasks')
    await col.remove(id)
    res.status(204).end()
  } catch (error) {
    console.error('Error deleting task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
