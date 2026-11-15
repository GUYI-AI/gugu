// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupAnnouncement } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

/**
 * Group announcements (open-flicker CH20): the first frame never says「暂无公告」before they are read, and an action
 * re-reads behind the list instead of swapping it for the loading line.
 */
const io = vi.hoisted(() => ({ answer: null as null | Promise<unknown> }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getAnnouncements: () => io.answer,
    setAnnouncementLike: vi.fn(async () => {}),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => [] }))
const { AnnouncementDrawer } = await import('../../../../apps/desktop/src/components/chat/AnnouncementDrawer')

const announcement = { id: 'a-1', chatId: 'g-1', authorId: 'u-1', content: 'Release on Friday', pinned: false, likeCount: 0, likedByMe: false, createdAt: '2026-11-14T00:00:00Z', updatedAt: null } as unknown as GroupAnnouncement
const drawer = () => createNode(AnnouncementDrawer, { chatId: 'g-1', isAdmin: false, head: (title: unknown) => createNode('h2', null, title as never) })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('group announcements', () => {
  it('does not say there are none before they are read', async () => {
    io.answer = new Promise(() => {})
    await renderWithAppProviders(harness, drawer())
    expect(harness.container.textContent).not.toContain('暂无公告')
  })

  it('keeps the list while an action re-reads it', async () => {
    io.answer = Promise.resolve([announcement])
    await renderWithAppProviders(harness, drawer())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(harness.container.textContent).toContain('Release on Friday')
    io.answer = new Promise(() => {})
    const like = harness.container.querySelector<HTMLButtonElement>('[data-testid="announcement-like"]')
    expect(like).not.toBeNull()
    await act(async () => { like!.click(); await Promise.resolve() })
    expect(harness.container.textContent).toContain('Release on Friday')
  })
})
