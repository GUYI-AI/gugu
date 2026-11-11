import { useTranslation } from 'react-i18next'
import type { AssistantIntroCopy } from '@gugu/core/shared/assistantRulesFormat'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { DEFAULT_ASSISTANT_LOOK } from '../agentAvatar/look'
import { Button } from '../ui/Button'
import { useMobileShell } from '@/hooks/useMobileShell'
import '../../i18n/registerMainCatalog'

/**
 * #1931 The first run's one-page introduction. The host draws it — the avatar, the rows about the host's own places, the
 * buttons; the words about the assistant are the product's (its rules' `intro`). Without them in the person's locale:
 * the host's neutral heading, and nothing about the assistant. The page is otherwise the one the assistant's setup opens
 * with, element for element.
 */
export function FirstRunWelcome({
  copy,
  summaryOnly,
  primaryLabel,
  onPrimary,
  laterLabel,
  onLater,
  backLabel,
  onBack,
  busy,
  error,
}: {
  copy: Readonly<AssistantIntroCopy> | null
  /** The desktop's first run: one sentence instead of the rows. */
  summaryOnly: boolean
  primaryLabel: string
  onPrimary: () => void
  laterLabel: string
  onLater: () => void
  backLabel: string
  onBack: () => void
  busy: boolean
  error: string | null
}) {
  const { t } = useTranslation('main')
  const mobile = useMobileShell()
  const device = mobile ? 'phone' : 'desktop'
  const rows = mobile ? ['messages', 'partners'] as const : ['projects', 'chats'] as const
  return (
    <>
      <AgentAvatar id="assistant-draft" name={t('brand.name')} look={DEFAULT_ASSISTANT_LOOK} size={88} />
      <h1 className="ta-onb-title">{copy ? copy.title : t('firstRun.introTitle')}</h1>
      {summaryOnly ? (copy ? <p className="ta-onb-sub">{copy.summary}</p> : null) : <>
      {copy ? (
        <div className="ta-onb-intro-gugu" data-intro-row="gugu" data-intro-device={device}>
          <strong className="ta-onb-choice-title">{t('brand.name')}</strong>
          <p className="ta-onb-choice-body">{device === 'phone' ? copy.phoneBody : copy.desktopBody}</p>
        </div>
      ) : null}
      <ul className="ta-onb-intro" data-testid="assistant-intro-rows" data-intro-device={device}>
        {rows.map((row) => (
          <li key={row} className="ta-onb-intro-row" data-intro-row={row}>
            <span className="ta-onb-intro-text">
              <strong className="ta-onb-choice-title">{t(`firstRun.introRows.${row}.title`)}</strong>
              <span className="ta-onb-choice-body">{t(`firstRun.introRows.${row}.body`)}</span>
            </span>
          </li>
        ))}
      </ul>
      </>}
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions ta-onb-actions-stack">
        <Button
          variant="primary"
          size="lg"
          className="rounded-full ta-onb-primary"
          onClick={onPrimary}
          disabled={busy}
          aria-busy={busy}
          data-testid="assistant-intro-primary"
        >
          {primaryLabel}
        </Button>
        <div className="flex items-center justify-center self-center">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onBack} disabled={busy} data-testid="assistant-intro-back">{backLabel}</Button>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onLater} disabled={busy} data-testid="assistant-intro-later">
            {laterLabel}
          </Button>
        </div>
      </div>
    </>
  )
}
