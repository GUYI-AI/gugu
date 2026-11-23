import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { InRequestWindow } from '@/components/InRequestWindow'
import { Button } from '@/components/ui/Button'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { useBackLayer } from '@/components/ui/sheetStack'
import { readConversationDeleteConfirmation, subscribeConversationDeleteConfirmation } from '@/lib/conversationDeleteConfirmation'

/** List actions must not depend on the desktop session page mounting its modal renderer. */
export function ConversationDeleteConfirmationHost() {
  const request = useSyncExternalStore(subscribeConversationDeleteConfirmation, readConversationDeleteConfirmation)
  useEffect(() => () => request?.finish(null), [request])
  return request ? <InRequestWindow key={request.id}><Choice request={request} /></InRequestWindow> : null
}

function Choice({ request }: { request: NonNullable<ReturnType<typeof readConversationDeleteConfirmation>> }) {
  const { t } = useTranslation('messaging')
  const { translate } = useSessionMessages()
  const cancel = () => request.finish(null)
  useBackLayer(cancel, true)
  return <Dialog.Root open onOpenChange={open => { if (!open) cancel() }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay-soft)]" />
      <Dialog.Viewport className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6">
        <Dialog.Popup data-testid="conversation-delete-confirm" className="pointer-events-auto flex w-full max-w-[380px] flex-col overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--border)] bg-[var(--card)] text-[length:var(--font-body)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)] outline-none">
          <div className="flex flex-col gap-3 p-6">
            <Dialog.Title className="text-[length:var(--font-title)] font-medium">{t('chatList.clearHistoryTitle', { name: request.name })}</Dialog.Title>
            <Dialog.Description className="leading-relaxed text-[var(--text-secondary)]">{t('chatList.deleteHistoryDescription')}</Dialog.Description>
          </div>
          <div className="flex justify-end gap-2 px-6 pb-6">
            <Button variant="secondary" onClick={cancel}>{translate('common.cancel')}</Button>
            <Button variant="danger" data-testid="conversation-delete-submit" onClick={() => request.finish(true)}>{t('chatList.clearHistoryConfirm')}</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
