import type { ReactNode } from 'react'

/** Message-list artwork with an attention mark in the status corner (bottom-right, as Avatar's own status mark). */
export function PhoneMessageAvatar({ children, badge }: { children: ReactNode; badge?: ReactNode }) {
  return <span className="gg-phone-message-avatar">
    {children}
    {badge ? <span className="gg-phone-message-avatar-badge">{badge}</span> : null}
  </span>
}
