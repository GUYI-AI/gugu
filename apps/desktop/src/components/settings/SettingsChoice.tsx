import { useState } from 'react'
import { Button } from '../ui/Button'
import { Check, ChevronRight } from '@/lib/icons'
import { PhoneComposerSheet } from '@/mobile/composer/PhoneComposerControls'
import { SettingsSelect } from './SettingsSelect'

type Choice<Value extends string> = { value: Value; label: string }

export function SettingsChoice<Value extends string>({ id, testId, label, mobile, value, options, onChange }: {
  id: string
  testId?: string
  label: string
  mobile: boolean
  value: Value
  options: readonly Choice<Value>[]
  onChange: (value: Value) => void
}) {
  const [open, setOpen] = useState(false)
  if (!mobile) {
    return <SettingsSelect id={id} data-testid={testId} value={value} onChange={event => {
      const choice = options.find(option => option.value === event.currentTarget.value)
      if (choice) onChange(choice.value)
    }}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </SettingsSelect>
  }

  const current = options.find(option => option.value === value)
  return <>
    <Button variant="secondary" size="option" id={id} data-testid={testId ?? id}
      className="min-w-0 justify-between" aria-label={label} aria-describedby={`${id}-value`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span id={`${id}-value`}>{current?.label}</span><ChevronRight size={16} aria-hidden className="shrink-0 text-[var(--faint-fg)]" />
    </Button>
    <PhoneComposerSheet open={open} onClose={() => setOpen(false)} title={label} testId={`${id}-sheet`}>
      <div role="radiogroup" aria-label={label}>
        {options.map(option => {
          const selected = value === option.value
          return <Button key={option.value} variant="ghost" size="option" className="gg-phone-composer-choice" role="radio"
            aria-checked={selected} data-selected={selected || undefined} data-option-value={option.value} onClick={() => {
              setOpen(false)
              if (!selected) onChange(option.value)
            }}>
            <span className="min-w-0 flex-1">{option.label}</span>{selected && <Check aria-hidden />}
          </Button>
        })}
      </div>
    </PhoneComposerSheet>
  </>
}
