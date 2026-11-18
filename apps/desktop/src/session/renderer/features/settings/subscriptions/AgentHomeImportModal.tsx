import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { FirstRunImport } from '@/components/firstRun/FirstRunImport'

export function AgentHomeImportModal({ home, machine, onSuccess }: BaseModalProps<void> & { home: AgentHomeScan; machine: string | null }) {
  return <div className="agent-home-modal" data-ta-scope><FirstRunImport homes={[home]} machine={machine} onDone={() => onSuccess()} /></div>
}
