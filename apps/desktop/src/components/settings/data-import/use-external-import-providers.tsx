import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
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

function externalProvider(
  id: ExternalImportSource,
  label: string,
  iconId: string,
  open: NonNullable<ImportProvider['openImportedSession']>,
): ImportProvider {
  return {
    id,
    label,
    iconId,
    async scan(deviceId) {
      const ipc = localIpc(deviceId)
      if (!ipc) return null
      return await ipc.invoke(channels.scan, id) as ExternalImportScan | null
    },
    ...(id === 'chatgpt' ? {
      async pickSource(deviceId: string | null) {
        const { status } = await requireLocalIpc(deviceId).invoke(channels.pick) as { status: string }
        if (status === 'invalid') throw new Error('Invalid conversation export')
      },
    } : {}),
    async importAll(deviceId, onProgress, signal) {
      const result: ImportResult = { imported: [], existing: 0, failed: 0 }
      if (signal.aborted) return result
      const ipc = requireLocalIpc(deviceId)
      const batch = await ipc.invoke(channels.start, id) as { id: string; total: number }
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
    async listHistory(deviceId) {
      const ipc = localIpc(deviceId)
      return ipc ? await ipc.invoke(channels.list, id) as ExternalImportHistoryEntry[] : []
    },
    openImportedSession: open,
  }
}

function ExternalHistoryDialog({
  history, onClose,
}: {
  history: OpenHistory
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('settings')
  const [page, setPage] = useState(history.page)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const datetime = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  async function loadMore() {
    if (loading || page.nextOffset === null) return
    setLoading(true)
    setFailed(false)
    try {
      const next = await requireLocalIpc(null).invoke(channels.read, history.session.sessionId, page.nextOffset) as ExternalImportPage | null
      if (!next) throw new Error('Imported conversation is unavailable')
      setPage({ ...next, messages: [...page.messages, ...next.messages] })
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup className="flex max-h-[80dvh] w-full max-w-2xl flex-col">
            <header className="shrink-0">
              <Dialog.Title className="break-words">{page.title}</Dialog.Title>
              <Dialog.Description>{t('externalHistory.readOnly')}</Dialog.Description>
            </header>
            <ol className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
              {page.messages.map((message, index) => (
                <li key={index} className="rounded-lg bg-foreground/[0.04] px-3 py-2">
                  <div className="mb-1 flex flex-wrap items-baseline gap-2 text-xs text-foreground-tertiary">
                    <span>{t(message.role === 'user' ? 'externalHistory.user' : 'externalHistory.assistant')}</span>
                    {message.at !== null && <time>{datetime.format(message.at)}</time>}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                </li>
              ))}
              {failed && <li role="status" className="text-sm text-foreground-tertiary">{t('externalHistory.readFailed')}</li>}
              {page.nextOffset !== null && (
                <li>
                  <Button variant="secondary" size="sm" disabled={loading} onClick={() => { void loadMore() }}>
                    {t(loading ? 'externalHistory.loading' : 'externalHistory.loadMore')}
                  </Button>
                </li>
              )}
            </ol>
            <footer className="flex shrink-0 justify-end">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>{t('externalHistory.close')}</Dialog.Close>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function useExternalImportProviders() {
  const { user } = useAuth()
  const ownerId = user?.id
  const [opened, setOpened] = useState<OpenHistory | null>(null)
  const providers = useMemo(() => {
    if (!ownerId) return []
    async function open(session: ImportedSession, deviceId: string | null) {
      if (!ownerId) return
      const page = await requireLocalIpc(deviceId).invoke(channels.read, session.sessionId, 0) as ExternalImportPage | null
      if (!page) throw new Error('Imported conversation is unavailable')
      setOpened({ ownerId, session, page })
    }
    return [
      externalProvider('chatgpt', 'ChatGPT', 'codex', open),
      externalProvider('cursor', 'Cursor', 'cursor', open),
    ]
  }, [ownerId])

  return {
    providers,
    historyDialog: opened && opened.ownerId === ownerId
      ? <ExternalHistoryDialog key={opened.session.sessionId} history={opened} onClose={() => setOpened(null)} />
      : null,
  }
}
