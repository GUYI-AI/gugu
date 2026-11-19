import { afterEach, expect, it, vi } from 'vitest'
import { until } from '../../support/awaitCondition'
import { withIdentityRealtime } from '../../../apps/desktop/shared/team-realtime-client'
import type { RealtimeIdentityContext } from '../../../apps/desktop/shared/team-realtime-http'
import type { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'

type Client = ReturnType<typeof createGuguSupabaseClient>
type Frame = { type: 'broadcast'; event: string; payload: unknown }
const team = (namespace = 'opaque-session-1:'): RealtimeIdentityContext => ({ actorUserId: 'team-principal', accessToken: 'synthetic-team-token',
  scope: { kind: 'team', namespace, membershipRevision: 7 } })
const personal: RealtimeIdentityContext = { actorUserId: 'personal-principal', accessToken: 'synthetic-personal-token', scope: { kind: 'personal' } }
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.removeAllChannels())); vi.useRealTimers() })
function fakeChannel(topic: string) {
  const handlers: Array<{ event: string; callback: (value: unknown) => void }> = []
  let status: ((value: string) => void) | undefined
  const result = { topic, send: vi.fn(async (_frame: Frame) => 'personal-send-result'),
    on: vi.fn((_kind: string, filter: { event: string }, callback: (value: unknown) => void) => { handlers.push({ event: filter.event, callback }); return result }),
    subscribe: vi.fn((callback: (value: string) => void) => { status = callback; return result }),
    acknowledge: () => status?.('SUBSCRIBED'),
    emit: (event: string, payload: unknown) => { for (const handler of handlers) if (handler.event === event || handler.event === '*') handler.callback({ payload }) },
  }
  return result
}
function setup(initial: RealtimeIdentityContext = team()) {
  let current = initial, connected = true, failure = false
  const channels: ReturnType<typeof fakeChannel>[] = []
  const raw = { channel: vi.fn((topic: string, _options?: unknown) => { const value = fakeChannel(topic); channels.push(value); return value }),
    removeChannel: vi.fn(async () => 'ok'), removeAllChannels: vi.fn(async () => []),
    realtime: { setAuth: vi.fn(async () => undefined), isConnected: () => connected } }
  const readContext = vi.fn(async () => { if (failure) throw new Error('private profile diagnostic'); return current })
  const publishTeam = vi.fn(async (_token: string, _args: unknown) => ({ error: null })), onInvalidated = vi.fn()
  const client = withIdentityRealtime(raw as unknown as Client, { readContext, publishTeam, onInvalidated }); clients.push(client)
  return { raw, channels, client, readContext, publishTeam, onInvalidated,
    context: (value: RealtimeIdentityContext) => { current = value }, connected: (value: boolean) => { connected = value }, fail: () => { failure = true } }
}
async function subscribe(fixture: ReturnType<typeof setup>, topic = 'gugu:device-1:rpc') {
  const status = vi.fn(), receive = vi.fn(), channel = fixture.client.channel(topic).on('broadcast', { event: 'broadcast' }, receive).subscribe(status)
  await until('the verified physical channel is created', () => fixture.channels.length === 1)
  fixture.channels[0].acknowledge()
  return { channel, status, receive }
}

it('keeps personal topics, options, authentication ownership and raw sends unchanged', async () => {
  const f = setup(personal), { channel } = await subscribe(f)
  expect(f.raw.channel).toHaveBeenCalledWith('gugu:device-1:rpc', undefined)
  const message: Frame = { type: 'broadcast', event: 'broadcast', payload: { id: 'request-1' } }
  expect(await channel.send(message)).toBe('personal-send-result')
  expect(f.channels[0].send).toHaveBeenCalledWith(message)
  expect(f.publishTeam).not.toHaveBeenCalled(); expect(f.raw.realtime.setAuth).not.toHaveBeenCalled()
})
it('uses the full opaque prefix for a private team subscription but the original topic for protected sending', async () => {
  const f = setup(), status = vi.fn()
  const channel = f.client.channel('gugu:device-1:rpc', { config: { private: false, broadcast: { ack: true } } }).subscribe(status)
  await until('the private team channel is created', () => f.channels.length === 1)
  expect(f.raw.channel).toHaveBeenCalledWith('opaque-session-1:gugu:device-1:rpc', { config: { private: true, broadcast: { ack: true } } })
  const message: Frame = { type: 'broadcast', event: 'broadcast', payload: { id: 'request-1' } }
  const sending = channel.send(message)
  expect(f.publishTeam).not.toHaveBeenCalled()
  f.channels[0].acknowledge()
  expect(await sending).toBe('ok')
  expect(f.publishTeam).toHaveBeenCalledWith('synthetic-team-token', { p_topic: 'gugu:device-1:rpc', p_payload: message.payload, p_event: 'broadcast' })
  expect(f.channels[0].send).not.toHaveBeenCalled()
})
it('rejoins after an invalidation and suppresses callbacks from the previous namespace', async () => {
  const f = setup(), { status, receive } = await subscribe(f), old = f.channels[0]
  f.context(team('opaque-session-2:')); old.emit('team_context_changed', {})
  await until('the new session namespace is subscribed', () => f.channels.length === 2)
  old.emit('broadcast', { old: true }); expect(receive).not.toHaveBeenCalled()
  f.channels[1].acknowledge(); f.channels[1].emit('broadcast', { current: true })
  expect(receive).toHaveBeenCalledWith({ payload: { current: true } })
  expect(status).toHaveBeenCalledWith('CHANNEL_ERROR', expect.any(Error))
  expect(f.onInvalidated).toHaveBeenCalledOnce()
  expect(f.channels[1].topic).toBe('opaque-session-2:gugu:device-1:rpc')
})
it('drops an unavailable team subscription without falling back to an original topic', async () => {
  const f = setup(), { channel, status } = await subscribe(f)
  f.fail(); f.channels[0].emit('team_context_changed', {})
  await until('the failed team scope closes its physical channel', () => f.raw.removeChannel.mock.calls.length === 1)
  await expect(channel.send({ type: 'broadcast', event: 'broadcast', payload: {} })).rejects.toThrow('Realtime identity is unavailable')
  expect(f.raw.channel).toHaveBeenCalledTimes(1); expect(f.publishTeam).not.toHaveBeenCalled()
  expect(status).toHaveBeenLastCalledWith('CHANNEL_ERROR', expect.objectContaining({ message: 'Realtime identity is unavailable' }))
})
it('refuses an existing team channel after switching to a personal identity', async () => {
  const f = setup(), { channel } = await subscribe(f)
  f.context(personal)
  await expect(channel.send({ type: 'broadcast', event: 'broadcast', payload: {} })).rejects.toThrow()
  expect(f.channels[0].send).not.toHaveBeenCalled(); expect(f.publishTeam).not.toHaveBeenCalled()
})
it('does not bypass the managed reconnect barrier while the transport is deliberately disconnected', async () => {
  vi.useFakeTimers()
  const f = setup(); await subscribe(f)
  f.connected(false); f.context(team('new-prefix:'))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.channels).toHaveLength(1)
  f.connected(true); f.channels[0].emit('team_context_changed', {})
  await until('a connected transport can rejoin the new namespace', () => f.channels.length === 2)
  expect(f.channels[1].topic).toBe('new-prefix:gugu:device-1:rpc')
})
it('does not create a physical channel after being closed during profile loading', async () => {
  let resolve!: (value: RealtimeIdentityContext) => void
  const pending = new Promise<RealtimeIdentityContext>(yes => { resolve = yes }), f = setup()
  f.readContext.mockReturnValue(pending)
  const channel = f.client.channel('logical-topic').subscribe(vi.fn())
  await until('the profile read is in flight', () => f.readContext.mock.calls.length === 1)
  await f.client.removeChannel(channel); resolve(team()); await pending
  expect(f.raw.channel).not.toHaveBeenCalled()
})
it('cleans up its team profile timer when the last channel closes', async () => {
  vi.useFakeTimers()
  const f = setup(); await subscribe(f)
  expect(vi.getTimerCount()).toBe(1)
  await f.client.removeAllChannels()
  expect(vi.getTimerCount()).toBe(0)
})
