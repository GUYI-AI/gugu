import type { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { identityRealtimeOptions, identityRealtimeTopic, publishIdentityRealtimeBroadcast, realtimeScopeChanged } from './team-realtime'
import type { RealtimeIdentityContext } from './team-realtime-http'

type Client = ReturnType<typeof createGuguSupabaseClient>
type Channel = ReturnType<Client['channel']>
type Broadcast = { type: 'broadcast'; event: string; payload: unknown }
type Status = (status: string, error?: Error) => void
interface Runtime {
  readContext(force?: boolean): Promise<RealtimeIdentityContext>
  publishTeam(token: string, args: { p_topic: string; p_payload: unknown; p_event: string }): Promise<{ error: unknown }>
  onInvalidated?: () => void
}
interface Entry {
  channel: Channel
  subscribed(): boolean
  isTeam(): boolean
  reload(force?: boolean): Promise<void>
  close(): Promise<unknown>
}
const refused = () => new Error('Realtime identity is unavailable')
function sameIdentity(a: RealtimeIdentityContext, b: RealtimeIdentityContext) {
  return a.scope.kind === b.scope.kind && a.actorUserId === b.actorUserId
    && (a.actorUserId !== null || a.accessToken === b.accessToken)
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** Preserve the Supabase data API. Only channel creation, delivery and lifetime are identity-aware. */
export function withIdentityRealtime<T extends Client>(raw: T, runtime: Runtime): T {
  const topics = new Map<string, Entry>(), entries = new Set<Entry>(), closing = new Map<string, Promise<unknown>>()
  let timer: ReturnType<typeof setInterval> | undefined
  async function refresh(force = false) {
    // Existing managed-channel barriers own reconnect after offline/resume; never reopen a deliberately disconnected transport.
    if (!raw.realtime.isConnected()) return
    await Promise.allSettled([...entries].filter(entry => entry.subscribed()).map(entry => entry.reload(force)))
  }
  function updateTimer() {
    const needed = [...entries].some(entry => entry.subscribed() && entry.isTeam())
    if (needed && !timer) {
      timer = setInterval(() => { void refresh() }, 30_000)
      ;(timer as { unref?: () => void }).unref?.()
    } else if (!needed && timer) { clearInterval(timer); timer = undefined }
  }
  function channel(topic: string, options?: Parameters<T['channel']>[1]): Channel {
    const existing = topics.get(topic)
    if (existing) return existing.channel
    const previousClose = closing.get(topic)
    const handlers: unknown[][] = []
    let real: Channel | undefined, context: RealtimeIdentityContext | undefined, wanted = false, closed = false, generation = 0, physicallySubscribed = false
    let flight: Promise<void> | undefined, closePromise: Promise<unknown> | undefined, joined = deferred(), status: Status = () => undefined
    const facade = new Proxy({
      on(...args: unknown[]) {
        handlers.push(args)
        if (real) register(real, args, generation)
        return facade
      },
      subscribe(callback: Status = () => undefined) {
        if (closed || wanted) throw refused()
        wanted = true; status = callback
        void reload().catch(() => undefined)
        return facade
      },
      async send(message: Broadcast) {
        const next = await runtime.readContext().catch(() => { throw refused() })
        if (closed || (context && !sameIdentity(context, next))) throw refused()
        if (wanted) { await reload(); await joined.promise }
        const current = await runtime.readContext().catch(() => { throw refused() })
        if (closed || !sameIdentity(next, current) || realtimeScopeChanged(next.scope, current.scope)) throw refused()
        if (!context) context = current
        return publishIdentityRealtimeBroadcast(current.scope, topic, message, {
          sendPersonal: async frame => {
            // Supabase retains its own pre-subscribe HTTP fallback on the personal path.
            if (!real) real = raw.channel(topic, options)
            return real.send(frame)
          },
          rpc: (_name, args) => current.accessToken ? runtime.publishTeam(current.accessToken, args) : Promise.resolve({ error: refused() }),
        })
      },
      unsubscribe: close,
      get topic() { return real?.topic ?? `realtime:${topic}` },
    }, {
      get(target, property) {
        if (Reflect.has(target, property)) return Reflect.get(target, property)
        // Team writes have one explicit RPC port; do not expose an alternative raw transport.
        if (context?.scope.kind === 'team' && ['httpSend', 'push', 'track', 'untrack'].includes(String(property))) return () => { throw refused() }
        const value = real && Reflect.get(real, property)
        return typeof value === 'function' ? value.bind(real) : value
      },
    }) as unknown as Channel
    const entry: Entry = { channel: facade, subscribed: () => wanted && !closed, isTeam: () => context?.scope.kind === 'team', reload, close }
    entries.add(entry); topics.set(topic, entry)

    function register(target: Channel, args: unknown[], version: number) {
      const callback = args.at(-1)
      const guarded = typeof callback === 'function' ? [...args.slice(0, -1), (...payload: unknown[]) => {
        if (!closed && generation === version) callback(...payload)
      }] : args
      Reflect.apply(target.on, target, guarded)
    }
    async function reload(force = false): Promise<void> {
      if (flight) return flight
      const run = (async () => {
        try {
          await previousClose
          const next = await runtime.readContext(force)
          if (closed) return
          if (context && !sameIdentity(context, next)) throw refused()
          if (real && physicallySubscribed && context && !realtimeScopeChanged(context.scope, next.scope)) {
            if (next.scope.kind === 'team' && context.accessToken !== next.accessToken && next.accessToken) await raw.realtime.setAuth(next.accessToken)
            context = next; return
          }
          const version = ++generation, old = real
          real = undefined; physicallySubscribed = false; joined.reject(refused()); joined = deferred()
          if (old) { status('CHANNEL_ERROR', refused()); await raw.removeChannel(old) }
          if (closed || generation !== version) return
          if (next.scope.kind === 'team' && next.accessToken) await raw.realtime.setAuth(next.accessToken)
          const latest = await runtime.readContext()
          if (closed || generation !== version || !sameIdentity(next, latest) || realtimeScopeChanged(next.scope, latest.scope)) throw refused()
          context = next
          const scopedOptions = next.scope.kind === 'personal' ? options : identityRealtimeOptions(next.scope, options ?? { config: {} })
          real = raw.channel(identityRealtimeTopic(next.scope, topic), scopedOptions)
          for (const handler of handlers) register(real, handler, version)
          if (next.scope.kind === 'team') real.on('broadcast', { event: 'team_context_changed' }, () => {
            if (closed || generation !== version) return
            runtime.onInvalidated?.(); void refresh(true)
          })
          physicallySubscribed = true
          real.subscribe((value, error) => {
            if (closed || generation !== version) return
            if (value === 'SUBSCRIBED') joined.resolve()
            else if (value === 'CHANNEL_ERROR' || value === 'TIMED_OUT' || value === 'CLOSED') joined.reject(refused())
            status(value, error)
          })
          updateTimer()
        } catch {
          ++generation; joined.reject(refused())
          const old = real; real = undefined; physicallySubscribed = false
          if (old) await raw.removeChannel(old)
          if (!closed) status('CHANNEL_ERROR', refused())
          throw refused()
        }
      })()
      flight = run
      try { await run }
      finally { if (flight === run) flight = undefined }
    }
    function close(): Promise<unknown> {
      if (closePromise) return closePromise
      closed = true; ++generation; joined.reject(refused())
      entries.delete(entry); if (topics.get(topic) === entry) topics.delete(topic)
      const old = real; real = undefined
      closePromise = old ? Promise.resolve(raw.removeChannel(old)) : Promise.resolve('ok')
      closing.set(topic, closePromise); updateTimer()
      void closePromise.finally(() => { if (closing.get(topic) === closePromise) closing.delete(topic) }).catch(() => undefined)
      return closePromise
    }
    return facade
  }
  return new Proxy(raw, {
    get(target, property) {
      if (property === 'channel') return channel
      if (property === 'getChannels') return () => [...entries].map(entry => entry.channel)
      if (property === 'removeChannel') return (value: Channel) => {
        const entry = [...entries].find(entry => entry.channel === value)
        return entry ? entry.close() : raw.removeChannel(value)
      }
      if (property === 'removeAllChannels') return async () => { await Promise.all([...entries].map(entry => entry.close())); return raw.removeAllChannels() }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
