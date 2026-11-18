import { createSessionTimeline } from '../../../../packages/session-core/src/session-record/timeline.ts'
import { boundaryEntry, messageEvent, toolCallStart, toolCallResult } from '../../../../packages/session-core/src/session-record/sources/shared.ts'
import { trimAfterResultForTransport, trimOlderForTransport, trimSnapshotForTransport } from '../../../../packages/session-core/src/session-record/transport-trim.ts'
import { phoneInterruptionRevision, projectPhoneTaskOutcomes } from '../phone-task-outcomes.mjs'

const sources = new Map()
const opening = new Map()
const fail = (code, message) => Object.assign(new Error(message), { code })
const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []

// The source is the native journal's actual Pi message_end events. These are not
// synthetic JSONL records, model summaries or copied cloud chat messages.
function entriesOf(jobs) {
  const entries = [], clients = new Map(), inputJobs = new Map()
  for (const job of jobs) {
    const jobId = job.context?.jobId
    if (typeof jobId !== 'string' || !Array.isArray(job.events)) throw fail('invalid_journal', 'Native task has no event record')
    let began = false, ended = false
    for (const [index, event] of job.events.entries()) {
      if (event.type !== 'message_end') continue
      const message = event.message
      if (!message || typeof message.role !== 'string') throw fail('invalid_journal', 'Pi message_end has no message')
      const key = `native-pi:${jobId}:${index}`
      const at = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? { at: message.timestamp } : {}
      const content = blocks(message.content)
      if (message.role === 'user') {
        began = true
        inputJobs.set(`${key}#0`, jobId)
        content.forEach((block, i) => entries.push({ key: `${key}#${i}`, ...at, event: messageEvent('user', block, `${key}#0`) }))
        if (job.clientMessageId) clients.set(`${key}#0`, job.clientMessageId)
      } else if (message.role === 'toolResult') {
        entries.push({ key: `${key}#0`, ...at, event: toolCallResult(message.toolCallId, message.isError ? 'failed' : 'completed', {
          text: content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          images: content.filter(block => block.type === 'image'),
        }) })
      } else if (message.role === 'assistant') {
        content.forEach((block, i) => {
          let mapped
          if (block.type === 'text' && block.text) mapped = { kind: 'message', role: 'assistant', messageId: `${key}#${i}`, text: block.text }
          else if (block.type === 'thinking' && block.thinking) mapped = { kind: 'thinking', messageId: `${key}#${i}`, text: block.thinking }
          else if (block.type === 'toolCall' && block.id) mapped = toolCallStart(block.id, block.name, 'other', block.arguments)
          if (mapped) entries.push({ key: `${key}#${i}`, ...at, event: mapped })
        })
        const reason = message.stopReason
        const boundary = reason === 'stop' ? { kind: 'turn_end', stopReason: 'end_turn' }
          : reason === 'length' && !content.some(block => block.type === 'toolCall') ? { kind: 'turn_end', stopReason: 'max_tokens' }
          : reason === 'error' ? { kind: 'turn_failed' }
          : reason === 'aborted' ? { kind: 'turn_aborted' } : null
        if (boundary) { entries.push(boundaryEntry(key, at.at, boundary)); ended = true }
      }
    }
    if (!began && typeof job.prompt === 'string') {
      const key = `native-admission:${jobId}`
      entries.push({ key, event: { kind: 'message', role: 'user', messageId: key, text: job.prompt } })
      inputJobs.set(key, jobId)
      if (job.clientMessageId) clients.set(key, job.clientMessageId)
    }
    if (!ended && ['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      if (job.status !== 'interrupted') entries.push({ key: `native-status:${jobId}`, event: { kind: 'session_notice', code: 'provider-notice',
        title: job.error || `Native task ${job.status}`, detail: job.error || `Native task ${job.status}` } })
      entries.push(boundaryEntry(`native-status:${jobId}`, undefined, { kind: job.status === 'cancelled' ? 'turn_aborted' : 'turn_failed' }))
    }
    if (!ended && job.status === 'done') throw fail('record_unreadable', 'Completed native task has no Pi completion record')
  }
  return { entries, clients, inputJobs }
}

function identify(value, clients, inputJobs, jobs, retriedJobIds) {
  const turns = rows => projectPhoneTaskOutcomes(rows.map(turn => ({ ...turn, items: turn.items.map(item => {
    const client = item.kind === 'message' && item.role === 'user' ? clients.get(item.id.split(':message:').at(-1)) : null
    return client ? { ...item, _meta: { ...item._meta, guguClientMessageId: client } } : item
  }) })), inputJobs, jobs, retriedJobIds)
  if (Array.isArray(value.turns)) return { ...value, turns: turns(value.turns) }
  if (value.ok === true && value.batch) return { ...value, batch: { ...value.batch, turns: turns(value.batch.turns) } }
  if (value.ok === false && value.snapshot) return { ...value, snapshot: { ...value.snapshot, turns: turns(value.snapshot.turns) } }
  return value
}

async function read(input) {
  const { key, sessionId, method } = input
  if (typeof key !== 'string' || !key || typeof sessionId !== 'string' || !Array.isArray(input.jobs)) throw fail('invalid_args', 'Native timeline binding is missing')
  const jobs = [...input.jobs], recorded = new Set(jobs.map(job => job.context?.jobId))
  // An admitted input can be interrupted before Pi creates its first job. Keep
  // that real backend custody visible; it is not a fabricated model record.
  for (const row of input.interruptedInputs ?? []) {
    if (typeof row.id !== 'string' || typeof row.prompt !== 'string' || row.status !== 'interrupted') throw fail('invalid_journal', 'Interrupted input custody is invalid')
    if (!recorded.has(row.id)) jobs.push({ context: { jobId: row.id }, prompt: row.prompt, status: row.status, clientMessageId: row.clientMessageId, events: [] })
  }
  const order = new Map((input.inputOrder ?? []).map((id, index) => [id, index]))
  if (order.size) jobs.sort((a, b) => (order.get(a.context.jobId) ?? Infinity) - (order.get(b.context.jobId) ?? Infinity))
  if (!['snapshot', 'after', 'older'].includes(method)) throw fail('unknown_method', 'Unsupported native timeline read')
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw fail('invalid_args', 'Timeline limit must be positive')
  const { entries, clients, inputJobs } = entriesOf(jobs)
  const revision = phoneInterruptionRevision(jobs, input.retriedJobIds)
  let cached = sources.get(key)
  const prefix = cached && cached.revision === revision && cached.entries.length <= entries.length
    && cached.entries.every((entry, index) => JSON.stringify(entry) === JSON.stringify(entries[index]))
  if (cached && !prefix) {
    // This native reader supplies a complete journal per poll. Recreate its
    // generation directly; JSC has no Node/browser reset timer to publish later.
    cached.timeline.dispose(); sources.delete(key); cached = undefined
  }
  if (!cached) {
    let sink, settlementAt = null
    const timeline = await createSessionTimeline({ locator: { harness: 'pi', providerSessionId: sessionId, roots: [] },
      async start(events) { sink = events; events.onEntries(entries) }, async catchUp() {}, stop() {},
    }, { sessionId, now: () => settlementAt ?? Date.now() })
    cached = { timeline, sink, entries, revision, settle: value => {
      settlementAt = value.resolvedAt
      try { timeline.settle({ itemId: value.itemId, optionId: value.optionId, by: value.resolvedBy }) }
      finally { settlementAt = null }
    } }; sources.set(key, cached)
  } else {
    cached.sink.onEntries(entries.slice(cached.entries.length))
    cached.entries = entries
    cached.revision = revision
  }
  await cached.timeline.catchUp()
  const settlements = input.settlements ?? []
  cached.timeline.syncPendingRequests([...(input.pendingRequests ?? []), ...settlements.map(({ itemId, kind, title, detail, options }) => ({ itemId, kind, title, detail, options }))])
  for (const settlement of settlements) cached.settle(settlement)
  cached.timeline.syncQueuedPrompts(input.queuedPrompts ?? [])
  let value
  if (method === 'snapshot') value = cached.timeline.getSnapshot({ limit: input.limit })
  else if (method === 'after') {
    if (!input.cursor || typeof input.cursor.epoch !== 'string' || !Number.isSafeInteger(input.cursor.seq) || input.cursor.seq < 0) throw fail('invalid_args', 'Timeline cursor is invalid')
    value = cached.timeline.getAfter(input.cursor)
  } else {
    if (typeof input.beforeTurnId !== 'string') throw fail('invalid_args', 'Older timeline needs a turn ID')
    value = cached.timeline.getOlder({ beforeTurnId: input.beforeTurnId, limit: input.limit })
  }
  value = identify(value, clients, inputJobs, jobs, input.retriedJobIds)
  if (input.trim !== true) return value
  return method === 'snapshot' ? trimSnapshotForTransport(value) : method === 'after' ? trimAfterResultForTransport(value) : trimOlderForTransport(value)
}

export function readNativeTimeline(input) {
  const prior = opening.get(input.key) ?? Promise.resolve()
  const pending = prior.catch(() => {}).then(() => read(input))
  opening.set(input.key, pending)
  return pending.finally(() => { if (opening.get(input.key) === pending) opening.delete(input.key) })
}
