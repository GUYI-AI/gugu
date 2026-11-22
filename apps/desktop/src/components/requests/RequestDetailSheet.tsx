import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { Avatar } from '../Avatar'
import { Sheet } from '../ui/Sheet'
import { DrawerClose } from '../contacts/ContactsPageFrame'
import { useDrawerPortal } from '../contacts/contactsDrawer'
import { nameClampClass } from '../contacts/contactsPanelStyles'
import { cn } from '@/lib/cn'

type RequestPeer = Pick<ContactUser, 'id' | 'display_name' | 'avatar' | 'gugu_number' | 'type'>

// 「新的请求」点开一行:这条请求是谁、说明、完整附言;底部与那一行同样的操作或状态。
export function RequestDetailSheet({ peer, context, message, footer, onClose }: {
  peer: RequestPeer
  context: string
  message: string | null
  footer: ReactNode
  onClose: () => void
}) {
  const { t } = useTranslation('contacts')
  // 桌面通讯录右边那一列抽屉(与分组页点开联系人同一列);手机整页没有抽屉,照旧是底部弹层。
  const drawer = useDrawerPortal(onClose)
  const body = (
    <div className="flex min-h-0 flex-col gap-4 px-5 pb-5 pt-6">
      <div className="flex items-center gap-3">
        <Avatar name={peer.display_name} avatarUrl={peer.avatar} seed={peer.id} size="lg" isAgent={peer.type === 'agent'} />
        <div className="min-w-0">
          <div className={cn(nameClampClass, 'text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]')} title={peer.display_name}>{peer.display_name}</div>
          {peer.gugu_number == null ? null : (
            <div className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{t('friendSearch.guguNumberValue', { number: peer.gugu_number })}</div>
          )}
        </div>
      </div>
      <div className="text-[length:var(--font-body)] text-[var(--text-secondary)]">{context}</div>
      {message ? (
        <p className="m-0 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--muted)] px-3 py-[10px] text-[length:var(--font-body)] text-[var(--text-primary)]">{message}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2 text-[length:var(--font-body)] text-[var(--text-tertiary)]">{footer}</div>
    </div>
  )
  if (drawer) return drawer(<div data-testid="request-detail" className="flex min-h-0 flex-1 flex-col !pt-8">{body}<DrawerClose onClose={onClose} /></div>)
  return (
    <Sheet onClose={onClose} ariaLabel={peer.display_name} testId="request-detail" desktopWidth="min(400px, 100%)" mobileFitContent>
      {body}
    </Sheet>
  )
}
