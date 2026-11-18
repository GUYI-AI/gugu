import { connectorOrder } from '@/session/renderer/features/assistant/assistant-connector-order'
import { assistantAccountDisplayName } from '@/components/assistant/assistant-app-connections'

// #7199 手机「资料」下连接应用那几页的纯判断(与桌面 assistant-capabilities 同一套说法),单测在
// tests/unit/mobile/phoneProfileModel.test.ts。读写在 usePhoneProfileData.ts,画法在 PhoneConnectors / PhoneConnectorSetup。

export type ConnectorItem = { id: string; description: string }
export type ConnectorStatus = { displayName?: string }

/**
 * 云端连接应用分「已连接 / 可用」两组(照桌面 ConnectorLists):连没连按存没存凭据算(不联网那一问),
 * 已连接那一行副标题写账号名(联网那一问给的,还没问到就写介绍),先后照 connectorOrder(中文用户国内常用的在前)。
 */
export function connectorGroups<T extends ConnectorItem>(
  items: readonly T[],
  configured: Partial<Record<string, boolean>>,
  statuses: Partial<Record<string, ConnectorStatus>> | null,
  language: string,
): { connected: { item: T; detail: string }[]; available: { item: T; detail: string }[] } {
  const ordered = connectorOrder(items, language)
  return {
    connected: ordered.filter((item) => configured[item.id]).map((item) => ({ item, detail: statuses?.[item.id]?.displayName ?? item.description })),
    available: ordered.filter((item) => !configured[item.id]).map((item) => ({ item, detail: item.description })),
  }
}

/** 一家的详情:不在目录里 = null(页面说「此应用不可用」,❌ 画一张空详情)。 */
export function connectorDetail<T extends ConnectorItem>(
  items: readonly T[],
  configured: Partial<Record<string, boolean>>,
  statuses: Partial<Record<string, ConnectorStatus>> | null,
  id: string,
): { item: T; connected: boolean; account: string | null } | null {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) return null
  return { item, connected: !!configured[id], account: assistantAccountDisplayName(statuses?.[id]?.displayName) }
}

/**
 * 「本机」那一段在手机上说的是这台手机:装在手机上的咕咕(capacitor)画「这台手机」能做的事(PhoneDeviceActionsPage);
 * 别的(手机浏览器里的网页版)交给桌面同一个 ThisDeviceConnectors —— 没有设备能力时它说「要在咕咕电脑 App 里连接」。
 */
export function thisDeviceView(platformKind: 'electron' | 'capacitor' | 'web'): 'phone' | 'shared' {
  return platformKind === 'capacitor' ? 'phone' : 'shared'
}
