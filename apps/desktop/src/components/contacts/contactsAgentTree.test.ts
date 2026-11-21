import { describe, expect, it } from 'vitest'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { buildAgentForest, flattenForest, orderAgentContacts } from './contactsAgentTree'

const agent = (id: string, created_at?: string): ContactUser =>
  ({ id, display_name: id, avatar: null, bio: null, type: 'agent', created_at } as ContactUser)
const ids = (agents: readonly ContactUser[]) => agents.map((a) => a.id)

describe('contacts agent order', () => {
  it('ranked agents in rank order; the rest after them, created first, then id', () => {
    const agents = [agent('theirs-new', '2026-11-02'), agent('mine-b'), agent('theirs-old', '2026-11-01'), agent('mine-a'), agent('theirs-x')]
    expect(ids(orderAgentContacts(agents, ['mine-a', 'mine-b']))).toEqual(['mine-a', 'mine-b', 'theirs-x', 'theirs-old', 'theirs-new'])
  })

  it('the forest keeps that order for roots and for each level of children', () => {
    const ordered = [agent('b'), agent('a'), agent('b2'), agent('b1')]
    const parents = new Map([['b2', 'b'], ['b1', 'b']])
    expect(flattenForest(buildAgentForest(ordered, parents)).map((node) => node.contact.id)).toEqual(['b', 'b2', 'b1', 'a'])
  })
})
