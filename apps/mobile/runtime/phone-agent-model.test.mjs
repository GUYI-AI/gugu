import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneModelAccess } from './phone-agent-model.mjs'
import { withServerClock } from '../../../packages/core/src/shared/serverClock.ts'

test('the issuer relay root preserves its gateway prefix and targets the shared OpenAI protocol endpoint', async () => {
  const access = createPhoneModelAccess({ modelAccess: async (request) => request.action === 'issue' ? { session_id: 'protocol-lease', relay_url: 'https://models.invalid/gateway/', token: 'private-short-lived', model: 'free', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() } : {} }, { state: { leases: {} }, save: async () => undefined }, () => undefined)
  const lease = await access.issue({ agentUserId: 'real-agent', sessionId: 'real-session', modelId: 'free' })
  try {
    assert.equal(lease.model.baseUrl, 'https://models.invalid/gateway/v1')
    assert.equal(new URL(`${lease.model.baseUrl}/chat/completions`).pathname, '/gateway/v1/chat/completions')
  } finally { await lease.close() }
})

test('only supported platform models are offered; explicit member models are decided by the issuer', async () => {
  const models = [{ id: 'free', enabled: true, protocols: ['openai-chat-completions'] }, { id: 'member', enabled: true, requires_membership: true, protocols: ['openai-chat-completions'] }, { id: 'wrong-wire', enabled: true, protocols: ['anthropic-messages'] }, { id: 'hidden', enabled: true, hidden: true, protocols: ['openai-chat-completions'] }]
  const access = createPhoneModelAccess({ modelAccess: async () => ({ models }) }, { state: { leases: {} }, save: async () => undefined }, () => undefined)
  assert.deepEqual((await access.catalog()).map((item) => item.id), ['free', 'member'])
  assert.equal(await access.resolve(), 'free')
  assert.equal(await access.resolve('platform:member'), 'member')
  await assert.rejects(access.resolve('member'), /platform:/)
  await assert.rejects(access.resolve('platform:wrong-wire'), /不支持/)
})

test('issued token is scoped to the real agent/session and every finished turn checkpoints then revokes it', async () => {
  const requests = []
  const store = { state: { leases: {} }, save: async () => undefined }
  const access = createPhoneModelAccess({ modelAccess: async (request) => {
    requests.push(request)
    return request.action === 'issue' ? { session_id: 'issued-lease', relay_url: 'https://models.invalid', token: 'private-short-lived', model: 'model-alias', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() } : {}
  } }, store, () => undefined)
  const lease = await access.issue({ agentUserId: 'real-agent', sessionId: 'real-session', modelId: 'free' })
  assert.deepEqual(requests[0], { action: 'issue', agent_user_id: 'real-agent', engine_id: 'pi', model_id: 'free', protocol: 'openai-chat-completions', provider_session_id: 'real-session' })
  assert.equal(lease.model.apiKey, 'private-short-lived')
  assert.equal(JSON.stringify(store.state).includes('private-short-lived'), false)
  await lease.close()
  assert.deepEqual(requests.map((item) => item.action), ['issue', 'checkpoint', 'revoke'])
  assert.deepEqual(store.state.leases, {})
})

test('a ticket is judged on the backend’s clock: a phone clock 4 h 17 min fast still uses it, and renews before it ends', async (t) => {
  const SERVER = Date.parse('2026-11-16T12:00:00.000Z')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: SERVER + (4 * 60 + 17) * 60_000 })
  await withServerClock(async () => new Response('[]', { headers: { date: new Date(SERVER).toUTCString() } }))('https://db.invalid/rest/v1/ping')
  const requests = []
  const access = createPhoneModelAccess({ modelAccess: async (request) => {
    requests.push(request.action)
    return request.action === 'issue' || request.action === 'renew'
      ? { session_id: 'skewed-lease', relay_url: 'https://models.invalid', token: 'private-short-lived', model: 'free', protocol: 'openai-chat-completions', expires_at: new Date(SERVER + 900_000).toISOString() }
      : {}
  } }, { state: { leases: {} }, save: async () => undefined }, () => undefined)
  const lease = await access.issue({ agentUserId: 'real-agent', sessionId: 'real-session', modelId: 'free' })
  try {
    t.mock.timers.tick(900_000 - 120_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(requests, ['issue', 'renew'])
  } finally { await lease.close() }
})
