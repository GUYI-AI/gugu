import { useTranslation } from 'react-i18next'
import { ComposerFastMode, type ChatComposerProps } from '@gugu/session-ui/react/components'
import { Button } from '@/components/ui/Button'

type Props = Pick<ChatComposerProps, 'effortOptions' | 'selectedEffort' | 'defaultEffort' | 'onEffortChange' | 'fastMode' | 'onFastModeChange'> & { disabled?: boolean }

/** Phone creation and live Work panels render the same advertised choices, without guessing a scale. */
export function PhoneThinkingOptions({ effortOptions, selectedEffort, defaultEffort, onEffortChange,
  fastMode, onFastModeChange, disabled }: Props) {
  const { t } = useTranslation('mobileCreateControls')
  const items = Object.entries(effortOptions ?? {})
  const effective = items.some(([id]) => id === selectedEffort) ? selectedEffort
    : items.some(([id]) => id === defaultEffort) ? defaultEffort : undefined
  if (!items.length && fastMode === undefined) return null
  return <div data-testid="phone-thinking-options">
    {items.length > 0 && <div className="gg-phone-composer-section-label">{t('effort')}</div>}
    {items.length > 0 && <div role="radiogroup" aria-label={t('effort')} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-xs)' }}>
      {items.map(([id, option]) => <Button key={id} variant="option" size="sm" role="radio" aria-checked={id === effective}
        style={{ minHeight: 'var(--control-h-touch)', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
        disabled={disabled || option.disabled || !onEffortChange} title={option.disabledReason ?? option.description}
        data-option-id={id} onClick={() => { if (id !== effective) onEffortChange?.(id) }}>{option.name}</Button>)}
    </div>}
    {fastMode !== undefined && <ComposerFastMode enabled={fastMode} disabled={disabled} onChange={onFastModeChange} phoneActions />}
  </div>
}
