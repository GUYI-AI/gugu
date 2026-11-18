import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

// A host's link drops, and the first reconnect lands on a path that accepts the connection but never answers the
// upgrade (a dead tunnel). Once the link is back, the channels must come back by themselves: before, the socket sat
// in "connecting" for good, every join timed out, and only a host resume (which replaces the socket) recovered it.
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

it('rejoins after the link is back even when one reconnect hung in the upgrade', { timeout: 60_000 }, async () => {
  let hangNextUpgrade = false
  const hung: Array<(ok: boolean) => void> = []
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, accept) => {
      if (!hangNextUpgrade) return accept(true)
      hangNextUpgrade = false
      hung.push(accept) // accepted by the path, never answered
    },
  })
  await new Promise<void>(resolve => server.once('listening', resolve))
  fixture.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  server.on('connection', socket => socket.on('message', bytes => {
    const packet = JSON.parse(String(bytes))
    const [joinRef, ref, topic, event] = Array.isArray(packet) ? packet : [packet.join_ref, packet.ref, packet.topic, packet.event]
    if (!['phx_join', 'heartbeat', 'phx_leave', 'access_token'].includes(event)) return
    const response = { status: 'ok', response: { postgres_changes: [] } }
    socket.send(JSON.stringify(Array.isArray(packet) ? [joinRef, ref, topic, 'phx_reply', response]
      : { join_ref: joinRef, ref, topic, event: 'phx_reply', payload: response }))
  }))
  bindElectronSupabaseAuth(async () => 'ticket')
  const statuses: string[] = []
  const waiters: Array<() => void> = []
  const subscribed = (after: number) => new Promise<void>(resolve => {
    const check = () => { if (statuses.slice(after).includes('SUBSCRIBED')) resolve() }
    waiters.push(check)
    check()
  })
  const makeChannel = () => supabase.channel(`hung-upgrade-${randomUUID()}`, { config: { private: true } })
  try {
    await subscribeAuthenticatedElectronRealtimeChannel({ realtime: supabase.realtime,
      removeChannel: channel => supabase.removeChannel(channel as ReturnType<typeof makeChannel>),
    }, makeChannel(), {
      label: 'hung-upgrade', createChannel: makeChannel, reconnectOnStatus: isSubscribeFailure,
      onStatus: status => { statuses.push(String(status)); waiters.forEach(check => check()) },
    })
    await subscribed(0)

    const before = statuses.length
    hangNextUpgrade = true
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no rejoin after the hung upgrade: ${statuses.slice(before).join(',')}`)), 45_000)
      void subscribed(before).then(() => { clearTimeout(timer); resolve() })
    })
    expect(hung).toHaveLength(1)
  } finally {
    server.close()
  }
})
