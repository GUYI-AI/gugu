import { useTranslation } from 'react-i18next'
import { useMemo, useState } from 'react'
import { desktopIpc } from '@/platform/desktopIpc'
import { useAuth } from '@/store/auth'
import {
  externalImportChannels as channels,
  type ExternalImportBatch,
  type ExternalImportHistoryEntry,
  type ExternalImportPage,
  type ExternalImportScan,
  type ExternalImportSource,
} from '@shared/core/session-import/external-conversation-import'
import { ExternalHistoryDialog } from './ExternalHistoryDialog'
import type { ImportedSession, ImportProvider, ImportResult } from './import-providers'

type OpenHistory = { ownerId: string; session: ImportedSession; page: ExternalImportPage }

function localIpc(deviceId: string | null) {
  return deviceId === null ? desktopIpc() : null
}

function requireLocalIpc(deviceId: string | null) {
  const ipc = localIpc(deviceId)
  if (!ipc) throw new Error('Local import is unavailable')
  return ipc
}

function historyProvider(
  id: ExternalImportSource,
  label: string,
  iconId: string,
  open: NonNullable<ImportProvider['openImportedSession']>,
): ImportProvider {
  return {
    id,
    label,
    iconId,
    localOnly: true,
    historyOnly: true,
    // Without a scan result the source has no card; its stored history stays listed and openable.
    async scan() { return null },
    async importAll() { return { imported: [], existing: 0, failed: 0 } },
    async listHistory(deviceId) {
      const ipc = localIpc(deviceId)
      return ipc ? await ipc.invoke(channels.list, id) as ExternalImportHistoryEntry[] : []
    },
    openImportedSession: open,
  }
}

function cursorProvider(open: NonNullable<ImportProvider['openImportedSession']>): ImportProvider {
  return {
    ...historyProvider('cursor', 'Cursor', 'cursor', open),
    async scan(deviceId) {
      const ipc = localIpc(deviceId)
      if (!ipc) return null
      return await ipc.invoke(channels.scan) as ExternalImportScan | null
    },
    async importAll(deviceId, onProgress, signal) {
      const result: ImportResult = { imported: [], existing: 0, failed: 0 }
      if (signal.aborted) return result
      const ipc = requireLocalIpc(deviceId)
      const batch = await ipc.invoke(channels.start) as { id: string; total: number }
      let done = 0
      onProgress(0, batch.total)
      try {
        while (done < batch.total && !signal.aborted) {
          const next = await ipc.invoke(channels.next, batch.id) as ExternalImportBatch
          result.imported.push(...next.imported)
          result.existing += next.alreadyImported
          result.failed += next.failed
          done = next.done
          onProgress(done, batch.total)
        }
      } finally {
        if (done < batch.total || batch.total === 0) await ipc.invoke(channels.cancel, batch.id)
      }
      return result
    },
  }
}

export function useExternalImportProviders() {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const ownerId = user?.id
  const [opened, setOpened] = useState<OpenHistory | null>(null)
  const providers = useMemo(() => {
    if (!ownerId || !desktopIpc()) return []
    async function open(session: ImportedSession, deviceId: string | null) {
      if (!ownerId) return
      const page = await requireLocalIpc(deviceId).invoke(channels.read, session.sessionId, 0) as ExternalImportPage | null
      if (!page) throw new Error('Imported conversation is unavailable')
      setOpened({ ownerId, session, page })
    }
    return [
      historyProvider('chatgpt', t('settings.dataImport.chatgptExport'), 'codex', open),
      cursorProvider(open),
    ]
  }, [ownerId, t])

  return {
    providers,
    historyDialog: opened && opened.ownerId === ownerId
      ? <ExternalHistoryDialog
        key={opened.session.sessionId} sessionId={opened.session.sessionId}
        initialPage={opened.page} onClose={() => setOpened(null)}
      />
      : null,
  }
}
