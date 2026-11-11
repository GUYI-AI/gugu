import { describe, expect, it } from 'vitest'
import {
  connectorDetail,
  connectorGroups,
  thisDeviceView,
} from '../../../apps/desktop/src/mobile/assistant/phoneProfileModel'

// #7199 手机「资料」下连接应用那几页:与桌面同一套说法。
describe('connectorGroups', () => {
  const items = [
    { id: 'github', description: 'Code' },
    { id: 'feishu', description: '飞书' },
    { id: 'dingtalk', description: '钉钉' },
  ]

  it('按存没存凭据分组;已连接写账号名,还没问到写介绍', () => {
    const groups = connectorGroups(items, { github: true, feishu: true }, { github: { displayName: 'octocat' } }, 'en-US')
    expect(groups.connected.map(({ item, detail }) => [item.id, detail])).toEqual([
      ['github', 'octocat'],
      ['feishu', '飞书'],
    ])
    expect(groups.available.map(({ item }) => item.id)).toEqual(['dingtalk'])
  })

  it('中文界面国内常用的在前(与桌面同一个 connectorOrder)', () => {
    const groups = connectorGroups(items, {}, null, 'zh-CN')
    expect(groups.available.map(({ item }) => item.id)).toEqual(['feishu', 'dingtalk', 'github'])
  })
})

describe('connectorDetail', () => {
  const items = [{ id: 'github', description: 'Code' }]

  it('连没连、账号名', () => {
    expect(connectorDetail(items, { github: true }, { github: { displayName: 'octocat' } }, 'github')).toEqual({ item: items[0], connected: true, account: 'octocat' })
    expect(connectorDetail(items, {}, null, 'github')).toEqual({ item: items[0], connected: false, account: null })
  })

  it('目录里没有 = null(页面说「此应用不可用」)', () => {
    expect(connectorDetail(items, {}, null, 'feishu')).toBeNull()
  })
})

describe('thisDeviceView', () => {
  it('装在手机上的咕咕画这台手机;网页版交给桌面同一个组件(它说要在电脑 App 里连)', () => {
    expect(thisDeviceView('capacitor')).toBe('phone')
    expect(thisDeviceView('web')).toBe('shared')
  })
})
