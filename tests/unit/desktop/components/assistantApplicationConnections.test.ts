import { expect, it } from 'vitest'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { assistantConnectedApps, assistantApplicationCounts } from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'
import type { ChatChannelsValue } from '../../../../apps/desktop/src/components/connections/connection-replicas'

/** The `chatChannels` reading with a value. */
const read = (value: ChatChannelsValue) => ({ state: 'value' as const, value, stale: false, error: null })

it('normalizes actual product connections into one app model', () => {
  const items = [{ id: 'feishu', name: '飞书', description: '文档' }, { id: 'dingtalk', name: '钉钉' }] as IntegrationMetadata[]
  const apps = assistantConnectedApps(items, read({ kinds: ['wechat'], channels: [], suggestedAgentId: null }), () => '微信', '在微信里和咕咕聊天')
  expect(apps.map(app => app.id)).toEqual(['feishu', 'dingtalk', 'wechat'])
  expect(apps[2]).toMatchObject({ name: '微信', state: 'notConnected', saved: false })
  expect(apps.every(app => !('chatKind' in app) && !('channel' in app))).toBe(true)
})

it('does not count starting, retrying, paused or broken connections as connected', () => {
  for (const state of ['starting', 'retrying', 'paused', 'broken'] as const) {
    const services = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state } }] } as ChatChannelList
    const apps = assistantConnectedApps([], read(services), id => id, '')
    expect(apps[0]!.state).not.toBe('connected')
    expect(apps[0]!.saved).toBe(true)
  }
})

it('retains the known WeChat entry: no cloud computer is not connected; not read yet is checking; unreadable is a failed check', () => {
  expect(assistantConnectedApps([], read({ absent: true }), () => '微信', '聊天')).toMatchObject([{ id: 'wechat', name: '微信', state: 'notConnected' }])
  expect(assistantConnectedApps([], { state: 'unknown' }, () => '微信', '聊天')).toMatchObject([{ id: 'wechat', state: 'checking' }])
  expect(assistantConnectedApps([], { state: 'error', error: new Error('unreadable') }, () => '微信', '聊天')).toMatchObject([{ id: 'wechat', state: 'checkFailed' }])
})

it('a channel list read before whose read again failed is a failed check, ❌ the old health (connected) drawn as current', () => {
  const services = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state: 'running' } }] } as ChatChannelList
  const kept = { state: 'value' as const, value: services, stale: true, error: new Error('offline') }
  expect(assistantConnectedApps([], kept, () => '微信', '聊天')).toMatchObject([{ id: 'wechat', state: 'checkFailed', saved: true }])
  expect(assistantConnectedApps([], read(services), () => '微信', '聊天')).toMatchObject([{ id: 'wechat', state: 'connected' }])
})

it('counts connected products once, without treating saved unverified grants as connected', () => {
  const items = [{ id: 'feishu', name: '飞书' }] as IntegrationMetadata[]
  const services = { kinds: ['wechat'], channels: [{ kind: 'wechat', health: { state: 'running' } }] } as ChatChannelList
  expect(assistantApplicationCounts(items, { feishu: true }, { feishu: { connected: true } }, services)).toEqual({ connected: 2, saved: 2 })
  expect(assistantApplicationCounts(items, { feishu: true }, undefined, { absent: true })).toEqual({ connected: 0, saved: 1 })
})
