import { useMemo, useState } from 'react'
import type { ChatCommands } from '@gugu/session-chat-ui'
import { changeRejectedSessionInput, retrySessionInput, useQueuedSessionInputs } from '@/lib/sessionInputOutboxBridge'
import { runNativeInputAction } from '@/lib/nativeInputFailureNotice'

/** Bind sender-owned refusals to the transcript's existing editor and failed-message actions. */
export function useRejectedSessionInputCommands(sessionId: string): ChatCommands {
  const inputs = useQueuedSessionInputs(sessionId)
  const [edit, setEdit] = useState<{ itemId: string; text: string; pending: boolean } | null>(null)
  // Composer typing must not publish new commands and remeasure the transcript.
  return useMemo<ChatCommands>(() => {
    const rejected = (id: string) => inputs.find(input => input.id === id && input.admission === 'rejected')
    const run = (id: string, action: () => Promise<unknown>) => runNativeInputAction(sessionId, id, inputs.find(input => input.id === id)?.deviceId ?? null, action)
    return {
      canRevertMessage: id => !!rejected(id),
      canDiscardSend: id => !!rejected(id),
      onEditMessage: ({ itemId }) => { const input = rejected(itemId); if (input) setEdit({ itemId, text: input.text, pending: false }) },
      onDiscardSend: id => { void run(id, () => changeRejectedSessionInput(id, { kind: 'discard' })) },
      onRetrySend: id => { void run(id, () => retrySessionInput(id)) },
      editingMessage: edit && rejected(edit.itemId) ? {
        ...edit, canSubmit: !edit.pending && !!edit.text.trim(),
        onChange: text => setEdit({ ...edit, text }), onCancel: () => setEdit(null),
        onSubmit: () => {
          if (edit.pending || !edit.text.trim()) return
          setEdit({ ...edit, pending: true })
          void run(edit.itemId, async () => {
            await changeRejectedSessionInput(edit.itemId, { kind: 'edit', text: edit.text })
            setEdit(null); await changeRejectedSessionInput(edit.itemId, { kind: 'retry' })
          }).then(success => { if (!success) setEdit({ ...edit, pending: false }) })
        },
      } : undefined,
    }
  }, [inputs, edit, sessionId])
}
