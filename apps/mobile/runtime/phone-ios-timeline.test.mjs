import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readNativeTimeline } from './ios/timeline.mjs'

const input = () => ({ key: randomUUID(), sessionId: randomUUID(), method: 'snapshot', trim: false, jobs: [] })
const job = (status = 'interrupted') => ({ context: { jobId: randomUUID() }, clientMessageId: randomUUID(), status, prompt: 'Check the result', events: [] })

test('native interrupted admission remains visible without fabricating a model reply or executing work', async () => {
  const args = input(), original = job()
  args.interruptedInputs = [{ id: original.context.jobId, prompt: original.prompt, clientMessageId: original.clientMessageId, status: 'interrupted' }]
  const result = await readNativeTimeline(args)
  assert.equal(result.turns.length, 1)
  assert.deepEqual(result.turns[0].outcome, { kind: 'error', reason: 'process_closed', phoneInterruption: { jobId: original.context.jobId, retryable: true } })
  assert.equal(result.turns[0].items.filter(item => item.kind === 'message' && item.role === 'assistant').length, 0)
  assert.match(JSON.stringify(result), new RegExp(original.clientMessageId))
  assert.deepEqual(await readNativeTimeline(args), result)
})

test('actual Pi events and terminal text are retained while interruption and retry receipts invalidate old cursors', async () => {
  const args = input(), original = job('done')
  original.events = [
    { type: 'message_end', message: { role: 'user', content: original.prompt, timestamp: 1 } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Actual partial answer' }], stopReason: 'stop', timestamp: 2 } },
  ]
  args.jobs = [original]
  const before = await readNativeTimeline(args)
  assert.equal(before.turns[0].outcome.kind, 'done')
  original.status = 'interrupted'
  const changed = await readNativeTimeline({ ...args, method: 'after', cursor: before.cursor })
  assert.equal(changed.ok, false)
  assert.equal(changed.snapshot.turns[0].outcome.phoneInterruption.retryable, true)
  assert.match(JSON.stringify(changed), /Actual partial answer/)
  const retried = await readNativeTimeline({ ...args, retriedJobIds: [original.context.jobId], method: 'after', cursor: changed.snapshot.cursor })
  assert.equal(retried.ok, false)
  assert.equal(retried.snapshot.turns[0].outcome.phoneInterruption.retryable, false)
  assert.deepEqual(original.events[1].message.content, [{ type: 'text', text: 'Actual partial answer' }])
})

test('backend interrupted custody cannot override a completed native journal', async () => {
  const args = input(), original = job('done')
  original.events = [{ type: 'message_end', message: { role: 'user', content: original.prompt } },
    { type: 'message_end', message: { role: 'assistant', content: 'Done', stopReason: 'stop' } }]
  args.jobs = [original]
  args.interruptedInputs = [{ id: original.context.jobId, prompt: original.prompt, status: 'interrupted' }]
  const result = await readNativeTimeline(args)
  assert.equal(result.turns.length, 1)
  assert.equal(result.turns[0].outcome.kind, 'done')
  assert.equal(result.turns.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item.role === 'user').length, 1)
})

test('an admitted interruption stays before its running successor in the real input order', async () => {
  const args = input(), older = job(), successor = job('running')
  args.jobs = [successor]
  args.interruptedInputs = [{ id: older.context.jobId, prompt: older.prompt, status: 'interrupted' }]
  args.inputOrder = [older.context.jobId, successor.context.jobId]
  const result = await readNativeTimeline(args)
  assert.equal(result.turns.length, 2)
  assert.equal(result.turns[0].outcome.phoneInterruption.jobId, older.context.jobId)
  assert.equal(result.turns[1].outcome, undefined)
})
