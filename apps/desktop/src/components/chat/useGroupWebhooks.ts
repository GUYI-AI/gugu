import { useCallback, useState } from 'react'
import { currentGroupWebhooks, type GroupWebhook } from '../../lib/groupWebhooks'
import { refreshFailure, replica, useReplica, valueOf } from '../../lib/replica'
import { messageForUser } from '../../lib/userFacingError'

/**
 * #3934 A group's webhooks, for its owner or admins (the database refuses anyone else). The manage page, the list and a
 * webhook's page read this one entry. Memory only (no `persist`): every row carries its token.
 */
export const groupWebhookList = replica({
  name: 'groupWebhooks',
  scope: 'account',
  read: async (_owner: string, chatId: string) => (await currentGroupWebhooks()).list(chatId),
})

export type GroupWebhooksState = ReturnType<typeof useGroupWebhooks>

/** Every change answers with the webhook as stored; that row replaces ours. A failed change keeps what is stored and says why. */
export function useGroupWebhooks(chatId: string) {
  const reading = useReplica(groupWebhookList, [chatId])
  const [changeError, setChangeError] = useState<string | null>(null)
  const readError = refreshFailure(reading)

  const change = useCallback(async (run: (hooks: Awaited<ReturnType<typeof currentGroupWebhooks>>) => Promise<GroupWebhook>, removed = false): Promise<GroupWebhook | null> => {
    setChangeError(null)
    const entry = groupWebhookList.at(chatId)
    try {
      const row = await run(await currentGroupWebhooks())
      if (groupWebhookList.peek(chatId).state !== 'value') void groupWebhookList.refresh(chatId)
      else entry.set((current) => {
        const list = current ?? []
        if (removed) return list.filter((hook) => hook.id !== row.id)
        return list.some((hook) => hook.id === row.id) ? list.map((hook) => (hook.id === row.id ? row : hook)) : [...list, row]
      })
      return row
    } catch (failure) {
      setChangeError(messageForUser(failure))
      return null
    }
  }, [chatId])

  return {
    hooks: valueOf(reading) ?? null,
    error: changeError ?? (readError ? messageForUser(readError) : null),
    create: (name: string, targetUserIds: readonly string[]) => change((hooks) => hooks.create(chatId, name, targetUserIds)),
    update: (hook: GroupWebhook, next: { name?: string; targetUserIds?: readonly string[] }) => change((hooks) => hooks.update(hook.id, next)),
    setDisabled: (hook: GroupWebhook, disabled: boolean) => change((hooks) => hooks.setDisabled(hook.id, disabled)),
    rotate: (hook: GroupWebhook) => change((hooks) => hooks.rotate(hook.id)),
    remove: (hook: GroupWebhook) => change((hooks) => hooks.remove(hook.id), true),
  }
}
