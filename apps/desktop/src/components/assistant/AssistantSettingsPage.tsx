import { useEffect, useState } from 'react'
import { requestAssistantSetupAfterIntro } from '../../lib/firstRun'
import { useAuth } from '../../store/auth'
import { useTranslation } from 'react-i18next'
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import { AgentAiModelPane } from '../agentsettings/AgentAiModelPane'
import { AssistantSection } from '../settings/AssistantSection'
import { ConnectorsSection } from '../settings/ConnectorsSection'
import { AssistantDevicesPage } from '../devices/AssistantDevicesPage'
import { SettingsNote } from '../settings/SettingsPrimitives'
import { OnboardingSlot } from './AssistantShellHost'
import { Button } from '../ui/Button'
import { ChevronLeft } from '@/lib/icons'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { openAssistantEntry } from '../../lib/assistantEntry'
import { useAssistantPanelBack } from '../../lib/assistantPanelPage'
import { onAssistantSettingsSection, takeAssistantSettingsSection } from '../../lib/assistantSettingsSection'

const SECTIONS: readonly ActiveSection[] = ['connectors', 'devices', 'channels']

/**
 * The guide over the App's page starts at the name (D5): the App's own intro, under it, is the first screen the person saw
 * (its 开通, or any route the shell sends there). The one-shot hand-off is left before the guide mounts and takes it.
 */
function SetupAfterAppIntro({ ownerId }: { ownerId: string }) {
  useState(() => requestAssistantSetupAfterIntro(ownerId))
  return <OnboardingSlot />
}

/**
 * Setting the assistant up, drawn over its App's panel (the App's host layer `assistant-setup`): the setup guide while there
 * is none (name and figure → home → …; the App draws the steps after it). Who it is still being read, or unreadable: said as
 * it is, ❌ taken for none. The layer closes once it is there.
 */
export function AssistantSetupPage() {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const { mine, contact } = useAssistantHome()
  const unreadable = !contact && !mine.loading && !mine.agentId && !!mine.error
  if (!contact && !mine.loading && !mine.agentId && !unreadable) return user?.id ? <SetupAfterAppIntro key={user.id} ownerId={user.id} /> : null
  return (
    <div data-testid="assistant-setup-page">
      <SettingsNote tone={unreadable ? 'danger' : undefined}>{t(unreadable ? 'identity.unreadable' : 'identity.loading')}</SettingsNote>
    </div>
  )
}

/** 助理自己的设置入口；复用全局设置的数据、组件和操作，不另存一份配置。 */
export function AssistantSettingsPage({ onOpenPage, onOpenSection, panelNavigation = false }: {
  panelNavigation?: boolean
  onOpenPage?: (tab: 'memory' | 'tasks') => void
  onOpenSection?: (section: ActiveSection) => void
} = {}) {
  const { t } = useTranslation('assistant')
  const { contact, cloudDeviceId } = useAssistantHome()
  const [section, setSection] = useState<ActiveSection | 'aimodel' | null>(null)
  // An entry that asked for its model (换模型, the App's open "model"): over the App's panel, opened at it (now, or once drawn).
  useEffect(() => {
    if (!panelNavigation) return
    const take = () => {
      const asked = takeAssistantSettingsSection()
      if (asked) setSection(asked)
    }
    take()
    return onAssistantSettingsSection(take)
  }, [panelNavigation])
  // A detail owns the toolbar first; closing it restores this section's return.
  useAssistantPanelBack(panelNavigation && section ? `settings:${section}` : null, () => setSection(null), 0)
  return (
    <div data-testid="assistant-settings-page">
      {section && !panelNavigation ? (
        <Button variant="ghost" onClick={() => setSection(null)}>
          <ChevronLeft size={16} />{t('setup.back')}
        </Button>
      ) : null}
      {section === 'aimodel' && contact ? <AgentAiModelPane agent={contact} />
        : section === 'connectors' ? <ConnectorsSection panelNavigation={panelNavigation} />
        : section === 'devices' ? <AssistantDevicesPage cloudDeviceId={cloudDeviceId} panelNavigation={panelNavigation} />
        : section === 'channels' ? <ConnectorsSection panelNavigation={panelNavigation} />
        : <AssistantSection available={SECTIONS} onOpenSection={onOpenSection ?? setSection} onOpenModel={() => setSection('aimodel')}
            onOpenAssistantPage={onOpenPage ?? (() => { openAssistantEntry() })} />}
    </div>
  )
}
