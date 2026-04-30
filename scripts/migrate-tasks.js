// One-shot migration script for the tasks world-class redesign.
//
// - Snapshots existing `tasks` docs into `tasks_backup_v1`.
// - Maps old statuses/priorities to the new enum set.
// - Fills in new fields with sensible defaults.
//
// Run with:   node scripts/migrate-tasks.js
// Idempotent: skips docs already in the new shape.

import 'dotenv/config'
import db, { q, getCollection } from '../config/database.js'
import { ensureTaskSetup } from '../config/tasks-collections.js'

const STATUS_MAP = {
  pending: 'todo',
  in_progress: 'in_progress',
  done: 'done',
  cancelled: 'cancelled'
}
const PRIORITY_MAP = {
  low: 'p3',
  medium: 'p2',
  high: 'p1'
}
const NEW_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'])
const NEW_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3'])

async function ensureBackup() {
  const backup = db.collection('tasks_backup_v1')
  const exists = await backup.exists()
  if (exists) {
    console.log('[migrate-tasks] backup already exists at tasks_backup_v1 — skipping snapshot')
    return
  }
  await backup.create()
  const rows = await q('FOR t IN tasks RETURN t')
  if (!rows.length) {
    console.log('[migrate-tasks] no docs to back up')
    return
  }
  console.log(`[migrate-tasks] snapshotting ${rows.length} tasks into tasks_backup_v1…`)
  await backup.saveAll(rows)
}

async function migrateDocs() {
  const col = getCollection('tasks')
  const rows = await q('FOR t IN tasks RETURN t')
  let migrated = 0
  let skipped = 0
  for (const doc of rows) {
    const updates = {}

    if (doc.status && !NEW_STATUSES.has(doc.status)) {
      updates.status = STATUS_MAP[doc.status] || 'todo'
    }
    if (doc.priority && !NEW_PRIORITIES.has(doc.priority)) {
      updates.priority = PRIORITY_MAP[doc.priority] || 'p2'
    }

    // New fields: only set if missing to remain idempotent.
    if (doc.labels === undefined) updates.labels = []
    if (doc.checklist === undefined) updates.checklist = []
    if (doc.watchers === undefined) updates.watchers = []
    if (doc.custom_fields === undefined) updates.custom_fields = {}
    if (doc.related_entities === undefined) updates.related_entities = []
    if (doc.start_date === undefined) updates.start_date = null
    if (doc.scheduled_date === undefined) updates.scheduled_date = null
    if (doc.completed_at === undefined) {
      updates.completed_at = doc.status === 'done' ? (doc.updated_at || doc.created_at || null) : null
    }
    if (doc.parent_task_id === undefined) updates.parent_task_id = null
    if (doc.estimate_minutes === undefined) updates.estimate_minutes = null
    if (doc.customer_id === undefined) updates.customer_id = null
    if (doc.lead_id === undefined) updates.lead_id = null
    if (doc.receipt_id === undefined) updates.receipt_id = null
    if (doc.loan_id === undefined) updates.loan_id = null
    if (doc.recurrence_rule === undefined) updates.recurrence_rule = null
    if (doc.recurrence_series_id === undefined) updates.recurrence_series_id = null
    if (doc.archived_at === undefined) updates.archived_at = null
    if (doc.sla_tier === undefined) updates.sla_tier = null
    if (doc.source === undefined) updates.source = 'legacy'

    if (Object.keys(updates).length === 0) { skipped++; continue }
    updates.updated_at = new Date().toISOString()
    await col.update(doc._key, updates)
    migrated++
  }
  console.log(`[migrate-tasks] migrated=${migrated}  skipped=${skipped}`)
}

async function main() {
  console.log('[migrate-tasks] ensuring task collections + indexes…')
  await ensureTaskSetup()
  console.log('[migrate-tasks] snapshotting…')
  await ensureBackup()
  console.log('[migrate-tasks] migrating docs…')
  await migrateDocs()
  console.log('[migrate-tasks] done')
  process.exit(0)
}

main().catch((err) => {
  console.error('[migrate-tasks] fatal:', err)
  process.exit(1)
})
