// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

/**
 * A person's common groups (open-flicker CH21): before they are read the block draws a placeholder, never「没有共同群」
 * that then turns into a list; a person seen before shows their groups on the first frame while they are read again.
 */
const reads = vi.hoisted(() => ({ answer: null as null | Promise<unknown>, calls: 0 }))
vi.mock('../../../../apps/desktop/src/lib/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/contacts')>()),
  contactsService: new Proxy({}, { get: (_target, key) => key === 'getCommonGroupChats' ? () => { reads.calls += 1; return reads.answer } : vi.fn(async () => []) }),
}))
const { ContactDetail } = await import('../../../../apps/desktop/src/components/contacts/ContactDetail')

const person = { id: 'person-1', type: 'human', display_name: 'Lin', email: null, bio: null, avatar: null, gugu_number: 7 } as unknown as ContactUser
const group = { id: 'g-1', name: 'Design', avatar: null, alias: null } as unknown as ContactGroupChat
const detail = () => createNode(ContactDetail, {
  contact: person, humanContacts: [], sentRequestIds: new Set<string>(), requestingAgentId: null, groupChats: [],
  onRequestAgent: async () => {}, onSetAgentPublic: async () => {}, onSetAgentDesiredStatus: async () => {},
  // What the parent commit took instead of reading the model (its store's callback): kept so the parent arm runs its real path.
  getCommonGroupChats: () => { reads.calls += 1; return reads.answer },
} as never)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); reads.calls = 0 })
afterEach(() => { harness.cleanup() })

describe('common groups of a person', () => {
  it('draws a placeholder until they are read, never "no common groups"', async () => {
    reads.answer = new Promise(() => {})
    await renderWithAppProviders(harness, detail())
    expect(harness.container.textContent).not.toContain('暂无共同群聊')
    expect(harness.container.querySelector('[data-unknown]')).not.toBeNull()
  })

  it('a person seen before shows their groups on the first frame while they are read again', async () => {
    reads.answer = Promise.resolve([group])
    await renderWithAppProviders(harness, detail())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(harness.container.textContent).toContain('Design')
    harness.cleanup({ keepReads: true })

    reads.answer = new Promise(() => {})
    harness = createReactHarness()
    await renderWithAppProviders(harness, detail())
    expect(harness.container.textContent).toContain('Design')
    expect(reads.calls).toBe(2)
  })
})
