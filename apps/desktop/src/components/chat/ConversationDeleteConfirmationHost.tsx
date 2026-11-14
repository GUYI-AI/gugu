import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@renderer/lib/ui/button'
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
      <Dialog.Backdrop className="z-[var(--z-modal)]" />
      <Dialog.Viewport className="gg-window-layer pointer-events-none z-[var(--z-modal)] flex items-center justify-center p-6">
        <Dialog.Popup data-testid="conversation-delete-confirm" className="pointer-events-auto flex w-full max-w-xs flex-col overflow-hidden rounded-xl bg-background-quaternary text-sm shadow-lift outline-none">
          <div className="flex flex-col gap-3 p-6">
            <Dialog.Title>{t('chatList.delete')}</Dialog.Title>
            <Dialog.Description>{t('chatList.deleteHistoryDescription')}</Dialog.Description>
            {request.agentOption ? <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox checked={checked} onCheckedChange={value => setChecked(Boolean(value))} />
              <span>{t('chatList.alsoRemoveAgent')}</span>
            </label> : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-border bg-background-quaternary-1 p-3">
            <Button variant="outline" onClick={cancel}>{translate('common.cancel')}</Button>
            <Button variant="destructive" data-testid="conversation-delete-submit" onClick={() => request.finish(checked)}>{t('chatList.delete')}</Button>
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
