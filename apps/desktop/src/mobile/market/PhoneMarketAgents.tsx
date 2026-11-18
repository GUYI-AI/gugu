import { useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink'
import { MobileAppsSection } from '@/components/settings/MobileAppsSection'
import { useAuth } from '@/store/auth'
import { PhoneAgentHostControl } from '../local-agent/PhoneAgentHostControl'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { ChevronLeft } from '@/lib/icons'
import { IconButton } from '@/components/ui/IconButton'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { usePhoneMarketPage, phoneMarketRows } from '@/components/settings/phoneMarketPage'
import { PhoneMarketInstallSheet } from './PhoneMarketInstallSheet'
import { usePhoneAgentInstallTargets, usePhoneMarketInstalledAppIds } from './phoneMarketTargets'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry'
import { AGENT_MARKET_CATEGORIES, agentMarketCategoryOf, localizedManifestText, matchesExtensionQuery, type AgentMarketCategory } from '@shared/extensions/catalog'
import { queryScore } from '@shared/extensions/query-score'
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram'
import { marketAgentDescription } from '@renderer/features/extensions/panel/market-agent-description'
import { LibraryHostProvider, useLibraryHost } from '@renderer/features/library/library-host'
import { compareAgents, isInstalledAgent } from '@renderer/features/settings/agents-page/agent-order'
import { InstallSection } from '@renderer/features/settings/agents-page/InstallSection'
import { useManagementAgent, useManagementAgents } from '@renderer/lib/stores/use-agents'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { PhoneMarketAction, PhoneMarketFilters, PhoneMarketRow } from './PhoneMarketList'
import { marketDeviceHost } from './marketDeviceHost'

type Category = 'all' | AgentMarketCategory

export const PhoneMarketAgents = observer(function PhoneMarketAgents({ device, targets, installed, onOpenApp }: {
  device: Device | null
  targets: readonly Device[]
  installed: boolean
  onOpenApp?: (target: ExtensionAppDetailLink) => void
}) {
  const { t } = useTranslation('main')
  const { translate, locale } = useSessionMessages()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const [detail, setDetail] = useState<AgentPayload | null>(null)
  const market = usePhoneMarketPage()
  const assistant = !installed && category !== 'coding'
    ? phoneMarketRows(market.data?.entries ?? [], '').find(item =>
        item.manifest.id === ASSISTANT_APP_ID && matchesExtensionQuery(item.manifest, query))
    : undefined
  const assistantText = assistant && localizedManifestText(assistant.manifest, locale)
  const assistantInstalled = usePhoneMarketInstalledAppIds(installed ? [] : targets).has(ASSISTANT_APP_ID)
  const choices = (['all', ...AGENT_MARKET_CATEGORIES] as const).map(value => ({
    value, label: value === 'all' ? t('phoneMarket.all') : translate(`extensions.agentCategory.${value}`),
  }))
  return <div className="phone-market" data-testid={installed ? 'phone-market-installed-agents' : 'phone-market-agents'}>
    {!installed && <PhoneMarketFilters search={t('phoneMarket.searchAgents')} query={query} onQueryChange={setQuery}
      choices={choices} category={category} onCategoryChange={setCategory} />}
    <div>
      {assistant && assistantText && onOpenApp && <PhoneMarketRow testId="phone-market-agent-assistant" name={assistantText.name}
        description={assistantText.subtitle} icon={<ExtensionMonogram name={assistantText.name} iconDataUrl={assistant.cloud.iconUrl} />}
        onOpen={() => onOpenApp({ kind: 'app-detail', extensionId: ASSISTANT_APP_ID })}
        action={assistantInstalled ? <span className="phone-market-status">{t('phoneMarket.installed')}</span>
          : <PhoneMarketAction label={t('phoneMarket.install')} name={assistantText.name}
            onClick={() => onOpenApp({ kind: 'app-detail', extensionId: ASSISTANT_APP_ID })} />} />}
      {device ? <LibraryHostProvider value={marketDeviceHost(device)}>
        <AgentRows query={query} category={category} targets={targets} installed={installed} onOpen={setDetail} />
      </LibraryHostProvider> : <SettingsNote role="status">{t(installed ? 'phoneMarket.noInstalled' : 'phoneMarket.noAgentHost')}</SettingsNote>}
    </div>
    {detail && (installed && device
      ? <Sheet fullScreenMobile onClose={() => setDetail(null)} ariaLabel={detail.name} testId="phone-market-agent-manage">
        <AgentPane name={detail.name} onClose={() => setDetail(null)}>
          <LibraryHostProvider value={marketDeviceHost(device)}><AgentDetail id={detail.id} /></LibraryHostProvider>
        </AgentPane>
      </Sheet>
      : <PhoneMarketAgentDetail agent={detail} targets={targets} onClose={() => setDetail(null)} />)}
  </div>
})

export function PhoneMarketLocalAgents({ device }: { device: Device | null }) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const [openPi, setOpenPi] = useState(false)
  const hasPi = !!user && device?.capabilities.runtimes.includes('pi') === true
  return <div className="phone-market">
    <MobileAppsSection mode="installed" installedAssistant hideInstalledEmpty={hasPi} />
    {hasPi && <PhoneMarketRow testId="phone-market-installed-pi" name="Pi" icon={<AppIcon id="pi" size={42} />}
      onOpen={() => setOpenPi(true)} />}
    {openPi && user && <Sheet fullScreenMobile onClose={() => setOpenPi(false)} ariaLabel="Pi">
      <Pane paneRole="detail" mobile className="gg-settings-detail">
        <PaneHeader mobile titleLevel="panel" title="Pi" leading={<IconButton size="lg"
          aria-label={t('settings.back')} onClick={() => setOpenPi(false)}><ChevronLeft /></IconButton>} />
        <div className="gg-settings-body"><PhoneAgentHostControl ownerId={user.id} /></div>
      </Pane>
    </Sheet>}
  </div>
}

function AgentRows({ query, category, targets, installed, onOpen }: {
  query: string
  category: Category
  installed: boolean
  targets: readonly Device[]
  onOpen(agent: AgentPayload): void
}) {
  const { t } = useTranslation('main')
  const { locale, translate } = useSessionMessages()
  const host = useLibraryHost()
  const agents = useManagementAgents()
  if (!agents.data) {
    if (host.remote?.online === false) return <SettingsNote role="status">{t('phoneMarket.deviceOffline')}</SettingsNote>
    if (agents.isError) return <SettingsNote tone="danger" role="alert">{t('phoneMarket.agentUnavailable')}
      <Button size="sm" onClick={() => void agents.refetch()}>{translate('extensions.retry')}</Button>
    </SettingsNote>
    return <AppConnectionListPlaceholder />
  }
  const rows = [...agents.data].sort(compareAgents).flatMap(agent => {
    const local = agent.reading !== undefined && isInstalledAgent(agent)
    const present = local || !installed && targets.some(device => device.capabilities.runtimes.includes(agent.id))
    const description = marketAgentDescription(agent, locale)
    if ((installed && !local) || (category !== 'all' && agentMarketCategoryOf(agent.id) !== category)) return []
    if (query.trim() && !queryScore(query, [agent.id, agent.name, agent.publisher, description].join(' '))) return []
    return [{ agent, present, description }]
  })
  return <>
    {rows.map(({ agent, present, description }) =>
      <PhoneMarketRow key={agent.id} testId={`phone-market-agent-${agent.id}`} name={agent.name} description={description}
        icon={<AppIcon id={agent.id} asset={agent.icon} size={42} />} onOpen={() => onOpen(agent)}
        action={present ? <span className="phone-market-status">{t('phoneMarket.installed')}</span>
          : <PhoneMarketAction label={t('phoneMarket.install')} name={agent.name} onClick={() => onOpen(agent)} />} />)}
    {!rows.length && <SettingsNote role="status">{t(installed ? 'phoneMarket.noInstalled' : 'phoneMarket.noResults')}</SettingsNote>}
  </>
}

function AgentPane({ name, onClose, children }: { name: string; onClose(): void; children: ReactNode }) {
  const { t } = useTranslation('main')
  return <Pane paneRole="detail" mobile className="gg-settings-detail">
    <PaneHeader mobile titleLevel="panel" title={name} leading={<IconButton size="lg" shape="pill"
      aria-label={t('settings.back')} onClick={onClose}><ChevronLeft /></IconButton>} />
    <div className="gg-settings-body phone-market">{children}</div>
  </Pane>
}

function PhoneMarketAgentDetail({ agent, targets, onClose }: { agent: AgentPayload; targets: readonly Device[]; onClose(): void }) {
  const { t, i18n } = useTranslation('main')
  const { translate, locale } = useSessionMessages()
  const [choosing, setChoosing] = useState(false)
  const rows = usePhoneAgentInstallTargets(agent.id, targets)
  const installedOn = rows.filter(row => row.present).map(row => row.name)
  const category = translate(`extensions.agentCategory.${agentMarketCategoryOf(agent.id)}`)
  return <Sheet fullScreenMobile onClose={onClose} ariaLabel={agent.name} testId="phone-market-agent-detail">
    <AgentPane name={agent.name} onClose={onClose}>
      <PhoneMarketRow name={agent.name} description={agent.publisher}
        icon={<AppIcon id={agent.id} asset={agent.icon} size={42} />} testId="phone-market-agent-detail-title" />
      <p className="phone-market-agent-description">{marketAgentDescription(agent, locale)}</p>
      <Button variant="primary" className="phone-market-install-submit" data-testid="phone-market-agent-install"
        onClick={() => setChoosing(true)}>{t('phoneMarket.install')}</Button>
      {installedOn.length > 0 && <p className="phone-market-target-summary" role="status">
        {t('phoneMarket.installedOn', { devices: new Intl.ListFormat(i18n.language).format(installedOn) })}
      </p>}
      <dl className="phone-market-agent-facts">
        {agent.latestVersion && <div><dt>{t('phoneMarket.latestVersion')}</dt><dd>{agent.latestVersion}</dd></div>}
        {agent.publisher && <div><dt>{t('phoneMarket.publisher')}</dt><dd>{agent.publisher}</dd></div>}
        <div><dt>{t('phoneMarket.categories')}</dt><dd>{category}</dd></div>
      </dl>
    </AgentPane>
    {choosing && <PhoneMarketInstallSheet rows={rows} onClose={() => setChoosing(false)} />}
  </Sheet>
}

function AgentDetail({ id }: { id: string }) {
  const { t } = useTranslation('main')
  const { locale } = useSessionMessages()
  const host = useLibraryHost()
  const query = useManagementAgent(id)
  if (host.remote?.online === false && !query.data) return <SettingsNote role="status">{t('phoneMarket.deviceOffline')}</SettingsNote>
  if (!query.data) return query.isError || query.data === null
    ? <SettingsNote role="status">{t('phoneMarket.agentUnavailable')}</SettingsNote>
    : <AppConnectionListPlaceholder />
  const agent = query.data
  return <>
    <PhoneMarketRow name={agent.name} description={marketAgentDescription(agent, locale)}
      icon={<AppIcon id={id} asset={agent.icon} size={42} />} testId="phone-market-agent-detail-title" />
    <fieldset className="contents" disabled={host.remote?.online === false}>
      <InstallSection agentId={id} agentPayload={agent} installOptions={agent.installOptions} installDocs={agent.installDocs} />
    </fieldset>
  </>
}
