// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The session streams' own state (timeline-cache.ts): keyed per session, "not followed yet" (absent) apart from
 * "followed, empty", and the signed-in account's — cleared on sign-out or another account.
 */
beforeEach(() => { vi.resetModules() })

async function load() {
  const publication = await import('../../../apps/desktop/src/lib/sessionPublication')
  const cache = await import('../../../apps/desktop/src/components/session-watch/timeline-cache')
  return { ...publication, ...cache }
}
const session = (id: string) => ({ user: { id } }) as never
const key = { deviceId: 'mac', sessionId: 's1' }

describe('session stream store', () => {
  it('tells a session not followed yet from one followed and empty', async () => {
    const { sessionStreams, sessionStreamKey, updateSessionStream } = await load()
    expect(sessionStreams.get().get(sessionStreamKey(key))).toBeUndefined()
    updateSessionStream(key, (current) => ({ ...current, phase: 'ready' }))
    const followed = sessionStreams.get().get(sessionStreamKey(key))
    expect(followed).toMatchObject({ phase: 'ready', timeline: { turns: [] } })
  })

  it('clears every stream on sign-out and on another account; an absent session (boot restore) holds', async () => {
    const { publishRendererSession, sessionStreams, nativeRecordStreams, sessionpageTimelineFacts, updateSessionStream, updateNativeRecordStream, updateSessionpageFacts } = await load()
    publishRendererSession('SIGNED_IN', session('alice'))
    const fill = () => {
      updateSessionStream(key, (current) => ({ ...current, phase: 'ready' }))
      updateNativeRecordStream(key, (current) => ({ ...current, unreachable: true }))
      updateSessionpageFacts('s1', () => ({ recentActions: null, settlements: {} }))
    }
    const sizes = () => [sessionStreams.get().size, nativeRecordStreams.get().size, sessionpageTimelineFacts.get().size]
    fill()
    publishRendererSession('BOOT_RESTORING', null)
    expect(sizes()).toEqual([1, 1, 1])
    publishRendererSession('SIGNED_IN', session('bob'))
    expect(sizes()).toEqual([0, 0, 0])
    fill()
    publishRendererSession('SIGNED_OUT', null)
    expect(sizes()).toEqual([0, 0, 0])
  })
})
