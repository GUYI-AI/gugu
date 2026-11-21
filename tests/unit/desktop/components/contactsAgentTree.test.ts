import { describe, expect, it } from 'vitest'
import { buildAgentForest, flattenForest } from '../../../../apps/desktop/src/components/contacts/contactsAgentTree'
import { contact } from '../../../support/testHarness'

// 一组 agent 按「谁派生了谁」成树:父不在这一组(在别的设备上)就自己当根;成环的坏数据不丢节点;次序沿用传进来的。
const agents = ['arch', 'front', 'css', 'icon', 'review', 'codex', 'e2e'].map((id) => contact({ id, type: 'agent', display_name: id }))
const ids = (nodes: ReturnType<typeof flattenForest>) => nodes.map((node) => `${'-'.repeat(node.depth)}${node.contact.id}`)

describe('buildAgentForest', () => {
  it('nests three levels and keeps the given order among siblings and roots', () => {
    const parents = new Map([['front', 'arch'], ['review', 'arch'], ['css', 'front'], ['icon', 'front'], ['e2e', 'codex']])
    expect(ids(flattenForest(buildAgentForest(agents, parents)))).toEqual(['arch', '-front', '--css', '--icon', '-review', 'codex', '-e2e'])
  })
  it('a parent on another device (not in this group) leaves the child as a root here', () => {
    const forest = buildAgentForest(agents.slice(1, 2), new Map([['front', 'arch']]))
    expect(ids(flattenForest(forest))).toEqual(['front'])
  })
  it('a parent cycle in bad data loses nobody', () => {
    const forest = buildAgentForest(agents.slice(0, 2), new Map([['arch', 'front'], ['front', 'arch']]))
    expect(ids(flattenForest(forest)).map((id) => id.replace(/^-+/, '')).sort()).toEqual(['arch', 'front'])
  })
})
