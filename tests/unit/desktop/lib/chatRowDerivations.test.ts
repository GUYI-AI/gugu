// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { chat, displayIdentity } from '../../../support/testHarness'
import { createChatMembershipProjection, isArchivedOwnedAgentChat } from '../../../../apps/desktop/src/lib/chatRowDerivations'
import { memoizeByReference } from '../../../../apps/desktop/src/lib/memoizeByReference'
import { publishChatSummaries, readChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
import { assertIdentityClosure } from '../../../../apps/desktop/src/lib/identityClosure'

afterEach(() => publishChatSummaries([]))

it('hides only owned Agent DMs with a positive archive fact, including local archive before identity synchronization', () => {
  const peer = displayIdentity('agent', { type: 'agent', owner_user_id: 'me' })
  const archived = { ...peer, session_archived_at: '2026-11-01T00:00:00Z' }
  for (const kind of ['dm', 'ai'] as const) {
    const row = chat({ kind, peer_user_id: peer.id })
    expect(isArchivedOwnedAgentChat(row, 'me', archived)).toBe(true)
    expect(isArchivedOwnedAgentChat(row, 'me', peer, 'archived')).toBe(true)
    expect(isArchivedOwnedAgentChat(row, 'me', archived, 'idle')).toBe(true)
    expect(isArchivedOwnedAgentChat(row, 'me', peer, 'idle')).toBe(false)
    expect(isArchivedOwnedAgentChat(row, 'me', peer, 'offline')).toBe(false)
    expect(isArchivedOwnedAgentChat(row, 'other-owner', archived)).toBe(false)
    expect(isArchivedOwnedAgentChat(row, undefined, archived)).toBe(false)
    expect(isArchivedOwnedAgentChat(row, 'me', undefined, 'archived')).toBe(false)
    expect(isArchivedOwnedAgentChat(row, 'me', { ...archived, type: 'human' })).toBe(false)
  }
  for (const kind of ['group', 'topic'] as const) expect(isArchivedOwnedAgentChat(chat({ kind }), 'me', archived, 'archived')).toBe(false)
})

it('rechecks an identity array that a caller mutates in place', () => {
  const identities = [displayIdentity('first')]
  assertIdentityClosure('mutable', ['first'], identities)
  identities.splice(0, 1, displayIdentity('second'))
  expect(() => assertIdentityClosure('mutable', ['first'], identities)).toThrow('first')
  expect(() => assertIdentityClosure('mutable', ['second'], identities)).not.toThrow()
})

it.each([10, 100, 1000])('derives only the changed row among %i rows', size => {
  const rows = Array.from({ length: size }, (_, index) => chat({ id: `c${index}` }))
  const visits: string[] = []
  const derive = memoizeByReference((row: ReturnType<typeof chat>) => { visits.push(row.id); return row.last_message_preview })
  rows.map(row => derive(row, undefined))
  visits.length = 0
  const changed = { ...rows[0]!, last_message_preview: 'new' }
  const actual = [changed, ...rows.slice(1)].map(row => derive(row, undefined))
  console.info('derived rows', visits)
  expect(visits).toEqual(['c0'])
  expect(actual[0]).toBe('new')
})

it('derives the same member signature for a preview change and updates on a membership change', () => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }), human: displayIdentity('human') }
  const original = chat({ id: 'group', kind: 'group', member_user_ids: ['human', 'agent'] })
  const before = project([original], directory)
  expect(project([{ ...original, last_message_preview: 'new' }], directory)).toBe(before)
  expect(project([{ ...original, member_user_ids: ['human'] }], directory).key).toBe('group:human')
})

it('lists only the agents of private chats: a group row draws no status, so its agent members are not followed', () => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }), member: displayIdentity('member', { type: 'agent' }), human: displayIdentity('human') }
  const dm = chat({ id: 'dm', kind: 'dm', peer_user_id: 'agent' })
  const person = chat({ id: 'person', kind: 'dm', peer_user_id: 'human' })
  const group = chat({ id: 'group', kind: 'group', member_user_ids: ['member', 'human'] })
  expect(project([dm, person, group], directory).agentIds).toEqual(['agent'])
  expect(project([dm, person, group], { ...directory, human: displayIdentity('human', { type: 'agent' }) }).agentIds).toEqual(['agent', 'human'])
})

it('keeps aggregate agent ids and skips sort when a private preview changes or rows move', () => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }) }
  const dm = chat({ id: 'dm', kind: 'dm', peer_user_id: 'agent' })
  const group = chat({ id: 'group', kind: 'group', member_user_ids: ['agent'] })
  const before = project([dm, group], directory)
  const sort = vi.spyOn(Array.prototype, 'sort')
  try {
    const next = project([group, { ...dm, last_message_preview: 'new' }], directory)
    expect(sort).not.toHaveBeenCalled()
    expect(next).toBe(before)
    expect(next.agentIds).toBe(before.agentIds)
  } finally { sort.mockRestore() }
  expect(project([group], directory).agentIds).toEqual([])
})

it.each([10, 100, 1000])('does not revisit settled member fields after %i preview-only row updates', size => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }) }
  const reads: string[] = []
  const row = (index: number, preview: string) => {
    const members = ['agent']
    return { ...chat({ id: `g${index}`, kind: 'group', last_message_preview: preview }), get member_user_ids() { reads.push(`g${index}`); return members } }
  }
  const rows = Array.from({ length: size }, (_, index) => row(index, 'old'))
  const before = project(rows, directory)
  reads.length = 0
  expect(project(rows, directory)).toBe(before)
  console.info('settled member fields', reads)
  expect(reads).toEqual([])
  expect(project([row(0, 'new'), ...rows.slice(1)], directory)).toBe(before)
  expect(reads).toEqual(['g0'])
})

it.each([10, 100, 1000])('reads summary fields for only the changed row among %i rows', size => {
  const reads: string[] = []
  const row = (id: string, preview: string) => ({ ...chat({ id }), get last_message_preview() { reads.push(id); return preview } })
  const rows = Array.from({ length: size }, (_, index) => row(`c${index}`, 'old'))
  publishChatSummaries(rows)
  const previous = readChatSummaries()!
  reads.length = 0
  publishChatSummaries([row('c0', 'new'), ...rows.slice(1)])
  console.info('summary field reads', reads)
  expect(reads).toEqual(['c0'])
  expect(readChatSummaries()!.get('c0')!.lastMessagePreview).toBe('new')
  expect(readChatSummaries()!.get('c1')).toBe(previous.get('c1'))
})

it('removes optional address and alias fields and preserves an unchanged summary across a moved row', () => {
  const first = chat({ id: 'a', alias: 'alias', public_id: 1234 })
  const second = chat({ id: 'b' })
  publishChatSummaries([first, second])
  const held = readChatSummaries()!.get('b')
  publishChatSummaries([second, { ...first, alias: null, public_id: null }])
  expect(readChatSummaries()!.get('a')).not.toHaveProperty('alias')
  expect(readChatSummaries()!.get('a')).not.toHaveProperty('publicId')
  expect(readChatSummaries()!.get('b')).toBe(held)
})

it('updates the resolved name of an unchanged row and keeps its summary for unrelated publications', () => {
  const row = chat({ id: 'peer', name: 'original' })
  publishChatSummaries([row], () => 'first alias')
  const first = readChatSummaries()!.get(row.id)
  publishChatSummaries([row], () => 'second alias')
  const second = readChatSummaries()!.get(row.id)
  expect(second?.name).toBe('second alias')
  expect(second).not.toBe(first)
  publishChatSummaries([chat({ id: 'other' }), row], () => 'second alias')
  expect(readChatSummaries()!.get(row.id)).toBe(second)
})
