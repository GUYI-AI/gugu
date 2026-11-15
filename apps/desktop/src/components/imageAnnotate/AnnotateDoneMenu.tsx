import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { Sheet } from '../ui/Sheet'
import type { useAnnotateActions } from './useAnnotateActions'

type Actions = ReturnType<typeof useAnnotateActions>
export function AnnotateDoneMenu({ actions, mobile }: { actions: Actions; mobile: boolean }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const [open, setOpen] = useState(false)
  // 这颗钮就是菜单的 Trigger(再点一次就关)。手机上开着的是底部 Sheet,不画菜单。
  const trigger = actions.canCompose
    ? <IconButton aria-label={t('export')} disabled={actions.busy}><ChevronDown /></IconButton>
    : <Button variant="primary" disabled={actions.busy}>{t('done')}<ChevronDown /></Button>
  return <DropdownMenu.Root open={open && !mobile} onOpenChange={setOpen} modal={false}>
    <div className="ia-completion-actions">
      {actions.canCompose ? <Button variant="primary" disabled={actions.busy} onClick={() => void actions.putInComposer()}>{t('done')}</Button> : null}
      <DropdownMenu.Trigger render={trigger} />
    </div>
    {open && mobile ? <Sheet onClose={() => setOpen(false)} mobileFitContent ariaLabel={t('export')} zIndex="var(--z-overlay)">
      <div className="ia-completion-sheet">
        <Button disabled={actions.busy} onClick={() => void actions.copy()} aria-label={actions.copied ? t('copied') : undefined}>{actions.copied ? <Check size={16} /> : t('copy')}</Button>
        <output aria-live="polite" className="sr-only">{actions.copied ? t('copied') : ''}</output>
        <Button disabled={actions.busy} onClick={() => void actions.save()}>{t('save')}</Button>
        {actions.canCompose ? <Button disabled={actions.busy} onClick={() => void actions.saveToFolder()}>{t('saveFolder')}</Button> : null}
      </div>
    </Sheet> : null}
    {mobile ? null : <DropdownMenu.Content zIndex="var(--z-overlay)" className="min-w-[160px]">
      <MenuItem onClick={() => void actions.copy()}>{t('copy')}</MenuItem>
      <MenuItem onClick={() => void actions.save()}>{t('save')}</MenuItem>
      {actions.canCompose ? <MenuItem onClick={() => void actions.saveToFolder()}>{t('saveFolder')}</MenuItem> : null}
    </DropdownMenu.Content>}
  </DropdownMenu.Root>
}
