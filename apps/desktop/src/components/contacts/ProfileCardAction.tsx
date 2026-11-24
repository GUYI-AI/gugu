import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { profileCardStyles } from './contactsPanelStyles'

/**
 * One light icon-and-text action of a profile card (the contacts pane and the member card share it).
 * `stacked`: icon above the label, sharing a row equally with its siblings — how the narrow member card lays out its
 * secondary actions, where an icon beside the label leaves no room for the text.
 */
export function ProfileCardAction({ icon: Icon, label, onClick, testId, title, disabled, stacked = false }: { icon: IconComponent; label: string; onClick: (() => void) | undefined; testId?: string; title?: string; disabled?: boolean; stacked?: boolean }) {
  return (
    <button type="button" className={cn(profileCardStyles.action, stacked && profileCardStyles.actionStacked)} data-testid={testId} title={title} disabled={disabled} onClick={onClick}>
      <Icon size={19} />
      {label}
    </button>
  )
}
