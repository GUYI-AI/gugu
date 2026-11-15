import { useTranslation } from 'react-i18next'
import { AppWindow, MessageCircle } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'
import { Unknown } from '@/components/ui/Unknown'

/** App navigation around one conversation; there are no chat/task conversation modes. */
export function SessionAppMenu({ appKind, apps, pending = false, onOpenApp, onConversation }: {
  appKind: string | null; apps: readonly { kind: string; name: string }[]
  /** More rows are not known yet (the installed Apps unread): a placeholder row holds their place. */
  pending?: boolean
  onOpenApp: (kind: string) => void; onConversation: () => void
}) {
  const { t } = useTranslation('main')
  if (!apps.length) return null
  const label = apps.find(app => app.kind === appKind)?.name ?? t('shell.chats')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" className="max-w-36" title={label}>{appKind ? <AppWindow size={16} /> : <MessageCircle size={16} />}<span className="min-w-0 truncate">{label}</span></Button>} />
    <DropdownMenu.Content align="end">
      <MenuItem icon={<MessageCircle size={16} />} checked={!appKind} onClick={onConversation}>{t('shell.chats')}</MenuItem>
      {apps.map(app => <MenuItem key={app.kind} icon={<AppWindow size={16} />} checked={appKind === app.kind} onClick={() => onOpenApp(app.kind)}>{app.name}</MenuItem>)}
      {pending ? <div className="px-2 py-1.5"><Unknown className="w-24" /></div> : null}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
}
