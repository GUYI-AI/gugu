import { describe, expect, it } from 'vitest'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import {
  newProjectPath,
  partnerFriends,
  partnerGroupAgents,
  projectNameProblem,
} from '../../../apps/desktop/src/mobile/partners/partnersModel'

function contact(id: string, fields: Partial<ContactUser> = {}): ContactUser {
  return { id, display_name: id, avatar: null, bio: null, type: 'human', ...fields }
}

// 手机「伙伴」(OpenDCAI/gugu#446):朋友只列人,群里的 Agent 单独列。
describe('partnerFriends', () => {
  it('lists people only, excluding both my own and other owners’ agents', () => {
    const me = 'me'
    const friends = partnerFriends(
      [contact('张三'), contact('my-agent', { type: 'agent', owner_user_id: me }), contact('their-agent', { type: 'agent', owner_user_id: 'someone' })],
    )
    expect(friends.map((friend) => friend.id)).toEqual(['张三'])
  })

  it('does not list one person twice', () => {
    const friends = partnerFriends([contact('a'), contact('a'), contact('a', { type: 'agent', owner_user_id: 'x' })])
    expect(friends).toHaveLength(1)
    expect(friends[0]?.type).toBe('human')
  })

  it('orders by how the name reads', () => {
    const friends = partnerFriends([contact('c', { display_name: '周' }), contact('a', { display_name: '陈' }), contact('b', { display_name: '林' })])
    expect(friends.map((friend) => friend.display_name)).toEqual(['陈', '林', '周'])
  })
})

describe('partnerGroupAgents', () => {
  it('lists other owners’ agents once, using the shared-group version from the desktop library', () => {
    const shared = contact('their-agent', { type: 'agent', owner_user_id: 'someone', display_name: '陈' })
    const agents = partnerGroupAgents(
      [contact('person'), contact('my-agent', { type: 'agent', owner_user_id: 'me' }), { ...shared, display_name: 'old name' }],
      [shared, contact('their-other-agent', { type: 'agent', owner_user_id: 'someone', display_name: '周' }), contact('mine-again', { type: 'agent', owner_user_id: 'me' }), contact('unknown-owner', { type: 'agent' })],
      'me',
    )
    expect(agents.map(agent => agent.id)).toEqual(['their-agent', 'their-other-agent'])
    expect(agents[0]).toBe(shared)
  })
})

describe('new project', () => {
  it('makes a new empty folder named after the project in the machine’s projects directory', () => {
    expect(newProjectPath('/Users/me/Documents', '咕咕')).toBe('/Users/me/Documents/咕咕')
    expect(newProjectPath('/Users/me/Documents/', 'x')).toBe('/Users/me/Documents/x')
  })

  it('takes the same names the computer’s 新建项目 takes', () => {
    expect(projectNameProblem('  ')).toBe('empty')
    expect(projectNameProblem('a/b')).toBe('invalid')
    expect(projectNameProblem('..')).toBe('invalid')
    expect(projectNameProblem('新项目')).toBeNull()
  })
})
