import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Check } from '@/lib/icons'
import './phone-composer-controls.css'

export function PhoneComposerChoice({ id, dimension, name, description, icon, selected, disabled, onClick, testId = 'agent-watch-create-target-choice', source }: {
  id: string; dimension: string; name: string; description?: string | null; icon?: ReactNode
  selected?: boolean; disabled?: boolean; onClick: () => void; testId?: string; source?: 'harness' | 'gugu'
}) {
  return <Button variant="ghost" className="gg-phone-composer-choice" role="radio" aria-checked={!!selected} disabled={disabled}
    data-testid={testId} data-source={source} data-dimension={dimension} data-option-id={id} data-selected={selected || undefined} onClick={onClick}>
    {icon}<span className="gg-phone-composer-choice-body"><span className="gg-phone-composer-choice-name">{name}</span>
      {description && <span className="gg-phone-composer-choice-description">{description}</span>}</span>{selected && <Check />}
  </Button>
}
