import { Plug } from '@/lib/icons'
import { Avatar, type AvatarProps } from '../Avatar'
import { IdentityPlaceholder } from '../IdentityPlaceholder'

/** A sender-less row: a group webhook's message (#3934) shows the webhook; anything else is a closed account. */
export function MessageSenderAvatar({ senderUserId, webhook, ...props }: AvatarProps & { senderUserId: string | null; webhook?: boolean }) {
  if (senderUserId === null && webhook) return <WebhookAvatar size={32} />
  return senderUserId === null ? <IdentityPlaceholder size={32} /> : <Avatar {...props} />
}

const sizeOf = (size: number) => ({ width: size, height: size })

/** A webhook is no person: the neutral disc of a sender-less row (IdentityPlaceholder) with the connection glyph. */
export function WebhookAvatar({ size }: { size: number }) {
  return (
    <span aria-hidden="true" data-webhook-avatar="true" className="grid shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-foreground/55"
      style={sizeOf(size)}>
      <Plug size={Math.round(size * 0.55)} />
    </span>
  )
}
