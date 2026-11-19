import type { ReactNode } from 'react'
import type { AgentProviderId } from '@gugu/session-plugins/agents'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { useInstalledAgentRows } from '@renderer/features/extensions/panel/installed-agent-rows'
import { installedAgentControl } from './installed-agent-control'
import type { InstalledItem } from './installed-item'

export function InstalledAgents({ render, onOpenAgent }: {
  render: (items: readonly InstalledItem[], state: { loading?: boolean; error?: boolean }) => ReactNode
  onOpenAgent: (id: string) => void
}) {
  const { rows, inventory, operations, busy, uninstalling } = useInstalledAgentRows('')
  const items = rows.map(({ agent, reading }): InstalledItem => {
    const id = agent.id as AgentProviderId
    const installing = busy.has(id)
    const control = installedAgentControl(agent, reading, installing)
    const step = control.update
    return {
      id,
      name: agent.name,
      version: control.version,
      icon: (size) => <AppIcon id={id} size={size} />,
      open: () => onOpenAgent(id),
      busy: installing || uninstalling.has(id),
      update: step ? async () => {
        const run = step.kind === 'update' ? operations.updateAsync : operations.installAsync
        const value = await run({ id, method: step.method, registry: step.registry })
        if (!value.success) throw new Error('Agent installation did not complete')
      } : undefined,
      remove: control.canRemove ? () => operations.uninstallAsync({ id }) : undefined,
    }
  })
  return render(items, { loading: inventory.isLoading, error: inventory.isError })
}
