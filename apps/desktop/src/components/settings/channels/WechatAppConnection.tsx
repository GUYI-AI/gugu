import '@/i18n/registerAssistantCatalog'
import '@/i18n/registerSettingsCatalog'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppConnectionHero } from '../../assistant/AppConnectionHero'
import { Button } from '../../ui/Button'
import { SettingsNote } from '../SettingsPrimitives'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { ConnectedChannels } from './ChatChannelsPanel'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { useReplica } from '@/lib/replica'
import { chatChannels } from '@/components/connections/connection-replicas'
import { WechatConnectDialog } from './WechatConnectDialog'
import { ChannelBrandIcon } from './ChannelBrandIcon'

/** WeChat uses its existing authorization transport; the app detail has the same surface as every provider. */
export function WechatAppConnection({ connectOnly = false }: { connectOnly?: boolean } = {}) {
  const { t } = useTranslation('assistant')
  const client = useMemo(() => rendererChatChannelsClient(), [])
  const reading = useReplica(chatChannels, [])
  // A change made here answers with the whole list after an await: it goes into the account this render drew (bound now,
  // held across the await by the handler), ❌ whichever account is signed in when it answers.
  const owner = chatChannels.key()?.[1] ?? null
  const entry = useMemo(() => (owner ? chatChannels.at() : null), [owner])
  const apply = (next: ChatChannelList) => { entry?.set(next) }
  const refresh = () => chatChannels.refresh()
  const [connecting, setConnecting] = useState(false)
  // No cloud computer (`absent`): no channels to list, and nothing to connect.
  const list = reading.state === 'value' && !('absent' in reading.value) ? reading.value : null
  // Unreadable, or a refresh failed over a list it keeps: said with a retry.
  const failed = reading.state === 'error' || (list !== null && reading.state === 'value' && reading.error !== null)
  const connected = list?.channels.some(item => item.kind === 'wechat')
  const available = !!client && !!list?.kinds.includes('wechat')
  return <>
    <AppConnectionHero icon={<ChannelBrandIcon kind="wechat" size={56} />} description={t('connectors.wechatDescription')}
      loading={reading.state === 'unknown'} disabled={!available || (connectOnly && connected)} label={t(connected ? (connectOnly ? 'connectors.connected' : 'connectors.manage') : 'connectors.connect')}
      onConnect={() => setConnecting(true)} />
    {failed ? <SettingsNote role="alert">{t('connectors.loadFailed')}<Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('machine.retry')}</Button></SettingsNote> : null}
    {!connectOnly && connected && client && list ? <ConnectedChannels client={client} list={list} apply={apply} /> : null}
    {connecting && client && list ? <WechatConnectDialog client={client} list={list} refresh={refresh} apply={apply} onClose={() => setConnecting(false)} /> : null}
  </>
}
