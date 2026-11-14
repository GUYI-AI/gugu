import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@renderer/lib/ui/checkbox'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { useBackLayer } from '@/components/ui/sheetStack'
import { readConversationDeleteConfirmation, subscribeConversationDeleteConfirmation } from '@/lib/conversationDeleteConfirmation'

/** List actions must not depend on the desktop session page mounting its modal renderer. */
export function ConversationDeleteConfirmationHost() {
  const request = useSyncExternalStore(subscribeConversationDeleteConfirmation, readConversationDeleteConfirmation)
  useEffect(() => () => request?.finish(null), [request])
  return request ? <Choice key={request.id} request={request} /> : null
}

function Choice({ request }: { request: NonNullable<ReturnType<typeof readConversationDeleteConfirmation>> }) {
  const { t } = useTranslation('messaging')
  const { translate } = useSessionMessages()
  const [checked, setChecked] = useState(false)
  const cancel = () => request.finish(null)
  useBackLayer(cancel, true)
  return <Dialog.Root open onOpenChange={open => { if (!open) cancel() }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay-soft)]" />
      <Dialog.Viewport className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6">
        <Dialog.Popup data-testid="conversation-delete-confirm" className="pointer-events-auto flex w-full max-w-xs flex-col overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--border)] bg-[var(--card)] text-[length:var(--font-body)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)] outline-none">
          <div className="flex flex-col gap-3 p-6">
            <Dialog.Title className="text-[length:var(--font-title)] font-medium">{t('chatList.delete')}</Dialog.Title>
            <Dialog.Description className="leading-relaxed text-[var(--text-secondary)]">{t('chatList.deleteHistoryDescription')}</Dialog.Description>
            {request.agentOption ? <label className="flex items-start gap-2">
              <Checkbox className="border-[var(--border-strong)] bg-[var(--card)] data-checked:border-[var(--primary)] data-checked:bg-[var(--primary)] data-checked:text-[var(--primary-fg)]" checked={checked} onCheckedChange={value => setChecked(Boolean(value))} />
              <span>{t('chatList.alsoRemoveAgent')}</span>
            </label> : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-[var(--border)] p-3">
            <Button variant="secondary" onClick={cancel}>{translate('common.cancel')}</Button>
            <Button variant="danger" data-testid="conversation-delete-submit" onClick={() => request.finish(checked)}>{t('chatList.delete')}</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
