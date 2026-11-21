import '@/i18n/registerAssistantCatalog'
import '@/i18n/registerSettingsCatalog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppConnectionHero } from '../../assistant/AppConnectionHero'
import { Button } from '../../ui/Button'
import { SettingsNote } from '../SettingsPrimitives'
import { ConnectedChannels } from './ChatChannelsPanel'
import { refreshFailure, retryOf } from '@/lib/replica'
import { useChatChannelList } from '@/components/connections/connection-replicas'
import { WechatConnectDialog } from './WechatConnectDialog'
import { ChannelBrandIcon } from './ChannelBrandIcon'

/** WeChat uses its existing authorization transport; the app detail has the same surface as every provider. */
export function WechatAppConnection({ connectOnly = false }: { connectOnly?: boolean } = {}) {
  const { t } = useTranslation('assistant')
  const { client, reading, list, apply, refresh } = useChatChannelList()
  const [connecting, setConnecting] = useState(false)
  // Unreadable, or a refresh failed over a list it keeps: said with a retry.
  const failed = refreshFailure(reading) !== null
  const connected = list?.channels.some(item => item.kind === 'wechat')
  const available = !!client && !!list?.kinds.includes('wechat')
  return <>
    <AppConnectionHero icon={<ChannelBrandIcon kind="wechat" size={56} />} description={t('connectors.wechatDescription')}
      loading={reading.state === 'unknown'} disabled={!available || (connectOnly && connected)} label={t(connected ? (connectOnly ? 'connectors.connected' : 'connectors.manage') : 'connectors.connect')}
      onConnect={() => setConnecting(true)} />
    {failed ? <SettingsNote role="alert">{t('connectors.loadFailed')}<Button variant="ghost" size="sm" onClick={retryOf(reading)}>{t('machine.retry')}</Button></SettingsNote> : null}
    {!connectOnly && connected && client && list ? <ConnectedChannels client={client} list={list} apply={apply} /> : null}
    {connecting && client && list ? <WechatConnectDialog client={client} list={list} refresh={refresh} apply={apply} onClose={() => setConnecting(false)} /> : null}
  </>
}
