import { useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { Button } from '@/components/ui/Button'
import { ChevronLeft, Plug } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { useDevicesStore } from '@/store/devicesContext'
import { ConnectionRouteBoundary } from '@/components/connections/ConnectionRouteBoundary'
import { useOwnerLibraryHost } from '@/components/connections/useOwnerLibraryHost'
import { keptByPlatform } from '@renderer/features/integrations/integration-setup-model'
import { useConnectionMutationAllowed } from '@/components/connections/connection-mutation-context'
import { IntegrationIcon } from '@renderer/features/integrations/integration-icon'
import { IntegrationsProvider, useIntegrationsContext } from '@renderer/features/integrations/integrations-provider'
import { LibraryHostProvider, useLibraryHost } from '@renderer/features/library/library-host'
import { RoutedIntegrationsLibraryPage } from '@renderer/features/library/routed-integrations-library-page'
import { useMcpLibrary } from '@renderer/features/mcp/components/use-mcp-library'
import { useShowModal } from '@renderer/lib/modal/modal-provider'
import type { LibraryMcpServer } from '@shared/mcp-library'
import type { InstalledItem } from './installed-item'

type Props = {
  render: (items: readonly InstalledItem[], state: { loading?: boolean; error?: boolean }) => ReactNode
  directManagement: boolean
}

function ConnectorItems({ render, directManagement }: Props) {
  const { t } = useTranslation('main')
  const host = useLibraryHost()
  const library = useMcpLibrary()
  const connections = useIntegrationsContext()
  const devices = useDevicesStore()
  const mutationAllowed = useConnectionMutationAllowed()
  const deviceId = host.remote?.deviceId ?? devices.devices.find((device) => device.is_current_device)?.device_id
  const showMcpForm = useShowModal('mcpServerModal')
  const [details, setDetails] = useState<string | null>(null)
  async function editMcp(server: LibraryMcpServer) {
    try {
      const harnessNames = await library.harnessNames()
      showMcpForm({
        initial: server,
        // A row was clicked: the list it came from is read.
        existing: library.servers ?? [],
        harnessNames,
        onSuccess: ([updated]) => { if (updated) void library.update({ ...updated, enabledByDefault: server.enabledByDefault }).catch(reportEditFailure) },
      })
    } catch { reportEditFailure() }
  }

  function reportEditFailure() {
    notify({ tier: 'error', title: t('installedManager.connectorEditFailed') })
  }

  const installedMcp = (library.servers ?? []).map((server): InstalledItem => ({
    id: `mcp:${server.name}`,
    name: server.name,
    icon: (size) => <span className="gg-installed-connector-icon" style={{ width: size, height: size }}><Plug size={Math.round(size * .55)} /></span>,
    open: () => { void editMcp(server) },
    enabled: server.enabledByDefault,
    setEnabled: (value) => library.setEnabledByDefault(server.name, value),
    remove: async () => { await library.remove(server.name) },
  }))
  const configured = connections.configuredConnections
  const connectedApps = (configured ? connections.integrations ?? [] : []).flatMap((integration): InstalledItem[] => {
    if (!configured![integration.id]) return []
    const canRemove = mutationAllowed && !keptByPlatform(integration) && (!host.connectionMetadata || !!deviceId)
    return [{
      id: `integration:${integration.id}`,
      name: integration.name,
      icon: (size) => <IntegrationIcon provider={integration.id} icon={integration.icon} size={size} />,
      open: () => setDetails(integration.id),
      busy: connections.isIntegrationMutating(integration.id),
      remove: canRemove ? async () => {
        const metadata = host.connectionMetadata
        if (metadata) {
          const accounts = (await metadata.collection('integrations')).filter((row) =>
            row.data.providerId === integration.id && row.device_id === deviceId && row.source?.scopeKey === `device:${deviceId}`)
          if (accounts.length === 0) throw new Error('No connection was found on the selected device')
          try {
            for (const row of accounts) {
              const result = await metadata.change(row, 'remove')
              if (result.status !== 'applied' && result.status !== 'pending') throw new Error('Connection removal did not complete')
            }
          } finally { connections.reloadConnections() }
        } else {
          const removed = await connections.disconnectIntegration(integration.id)
          if (!removed.success) throw new Error('No connection was removed')
        }
      } : undefined,
    }]
  })
  if (details !== null) {
    return (
      <div className="gg-installed-connector-detail">
        <Button variant="ghost" size="sm" onClick={() => setDetails(null)}><ChevronLeft size={16} />{t('installedManager.sectionsBack')}</Button>
        <RoutedIntegrationsLibraryPage host={host} inSettings inlineDetail initialConnectorId={details || undefined} />
      </div>
    )
  }
  return (
    <div className="gg-installed-connector-pane">
      {render([...connectedApps, ...installedMcp], {
        loading: (library.listLoading && !library.hasData) || (connections.configuredConnections === null && !connections.configuredConnectionsError),
        error: !!library.listError || !!connections.configuredConnectionsError || !!connections.listError,
      })}
      {directManagement && (
        <div className="gg-installed-connector-footer">
          <Button variant="secondary" size="sm" onClick={() => setDetails('')}>{t('installedManager.manageConnections')}</Button>
        </div>
      )}
    </div>
  )
}

const AccountConnectorItems = observer(function AccountConnectorItems({ route, ...props }: Props & { route: ConnectionRoute }) {
  const originalHost = useLibraryHost()
  const devices = useDevicesStore()
  const device = devices.devices.find((row) => originalHost.remote ? row.device_id === originalHost.remote.deviceId : row.is_current_device) ?? null
  const accountHost = useOwnerLibraryHost(device, route)
  if (!device) return props.render([], { loading: devices.loading, error: !devices.loading })
  return (
    <LibraryHostProvider value={accountHost} key={accountHost.key}>
      <IntegrationsProvider><ConnectorItems {...props} /></IntegrationsProvider>
    </LibraryHostProvider>
  )
})

export function InstalledConnectors(props: Props) {
  return (
    <ConnectionRouteBoundary
      pending={props.render([], { loading: true })}
      owner={(route) => <AccountConnectorItems {...props} route={route} />}
      legacy={<IntegrationsProvider><ConnectorItems {...props} /></IntegrationsProvider>}
    />
  )
}
