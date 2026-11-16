import { describe, expect, it } from 'vitest'
import { phoneMenuBar } from '../../../apps/desktop/src/mobile/composer/phone-menu-bar'

describe('input composer menu bar applicability', () => {
  it('human direct messages only expose the real attachment entry', () => {
    expect(phoneMenuBar('direct', { attachments: true, work: true, skills: true, topics: true, agents: true })).toEqual(['attachments'])
    expect(phoneMenuBar('direct', { attachments: false })).toEqual([])
  })
  it('Agent direct messages never gain Topics and only show actual child Agents', () => {
    expect(phoneMenuBar('agent', { work: true, skills: true, topics: true, agents: false })).toEqual(['work', 'skills'])
    expect(phoneMenuBar('agent', { work: true, skills: true, topics: true, agents: true })).toEqual(['work', 'skills', 'agents'])
    expect(phoneMenuBar('agent', {})).toEqual([])
  })
  it('room and creation contexts retain their own relevant actions', () => {
    expect(phoneMenuBar('room', { topics: true, agents: true, work: true })).toEqual(['topics', 'agents'])
    expect(phoneMenuBar('roomAgent', { work: true, skills: true, topics: true, agents: true })).toEqual(['work', 'skills', 'topics', 'agents'])
    expect(phoneMenuBar('projectTask', { work: true, folder: true, skills: true, project: true })).toEqual(['work', 'folder', 'skills'])
    expect(phoneMenuBar('create', { work: true, project: true, skills: true, agents: true })).toEqual(['work', 'project', 'skills'])
  })
})
