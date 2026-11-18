import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

// While the socket is down, every channel retry used to leave the old channel and join a new one. Neither can be
// sent, so both waited in the socket's send buffer, and one reconnect flushed them all: a longer outage meant more
// joins of the same topic at once. One reconnect must send each channel's join exactly once.
const fixture = vi.hoisted(() => ({ url: '' }))
vi.mock('electron', () => ({ net: { fetch } }))
vi.mock('@gugu/core/cloud/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { createGuguSupabaseClient: (options: { accessToken: () => Promise<string | null>; realtime: { transport: unknown } }) =>
    createClient(fixture.url, 'isolated-anon', { accessToken: options.accessToken, realtime: { transport: options.realtime.transport as never } }) }
})
import { bindElectronSupabaseAuth, supabase } from '../../../../apps/desktop/electron/supabase'
import { _resetElectronRealtimeChannelRegistryForTesting, subscribeAuthenticatedElectronRealtimeChannel } from '../../../../apps/desktop/electron/realtime-channel'
import { isSubscribeFailure } from '@gugu/core/cloud/deviceRpcProtocol'

afterEach(async () => {
  _resetElectronRealtimeChannelRegistryForTesting()
  await supabase.removeAllChannels()
  supabase.realtime.disconnect()
  bindElectronSupabaseAuth(async () => null)
})

it('sends one join per channel when the socket comes back after several failed retries', { timeout: 90_000 }, async () => {
  const joins: Array<{ connection: number; topic: string }> = []
  let connections = 0
  const listen = async (port = 0) => {
    const http = createServer()
    const server = new WebSocketServer({ server: http })
    server.on('connection', socket => {
      const connection = ++connections
      socket.on('message', bytes => {
        const packet = JSON.parse(String(bytes))
        const [joinRef, ref, topic, event] = Array.isArray(packet) ? packet : [packet.join_ref, packet.ref, packet.topic, packet.event]
        if (event === 'phx_join') joins.push({ connection, topic })
        if (!['phx_join', 'heartbeat', 'phx_leave', 'access_token'].includes(event)) return
        const response = { status: 'ok', response: { postgres_changes: [] } }
        socket.send(JSON.stringify(Array.isArray(packet) ? [joinRef, ref, topic, 'phx_reply', response]
          : { join_ref: joinRef, ref, topic, event: 'phx_reply', payload: response }))
      })
    })
    await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve))
    return { http, server, port: (http.address() as { port: number }).port }
  }
  let backend = await listen()
  fixture.url = `http://127.0.0.1:${backend.port}`
  bindElectronSupabaseAuth(async () => 'ticket')

  const statuses = new Map<string, string[]>()
  const subscribedSince = (name: string, after: number) => (statuses.get(name) ?? []).slice(after).includes('SUBSCRIBED')
  const topics = ['device-rpc', 'owned-agents']
  for (const name of topics) {
    statuses.set(name, [])
    const make = () => supabase.channel(name, { config: { private: true } })
    await subscribeAuthenticatedElectronRealtimeChannel({ realtime: supabase.realtime,
      removeChannel: channel => supabase.removeChannel(channel as ReturnType<typeof make>),
    }, make(), {
      label: name, createChannel: make, reconnectOnStatus: isSubscribeFailure,
      onStatus: status => { statuses.get(name)!.push(String(status)) },
    })
  }
  await vi.waitFor(() => expect(topics.every(name => subscribedSince(name, 0))).toBe(true))

  // The backend goes away long enough for several retries of each channel, then comes back on the same address.
  const marks = new Map(topics.map(name => [name, statuses.get(name)!.length]))
  for (const client of backend.server.clients) client.terminate()
  await new Promise<void>(resolve => backend.http.close(() => resolve()))
  await new Promise(resolve => setTimeout(resolve, 35_000))
  const outage = connections
  backend = await listen(backend.port)

  await vi.waitFor(() => expect(topics.every(name => subscribedSince(name, marks.get(name)!))).toBe(true), { timeout: 40_000, interval: 200 })
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const afterOutage = joins.filter(join => join.connection > outage)
  expect(topics.map(name => afterOutage.filter(join => join.topic === `realtime:${name}`).length)).toEqual([1, 1])
  supabase.realtime.disconnect()
  backend.http.closeAllConnections()
  await new Promise<void>(resolve => backend.http.close(() => resolve()))
})
