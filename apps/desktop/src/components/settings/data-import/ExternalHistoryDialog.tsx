import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { desktopIpc } from '@/platform/desktopIpc'
import {
  externalImportChannels as channels,
  type ExternalImportPage,
} from '@shared/core/session-import/external-conversation-import'

export function ExternalHistoryDialog({
  sessionId, initialPage, onClose,
}: {
  sessionId: string
  initialPage: ExternalImportPage
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('settings')
  const [page, setPage] = useState(initialPage)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const datetime = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  async function loadMore() {
    if (loading || page.nextOffset === null) return
    setLoading(true)
    setFailed(false)
    try {
      const ipc = desktopIpc()
      const next = await ipc?.invoke(channels.read, sessionId, page.nextOffset) as ExternalImportPage | null | undefined
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
              <Dialog.Close render={<Button variant="secondary" size="sm">{t('externalHistory.close')}</Button>} />
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
