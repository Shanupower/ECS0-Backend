// Shared setup for task-related collections + indexes.
// Used by setup-arangodb.js at bootstrap and lazily by routes/tasks.js at request-time.

import db, { getCollection } from './database.js'

const DOC_COLLECTIONS = [
  'tasks',
  'task_comments',
  'task_activities',
  'task_attachments',
  'task_templates',
  'task_automations',
  'sla_breaches',
  'task_watchers',
  'notifications'
]

const EDGE_COLLECTIONS = [
  'task_about_entity', // task -> customer/lead/receipt/loan
  'task_blocks',       // task -> task (blocks)
  'task_parent'        // subtask -> parent task (also denormalised on task.parent_task_id)
]

// Indexes: array of { collection, type, fields, unique?, sparse? }
const INDEXES = [
  // tasks
  { collection: 'tasks', type: 'persistent', fields: ['status'] },
  { collection: 'tasks', type: 'persistent', fields: ['branch', 'status'] },
  { collection: 'tasks', type: 'persistent', fields: ['assignee_id', 'status'] },
  { collection: 'tasks', type: 'persistent', fields: ['assignee_emp_code'] },
  { collection: 'tasks', type: 'persistent', fields: ['due_date'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['scheduled_date'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['archived_at'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['parent_task_id'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['recurrence_series_id'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['customer_id'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['lead_id'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['receipt_id'], sparse: true },
  { collection: 'tasks', type: 'persistent', fields: ['sla_tier'], sparse: true },
  { collection: 'tasks', type: 'fulltext', fields: ['title'], minLength: 2 },

  // comments / activities / attachments: lookups by task_key
  { collection: 'task_comments', type: 'persistent', fields: ['task_key'] },
  { collection: 'task_comments', type: 'persistent', fields: ['parent_comment_id'], sparse: true },
  { collection: 'task_comments', type: 'persistent', fields: ['created_at'] },
  { collection: 'task_activities', type: 'persistent', fields: ['task_key'] },
  { collection: 'task_activities', type: 'persistent', fields: ['created_at'] },
  { collection: 'task_activities', type: 'persistent', fields: ['actor_id'] },
  { collection: 'task_attachments', type: 'persistent', fields: ['task_key'] },

  // watchers
  { collection: 'task_watchers', type: 'persistent', fields: ['task_key', 'user_id'], unique: true },
  { collection: 'task_watchers', type: 'persistent', fields: ['user_id'] },

  // templates / automations / sla
  { collection: 'task_templates', type: 'persistent', fields: ['name'], unique: true, sparse: true },
  { collection: 'task_templates', type: 'persistent', fields: ['enabled'] },
  { collection: 'task_automations', type: 'persistent', fields: ['trigger'] },
  { collection: 'task_automations', type: 'persistent', fields: ['enabled'] },
  { collection: 'sla_breaches', type: 'persistent', fields: ['task_key'] },
  { collection: 'sla_breaches', type: 'persistent', fields: ['tier'] },
  { collection: 'sla_breaches', type: 'persistent', fields: ['breached_at'] },

  // notifications
  { collection: 'notifications', type: 'persistent', fields: ['user_id', 'read_at'] },
  { collection: 'notifications', type: 'persistent', fields: ['created_at'] }
]

async function createIfMissing(name, isEdge = false) {
  const col = db.collection(name)
  const exists = await col.exists()
  if (!exists) {
    if (isEdge) await db.createEdgeCollection(name)
    else await col.create()
  }
}

/** Creates every tasks-related collection and edge collection if missing. */
export async function ensureTaskCollections() {
  for (const name of DOC_COLLECTIONS) await createIfMissing(name, false)
  for (const name of EDGE_COLLECTIONS) await createIfMissing(name, true)
}

/** Creates every required index idempotently. Call after ensureTaskCollections(). */
export async function ensureTaskIndexes() {
  for (const idx of INDEXES) {
    try {
      const col = getCollection(idx.collection)
      const opts = {
        type: idx.type,
        fields: idx.fields,
        unique: !!idx.unique,
        sparse: !!idx.sparse
      }
      if (idx.type === 'fulltext') opts.minLength = idx.minLength || 2
      await col.ensureIndex(opts)
    } catch (err) {
      // 1207 = already exists; log everything else but don't throw (setup must succeed on re-runs).
      if (err && err.errorNum !== 1207) {
        console.warn(`[tasks-collections] index warn on ${idx.collection}.${idx.fields.join(',')}:`, err.message)
      }
    }
  }
}

/** One-shot bootstrap: collections + indexes. Safe to call repeatedly. */
export async function ensureTaskSetup() {
  await ensureTaskCollections()
  await ensureTaskIndexes()
}
