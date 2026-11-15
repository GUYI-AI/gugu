import { dismissNotice, notify, type Notice } from './notices'

/** The producer supplies identity, never a title or message-text fingerprint. */
export type MessageFailureOwner = readonly [scope: 'im' | 'acp', accountOrHost: string, conversationId: string, messageId: string]
const attempts = new Map<string, object>()

/** One message owns one notice. Starting another attempt does not claim that it has succeeded. */
export function messageFailureNotice(owner: MessageFailureOwner) {
  const key = `message-failure:${JSON.stringify(owner)}`
  return {
    begin() {
      const attempt = {}
      attempts.set(key, attempt)
      const current = () => attempts.get(key) === attempt
      return {
        failed(notice: Omit<Notice, 'key'>) {
          if (!current()) return
          const retired = () => { if (current()) attempts.delete(key) }
          notify({ ...notice, key,
            onDismiss: () => { retired(); notice.onDismiss?.() },
            onAutoClose: () => { retired(); notice.onAutoClose?.() },
          })
        },
        succeeded() {
          if (!current()) return false
          attempts.delete(key)
          dismissNotice(key)
          return true
        },
      }
    },
    discard() { attempts.delete(key); dismissNotice(key) },
  }
}

export type MessageFailureAttempt = ReturnType<ReturnType<typeof messageFailureNotice>['begin']>
