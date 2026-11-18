import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { assistantConnectedApps, type AssistantConnectedApp } from '@/components/assistant/assistant-app-connections'
import { ChannelBrandIcon } from '@/components/settings/channels/ChannelBrandIcon'
import { builtinConnectionCatalog } from '@/components/connections/builtin-connection-catalog'
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon'
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { useSettingsDetail } from '@/components/settings/SettingsDetailNavigation'
import { SessionSettingsSection } from '@/components/sessionpage/SessionSettingsSection'
import { PhoneConnectorDetail, PhoneConnectorsPage, type PhoneConnectorScope } from '../assistant/PhoneConnectors'
import { PhoneConnectorSetupPage } from '../assistant/PhoneConnectorSetup'
import { usePhoneMachine } from '../assistant/phoneMachine'
import { parseConnectorSub } from '../assistant/phoneConnectorFlow'
import { usePhoneIntegrations } from '../assistant/usePhoneProfileData'
import type { PhoneAssistantState } from '../assistant/usePhoneAssistant'
import { PhoneMarketConnectorCatalog, type PhoneConnectorCatalogMode } from './PhoneMarketConnectorCatalog'

type Props = {
  assistant: PhoneAssistantState | undefined
  mode: PhoneConnectorCatalogMode
  devices: readonly Device[]
  installedDeviceId: string | null
}

export function PhoneMarketConnections(props: Props) {
  return <ConnectionRouteBoundary owner={route => <OwnerMarketConnections {...props} route={route} />}
    legacy={<LegacyMarketConnections {...props} />} />
}

function OwnerMarketConnections({ route, mode, devices, installedDeviceId }: Props & { route: ConnectionRoute }) {
  const { t } = useTranslation('main')
  const [selected, setSelected] = useState<AssistantConnectedApp | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const close = () => setSelected(null)
  const open = (app: AssistantConnectedApp) => {
    setTarget(devices.find(device => device.is_online)?.device_id ?? null)
    setSelected(app)
  }
  useSettingsDetail(selected ? `market-connector:${selected.id}` : null, selected?.name ?? t('phoneMarket.connectors'), close)
  const deviceId = mode === 'installed' ? installedDeviceId : selected ? target : null
  return <div className="phone-market">
    {selected && mode === 'market' && devices.length > 0 && <label className="phone-market-device">
      {t('phoneMarket.device')}
      <select aria-label={t('phoneMarket.device')} value={target ?? ''} onChange={event => setTarget(event.currentTarget.value || null)}>
        <option value="">{t('phoneMarket.accountConnections')}</option>
        {devices.map(device => (
          <option key={device.device_id} value={device.device_id} disabled={!device.is_online}>{device.label || device.hostname}</option>
        ))}
      </select>
    </label>}
    <SessionSettingsSection section="connectors" key={JSON.stringify([selected?.id, deviceId])} context={{
      connectionRoute: route,
      connectionDeviceId: deviceId,
      initialConnectorId: selected?.id,
      panelNavigation: !!selected,
      phoneConnectorCatalog: selected ? undefined : { mode, open },
      connectOnly: mode === 'market',
    }} />
  </div>
}

function LegacyMarketConnections({ assistant, mode, installedDeviceId }: Props) {
  const { t } = useTranslation('main')
  if (!assistant?.assistant || !assistant.chatId) return mode === 'market' ? <ReadOnlyConnectorCatalog />
    : <SettingsNote role="status">{t('phoneMarket.assistantRequired')}</SettingsNote>
  if (mode === 'installed' && installedDeviceId !== assistant.homeDeviceId) {
    return <SettingsNote role="status">{t('phoneMarket.connectionsOnAssistantHome')}</SettingsNote>
  }
  return <LegacyAssistantConnections
    assistant={assistant.assistant} chatId={assistant.chatId}
    homeDeviceId={assistant.homeDeviceId} home={assistant.home} mode={mode} />
}

function ReadOnlyConnectorCatalog() {
  const { t, i18n } = useTranslation('main')
  const { t: assistant } = useTranslation('assistant')
  const { t: settings } = useTranslation('settings')
  const apps = assistantConnectedApps(builtinConnectionCatalog(i18n.language), null,
    id => settings(`channels.${id}`), assistant('connectors.wechatDescription'))
  return <div className="phone-market">
    <SettingsNote role="status">{t('phoneMarket.assistantRequired')}</SettingsNote>
    <PhoneMarketConnectorCatalog mode="market" apps={apps} connectionKnown={false}
      icon={(app, size) => app.integration ? <IntegrationIcon provider={app.id} icon={app.integration.icon} size={size} />
        : <ChannelBrandIcon kind="wechat" size={size} />} />
  </div>
}

function LegacyAssistantConnections({ assistant, chatId, homeDeviceId, home, mode }: Pick<PhoneConnectorScope,
  'assistant' | 'homeDeviceId' | 'home'> & { chatId: string; mode: PhoneConnectorCatalogMode }) {
  const { t } = useTranslation('main')
  const [sub, setSub] = useState<string | null>(null)
  const page = parseConnectorSub(sub)
  const machine = usePhoneMachine(homeDeviceId, assistant.id, chatId)
  const integrations = usePhoneIntegrations(machine, true)
  const props = { assistant, home, homeDeviceId, machine, integrations, go: (next?: string) => setSub(next ?? null) }
  const name = integrations.data?.items.find(app => app.id === page?.id)?.name
  const back = () => setSub(page?.view === 'connect' ? `connector:${page.id}` : null)
  useSettingsDetail(page ? `market-${sub}` : null, name ?? t('phoneMarket.connectors'), back)
  if (machine.state === 'error' && !integrations.data && !integrations.error) {
    return <SettingsNote role="status">{t('phoneMarket.connectionsOnAssistantHome')}</SettingsNote>
  }
  if (!page) return <PhoneConnectorsPage {...props} marketMode={mode} />
  if (page.view === 'connect') return <PhoneConnectorSetupPage {...props} id={page.id} />
  return <PhoneConnectorDetail {...props} id={page.id} connectOnly={mode === 'market'} />
}
