import { useTranslation } from 'react-i18next'
import { ChevronRight } from '@/lib/icons'
import { useAuth } from '@/store/auth'
import { platform } from '@/platform'
import { UI_EVENTS } from '@/lib/uiEvents'
import { resumableStep, TOUR_STEPS, useProductTourState, type ProductTourRequest } from '@/lib/productTour'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsPrimitives'
import '../productTour/catalog'

export function HelpSection() {
  const { t } = useTranslation('productTour')
  const { user } = useAuth()
  const tour = useProductTourState(user?.id ?? null)
  // Progress not read yet (or unreadable): no 「继续」 entry until it is.
  const resume = resumableStep(tour.state === 'value' ? tour.value : null)
  function request(detail: ProductTourRequest) {
    window.dispatchEvent(new Event(UI_EVENTS.closeSettings))
    window.dispatchEvent(new CustomEvent(UI_EVENTS.reopenProductTour, { detail }))
  }
  return <SettingsPage>
    {platform.kind === 'electron' && <SettingsGroup>
      {resume && <SettingsRow data-testid="help-tour-resume"
        title={t('help.resume', { current: TOUR_STEPS.indexOf(resume) + 1, total: TOUR_STEPS.length })}
        control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
        onClick={() => request({ mode: 'resume', step: resume })} />}
      <SettingsRow data-testid="help-tour-restart" title={t('help.restart')}
        control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
        onClick={() => request({ mode: 'restart' })} />
    </SettingsGroup>}
    <SettingsGroup>
      <SettingsRow
        data-testid="about-feedback"
        title={t('shell.feedback', { ns: 'main' })}
        control={<ChevronRight size={16} aria-hidden="true" className="gg-settings-row-chevron" />}
        onClick={() => window.dispatchEvent(new Event(UI_EVENTS.sessionpageOpenFeedback))}
      />
    </SettingsGroup>
  </SettingsPage>
}
