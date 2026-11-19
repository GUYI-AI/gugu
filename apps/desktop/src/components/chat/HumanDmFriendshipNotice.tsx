import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from '@/lib/displayIdentity'
import { messageForUser } from '@/lib/userFacingError'
import { useContactsStore } from '@/store/contactsContext'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import './system-message-notice.css'

type Props = {
  chatId: string
  kind: ChatItem['kind'] | undefined
  currentUserId: string | null
  peer: DisplayIdentity | undefined
}

/** Desktop and phone share this stream footer; an unread/failed contacts snapshot proves nothing. */
export function HumanDmFriendshipNotice({ chatId, kind, currentUserId, peer }: Props) {
  const { contacts, contactsStatus, loadingContacts } = useContactsStore()
  if (kind !== 'dm' || !currentUserId || peer?.type !== 'human' || peer.id === currentUserId
    || contactsStatus !== 'ready' || loadingContacts || contacts.some(contact => contact.id === peer.id)) return null
  return <FriendshipRequest key={currentUserId + ':' + chatId + ':' + peer.id} peerId={peer.id} />
}

function FriendshipRequest({ peerId }: { peerId: string }) {
  const { t } = useTranslation(['messaging', 'contacts'])
  const { toast } = useToast()
  const { sendRequest, sentRequests } = useContactsStore()
  const [sending, setSending] = useState(false)
  const inFlight = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pending = sentRequests.some(request => request.receiver_id === peerId && request.status === 'pending')
  const request = async () => {
    if (inFlight.current || pending) return
    inFlight.current = true
    setSending(true)
    try {
      // Reuse the existing request API, with no greeting that could become a chat message.
      await sendRequest(peerId)
      if (mounted.current) toast(t('friendSearch.sentToast', { ns: 'contacts' }), 'success')
    } catch (error) {
      if (mounted.current) toast(t('friendSearch.sendFailed', { ns: 'contacts', detail: messageForUser(error) }), 'error')
    } finally {
      inFlight.current = false
      if (mounted.current) setSending(false)
    }
  }
  return <div className="system-message-notice" data-testid="human-dm-friendship-notice"><span>
    {t('humanDm.notFriends', { ns: 'messaging' })}{' '}
    <Button variant="ghost" disabled={sending || pending} onClick={() => void request()}
      className="inline h-auto min-h-0 max-[719px]:min-h-0 border-0 p-0 align-baseline text-[length:inherit] leading-[inherit] font-[inherit] text-[var(--text-secondary)] hover:underline [&:hover:not([data-disabled])]:bg-transparent">
      {sending ? t('friendSearch.sending', { ns: 'contacts' }) : pending ? t('friendSearch.sent', { ns: 'contacts' }) : t('humanDm.addFriend', { ns: 'messaging' })}
    </Button>
  </span></div>
}
