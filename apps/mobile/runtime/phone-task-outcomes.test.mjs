import test from 'node:test'
import assert from 'node:assert/strict'
import { projectPhoneTaskOutcomes } from './phone-task-outcomes.mjs'

const turn = key => ({ id: key, items: [{ id: `session:message:${key}`, kind: 'message', role: 'user', text: 'Same prompt' }], outcome: { kind: 'done' } })
test('ledger interruption survives an already recorded Pi terminal result and uses the exact input identity', () => {
  const a = turn('pi:a#0'), b = turn('pi:b#0')
  const result = projectPhoneTaskOutcomes([a, b], new Map([['pi:a#0', 'job-a'], ['pi:b#0', 'job-b']]), [{ id: 'job-a', status: 'done' }, { id: 'job-b', status: 'interrupted' }])
  assert.equal(result[0], a)
  assert.deepEqual(result[1].outcome, { kind: 'error', reason: 'process_closed', phoneInterruption: { jobId: 'job-b', retryable: true } })
  assert.equal(b.outcome.kind, 'done')
})
test('native child receipts hide the old action without changing the interrupted record', () => {
  const input = turn('native-admission:a'), map = new Map([['native-admission:a', 'a']])
  for (const [jobs, receipts] of [[[{ context: { jobId: 'a' }, status: 'interrupted' }], ['a']], [[{ id: 'a', status: 'interrupted' }, { id: 'b', retryOf: 'a', status: 'queued' }], []]]) {
    assert.equal(projectPhoneTaskOutcomes([input], map, jobs, receipts)[0].outcome.phoneInterruption.retryable, false)
  }
})
test('a matching prompt without recorded identity never attributes another task to this row', () => {
  const input = turn('unknown')
  assert.equal(projectPhoneTaskOutcomes([input], new Map(), [{ id: 'a', prompt: 'Same prompt', status: 'interrupted' }])[0], input)
})
