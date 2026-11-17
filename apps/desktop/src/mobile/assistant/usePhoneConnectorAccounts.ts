import { useCallback } from 'react'
import type { AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { assistantAccountDisplayName } from '@/components/assistant/assistant-app-connections'
import { useAssistantPanelCollection } from '@/components/assistant/assistant-panel-reads'
import { assistantPanel } from '@/components/assistant/assistant-panel-replica'
import { refreshFailure } from '@/lib/replica'

export type ConnectorAccountRow = { accountId: string; label: string; connectedAt: number | null }
export type PhoneConnectorAccounts = { accounts: ConnectorAccountRow[] | null; supported: boolean; error: unknown; reload(): void }

/** Saved account labels only (no credential lookup), derived from the panel's `integrations`. null = not read yet; `error` with `accounts`: a refresh failed over them. */
export function usePhoneConnectorAccounts({ machine,id,name,enabled }: {
  machine: AssistantMachine | null; device: string | null; id: string; name: string; enabled: boolean
}): PhoneConnectorAccounts {
  const derive = useCallback((rows: AssistantPanelItem[]) => rows.filter(row => row.data.providerId === id && typeof row.data.accountId === 'string').map(row => ({
    accountId: row.data.accountId as string,label: assistantAccountDisplayName(row.data.displayName) ?? name,connectedAt: null,
  })),[id,name])
  const reading = useAssistantPanelCollection(enabled ? machine : null,'integrations',derive)
  const reload = () => { if (machine?.panel) void assistantPanel.refresh(machine.panel.assistantId) }
  return { accounts: reading.state === 'value' ? reading.value : null,supported: true,error: refreshFailure(reading),reload }
}
