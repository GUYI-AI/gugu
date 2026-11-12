import { useTranslation } from 'react-i18next'
import { AppWindow, MessageCircle } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'

/** App navigation around one conversation; there are no chat/task conversation modes. */
export function SessionAppMenu({ appKind, apps, onOpenApp, onConversation }: {
  appKind: string | null; apps: readonly { kind: string; name: string }[]
  onOpenApp: (kind: string) => void; onConversation: () => void
}) {
  const { t } = useTranslation('main')
  if (!apps.length) return null
  const label = apps.find(app => app.kind === appKind)?.name ?? t('shell.chats')
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger render={<Button variant="ghost" size="sm">{appKind ? <AppWindow size={16} /> : <MessageCircle size={16} />}{label}</Button>} />
    <DropdownMenu.Content align="end">
      <MenuItem icon={<MessageCircle size={16} />} checked={!appKind} onClick={onConversation}>{t('shell.chats')}</MenuItem>
      {apps.map(app => <MenuItem key={app.kind} icon={<AppWindow size={16} />} checked={appKind === app.kind} onClick={() => onOpenApp(app.kind)}>{app.name}</MenuItem>)}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
}
