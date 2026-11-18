import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
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
  const titleId = useId()
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
    <Sheet onClose={onClose} titleId={titleId} desktopWidth="min(640px, 100%)"
      desktopMaxHeight="80dvh" mobileFitContent zIndex="var(--z-settings-modal)">
      <div className="flex min-h-0 flex-col px-5 py-4">
        <header className="shrink-0">
          <h2 id={titleId} className="break-words font-semibold">{page.title}</h2>
          <p className="text-sm text-foreground-tertiary">{t('externalHistory.readOnly')}</p>
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
          <Button variant="secondary" size="sm" onClick={onClose}>{t('externalHistory.close')}</Button>
        </footer>
      </div>
    </Sheet>
  )
}
