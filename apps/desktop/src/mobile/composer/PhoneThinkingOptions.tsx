import { useTranslation } from 'react-i18next'
import type { ChatComposerProps } from '@gugu/session-ui/react/components'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { Check, ChevronRight } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import './PhoneThinkingOptions.css'

type Props = Pick<ChatComposerProps, 'effortOptions' | 'selectedEffort' | 'defaultEffort' | 'onEffortChange' | 'fastMode' | 'onFastModeChange'> & { disabled?: boolean; fastModePending?: boolean; onOpenEffort?: () => void; onDefaultEffort?: () => void }

/** The root shows a summary; the child page keeps native reasoning IDs and capability-backed Fast. */
export function PhoneThinkingOptions({ effortOptions, selectedEffort, defaultEffort, onEffortChange,
  fastMode, onFastModeChange, fastModePending, disabled, onOpenEffort, onDefaultEffort }: Props) {
  const { t } = useTranslation('mobileCreateControls')
  const { t: tm } = useTranslation('main')
  const items = Object.entries(effortOptions ?? {})
  const effective = items.some(([id]) => id === selectedEffort) ? selectedEffort
    : items.some(([id]) => id === defaultEffort) ? defaultEffort : undefined
  if (!items.length && fastMode === undefined) return null
  return <div data-testid="phone-thinking-options">
    {items.length > 0 && onOpenEffort ? <Button variant="ghost" className="gg-phone-composer-choice"
      data-testid="agent-watch-create-options-drill" data-dimension="effort" disabled={disabled} onClick={onOpenEffort}>
      <span>{t('effort')}</span><span className="gg-phone-composer-choice-description gg-phone-composer-summary-value">
        {effective ? effortOptions?.[effective]?.name : tm('agentWatch.create.modelDefault')}
      </span><ChevronRight />
    </Button> : items.length > 0 && <div role="radiogroup" aria-label={t('effort')} className="gg-phone-thinking-levels">
      {onDefaultEffort && <Button variant="ghost" size="option" role="radio" aria-checked={selectedEffort === undefined}
        className="gg-aw-choice gg-phone-thinking-choice" disabled={disabled} data-option-id="" onClick={onDefaultEffort}>
        <span className="gg-aw-choice-radio" data-on={selectedEffort === undefined ? 'true' : undefined}>{selectedEffort === undefined && <Check />}</span>
        <span className="gg-aw-choice-body"><span className="gg-aw-choice-label">{tm('agentWatch.create.modelDefault')}</span>
          <span className="gg-aw-choice-desc">{tm('agentWatch.create.effortDefaultHint')}</span></span>
      </Button>}
      {items.map(([id, option]) => <Button key={id} variant="ghost" size="option" role="radio" aria-checked={(!onDefaultEffort || selectedEffort !== undefined) && id === effective}
        className="gg-aw-choice gg-phone-thinking-choice" disabled={disabled || option.disabled || !onEffortChange}
        title={option.disabledReason ?? option.description} data-option-id={id}
        onClick={() => { if (id !== effective) onEffortChange?.(id) }}>
        <span className="gg-aw-choice-radio" data-on={(!onDefaultEffort || selectedEffort !== undefined) && id === effective ? 'true' : undefined}>{(!onDefaultEffort || selectedEffort !== undefined) && id === effective && <Check />}</span>
        <span className="gg-aw-choice-body"><span className="gg-aw-choice-label">{option.name}</span>
          {option.description && <span className="gg-aw-choice-desc">{option.description}</span>}</span>
      </Button>)}
    </div>}
    {fastMode !== undefined && <div className="gg-phone-composer-choice gg-phone-thinking-fast" data-testid="phone-fast-option">
      <span className="gg-phone-composer-choice-body">Fast</span>
      {fastModePending && <span className="gg-phone-thinking-fast-status" role="status">
        <LoadingIndicator size="inline" />{t('switchingFast')}
      </span>}
      <Switch aria-label="Fast" aria-busy={fastModePending || undefined} data-phone-fast="" checked={fastMode}
        disabled={disabled || fastModePending || !onFastModeChange}
        onCheckedChange={value => onFastModeChange?.(value)} />
    </div>}
  </div>
}
