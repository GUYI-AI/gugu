import { useTranslation } from 'react-i18next'
import { AppWindow, MessageCircle } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'

type SessionAppMenuProps = {
  appKind: string | null; apps: readonly { kind: string; name: string }[]
  onOpenApp: (kind: string) => void; onConversation: () => void
}

export function SessionAppMenuItems({ appKind, apps, onOpenApp, onConversation }: SessionAppMenuProps) {
  const { t } = useTranslation('main')
  return <>
    <MenuItem icon={<MessageCircle size={16} />} checked={!appKind} onClick={onConversation}>{t('shell.chats')}</MenuItem>
    {apps.map(app => <MenuItem key={app.kind} icon={<AppWindow size={16} />} checked={appKind === app.kind} onClick={() => onOpenApp(app.kind)}>{app.name}</MenuItem>)}
  </>
}

/** App navigation around one conversation; there are no chat/task conversation modes. */
export function SessionAppMenu({ appKind, apps, onOpenApp, onConversation }: SessionAppMenuProps) {
  const { t } = useTranslation('main')
  if (!apps.length) return null
  const label = apps.find(app => app.kind === appKind)?.name ?? t('shell.chats')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" className="max-w-36" title={label}>{appKind ? <AppWindow size={16} /> : <MessageCircle size={16} />}<span className="min-w-0 truncate">{label}</span></Button>} />
    <DropdownMenu.Content align="end">
      <SessionAppMenuItems appKind={appKind} apps={apps} onOpenApp={onOpenApp} onConversation={onConversation} />
    </DropdownMenu.Content>
  </DropdownMenu.Root>
}
