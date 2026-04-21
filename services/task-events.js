// Lightweight in-process domain event bus for task automation.
//
// Publishers (leads.js, receipts.js, customers.js, portfolio-review, tasks.js)
// call `publishEvent({ type, payload, actor, branch })`. Subscribers registered
// via `subscribe(handler)` receive each event asynchronously.
//
// This is intentionally dependency-free so it can ship without external queues.
// If horizontal scaling is added later, swap this for Redis/Kafka without
// changing the publisher API.

const subscribers = new Set()

export function subscribe(handler) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function')
  subscribers.add(handler)
  return () => subscribers.delete(handler)
}

/**
 * Publish a domain event. Handlers run on the next tick and errors are
 * swallowed so a bad handler never bubbles up to the publisher.
 *
 * @param {{ type: string, payload?: any, actor?: any, branch?: string|null }} evt
 */
export async function publishEvent(evt) {
  if (!evt || !evt.type) return
  const frozen = Object.freeze({
    type: evt.type,
    payload: evt.payload || {},
    actor: evt.actor || null,
    branch: evt.branch || null,
    occurred_at: new Date().toISOString()
  })
  // Run handlers out-of-band so publishing is always fast.
  setImmediate(() => {
    for (const h of subscribers) {
      Promise.resolve()
        .then(() => h(frozen))
        .catch(err => console.error('[task-events] subscriber error:', err))
    }
  })
  return frozen
}
