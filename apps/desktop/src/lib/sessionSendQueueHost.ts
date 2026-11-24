import { ReplicaState } from '@gugu/session-wire'
import { sessionStateSchema, type SessionState } from '@gugu/session-core/acp/client'
import { getAcpRuntimeClient } from '@/session/renderer/lib/acp/runtime-client'
import { releaseQueuedSessionInput, state, subscribeSessionInputs } from './outbox/kinds/sessionInput'
import { rendererLogger } from './log'
import { onMachineEvent, rpcOn } from '@/session/renderer/lib/ipc'
import { sessionLifeViewChannel } from '@/session/shared/core/sessions/sessionEvents'
import type { SessionInput } from './sessionInput'

function foregroundQueueReady(snapshot: SessionState): boolean {
  const completed = snapshot.lastTurnOutcome === 'none'
    || (snapshot.lastTurnOutcome === 'stopped' && snapshot.lastStopReason === 'end_turn')
  return snapshot.lifecycle === 'ready' && snapshot.activeTurnId === null && !snapshot.queuedPrompts.length && completed
}

/** Observe only sessions with composer-owned inputs; no engine is started by this observer. */
export function watchSessionSendQueues(accountId: string, currentDeviceId: () => string | undefined,
  includeInput: (input: SessionInput) => boolean = () => true): () => void {
  type Watch = { closed: boolean; replica?: ReplicaState<SessionState>; checking: boolean; again: boolean; check?: () => Promise<void>; stopLife?: () => void }
  const watches = new Map<string, Watch>()
  let closed = false
  const report = (error: unknown) => rendererLogger('session/send-queue').warn({ error: String(error) }, 'Could not release composer queue')
  const refresh = () => {
    const own = state()
    if (closed || !own.valid() || own.accountId !== accountId) return
    const targets = new Map(own.rows.filter(input => input.accountId === accountId && input.sendQueue && includeInput(input))
      .map(input => [`${input.deviceId ?? 'local'}/${input.sessionId}`, input]))
    for (const [key, watch] of watches) if (!targets.has(key)) {
      watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose(); watches.delete(key)
    }
    for (const [key, input] of targets) {
      if (watches.has(key)) { void watches.get(key)!.check?.(); continue }
      const watch: Watch = { closed: false, checking: false, again: false }
      watches.set(key, watch)
      const machine = !input.deviceId || input.deviceId === currentDeviceId() ? null : input.deviceId
      void getAcpRuntimeClient(machine).then(async client => {
        if (closed || watch.closed) return
        // @@@replica-follows-life - the runtime publishes a session's state only while that session runs. A held input
        // usually outlives it (a restart interrupted the turn), so the watch lives as long as the input and follows the
        // session's Life: it opens the state replica when Life is ready and drops only the replica when that goes away.
        const connect = async (): Promise<ReplicaState<SessionState> | null> => {
          if (watch.replica) return watch.replica
          const replica = new ReplicaState(client.session.state({ sessionId: input.sessionId }, 'state'), { schema: sessionStateSchema })
          watch.replica = replica
          const drop = (error: unknown) => {
            report(error); void replica.dispose()
            if (watch.replica === replica) watch.replica = undefined
          }
          replica.onGone(drop)
          try { await replica.ready } catch (error) { drop(error); return null }
          if (closed || watch.closed || watch.replica !== replica) return null
          replica.onChange(() => { void check() })
          return replica
        }
        const check = async (): Promise<void> => {
          if (watch.checking) { watch.again = true; return }
          watch.checking = true
          try {
            do {
              watch.again = false
              if (closed || watch.closed || !own.valid() || own.accountId !== accountId) return
              const life = await rpcOn(machine).sessions.lifeView(input.sessionId)
              if (life.kind !== 'ready' || life.hold !== null) return
              const replica = await connect()
              if (!replica || watch.again) continue
              // A background child does not hold the composer's foreground queue. A retained native turn does.
              if (!foregroundQueueReady(replica.current())) return
              const history = await client.getHistory({ sessionId: input.sessionId, limit: 100 })
              if (!history.success) throw new Error('Session history is not available')
              if (closed || watch.closed || !own.valid() || own.accountId !== accountId) return
              if (watch.again) continue
              if (watch.replica !== replica || !foregroundQueueReady(replica.current())) return
              await releaseQueuedSessionInput(input.sessionId, history.data.turns, undefined, false, () =>
                !closed && !watch.closed && !watch.again && watch.replica === replica && own.valid() && own.accountId === accountId
                  && foregroundQueueReady(replica.current()))
            } while (watch.again)
          } catch (error) { report(error) }
          finally { watch.checking = false }
        }
        watch.check = check
        watch.stopLife = onMachineEvent(machine, sessionLifeViewChannel, view => { if (view.sessionId === input.sessionId) void check() })
        await check()
      }).catch(error => {
        report(error); watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose()
        if (watches.get(key) === watch) watches.delete(key)
      })
    }
  }
  const unsubscribe = subscribeSessionInputs(refresh)
  refresh()
  return () => {
    closed = true; unsubscribe()
    for (const watch of watches.values()) { watch.closed = true; watch.stopLife?.(); void watch.replica?.dispose() }
    watches.clear()
  }
}
