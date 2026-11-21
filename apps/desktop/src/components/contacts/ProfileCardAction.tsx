import type { IconComponent } from '@/lib/icons'
import { profileCardStyles } from './contactsPanelStyles'

/** One light icon-and-text action of a profile card (agent, person and group cards share this row). */
export function ProfileCardAction({ icon: Icon, label, onClick, testId, title }: { icon: IconComponent; label: string; onClick: () => void; testId?: string; title?: string }) {
  return (
    <button type="button" className={profileCardStyles.action} data-testid={testId} title={title} onClick={onClick}>
      <Icon size={19} />
      {label}
    </button>
  )
}
