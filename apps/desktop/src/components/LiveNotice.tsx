import { useEffect } from 'react'
import { dismissNotice, notify, type Notice } from '@/lib/notices'

/**
 * A notice that mirrors a component's state: rendered = shown, every render updates it in place, unmounted = gone (the user
 * closing it calls onDismiss; the owner then stops rendering it). For cards whose content is live (progress, a prompt, a
 * reminder): the owning component keeps its state, the one NoticeHost draws it.
 */
export function LiveNotice({ noticeKey, ...notice }: Omit<Notice, 'key'> & { noticeKey: string }): null {
  // A passive effect, like every other notice: sonner's Toaster subscribes in one, and the host is mounted before the
  // tree (Toast.tsx), so its subscription is in place first. A layout effect would emit before it and be lost.
  useEffect(() => { notify({ ...notice, key: noticeKey }) })
  useEffect(() => () => dismissNotice(noticeKey), [noticeKey])
  return null
}
