import { Monitor } from '@/lib/icons'
import { Button } from './Button'
import './machine-list.css'

export type MachineListItem = { id: string; label: string; isLocal?: boolean; isOnline: boolean }

export function MachineList({ label, machines, selected, onlineLabel, offlineLabel, onSelect }: {
  label: string
  machines: readonly MachineListItem[]
  selected: string
  onlineLabel: string
  offlineLabel: string
  onSelect: (id: string) => void
}) {
  return (
    <nav className="gg-machine-list" aria-label={label}>
      <div className="gg-machine-list-title">{label}</div>
      {machines.map((machine) => (
        <Button key={machine.id} variant="ghost" className="gg-machine-list-row"
          aria-current={selected === machine.id ? 'true' : undefined} onClick={() => onSelect(machine.id)}>
          <Monitor size={16} aria-hidden />
          <span className="truncate" title={machine.label}>{machine.label}</span>
          {!machine.isLocal && <span className="gg-machine-list-dot" data-online={machine.isOnline || undefined}
            role="img" aria-label={machine.isOnline ? onlineLabel : offlineLabel} />}
        </Button>
      ))}
    </nav>
  )
}
