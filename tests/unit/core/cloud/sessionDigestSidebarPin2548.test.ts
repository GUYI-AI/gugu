import { describe, expect, it } from 'vitest'
import { normalizeSessionDigest } from '@gugu/core/cloud/devices'
import { sessionListFromDigest } from '@/session/shared/remote-sessions/session-list-sync'

// #2548 固定到左侧栏 rides the offline heartbeat digest like 置顶: carried when the host reports it, absent (unknown,
// not false) from an older host's digest, so an offline machine's pinned agent keeps its place in the left list.
describe('session digest: pinned to the sidebar', () => {
  const entry = { conversationId: 'c1', projectId: 'p1', projectName: 'repo', title: 't', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: true }

  it('passes the flag from the stored digest through to the session list read for an offline machine', () => {
    const digest = normalizeSessionDigest([
      { ...entry, isPinned: true, isPinnedToSidebar: true },
      { ...entry, conversationId: 'c2', isPinnedToSidebar: false },
    ])
    const sessions = sessionListFromDigest(digest).sessions
    expect(sessions.map((s) => [s.conversationId, s.isPinned, s.isPinnedToSidebar])).toEqual([
      ['c1', true, true],
      ['c2', undefined, false],
    ])
  })

  it('an older host that does not report it leaves it absent, not false; a malformed value is dropped', () => {
    const [session] = sessionListFromDigest(normalizeSessionDigest([entry])).sessions
    expect('isPinnedToSidebar' in session!).toBe(false)
    expect(normalizeSessionDigest([{ ...entry, isPinnedToSidebar: 'yes' }])[0]).not.toHaveProperty('isPinnedToSidebar')
  })
})
