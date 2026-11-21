import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/IconButton'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Check, X } from '@/lib/icons'
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives'
import { teamErrorCopy } from './copy'
import { retryOf, type Reading } from '@/lib/replica'

/**
 * A team reading not read yet (a spinner) or unreadable (why in team words, with the reading's own retry); a value is the
 * caller's to draw. Team pages draw this centered in the page, ❌ the one-line ReadingSlot failure of a settings row.
 */
export function TeamReadingState({ reading }: { reading: Reading<unknown> }) {
  const { t } = useTranslation('team')
  const retry = retryOf(reading)
  return <div className="gg-team-state" role={reading.state === 'error' ? 'alert' : 'status'}>
    {reading.state === 'unknown' ? <LoadingIndicator size="inline" ariaLabel={t('loading')} /> : <>
      <PaneEmptyState caption={teamErrorCopy(reading.state === 'error' ? reading.error : undefined, t)} />
      {retry ? <Button onClick={retry}>{t('retry')}</Button> : null}
    </>}
  </div>
}

export function TeamDialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  const { t } = useTranslation('team')
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal><Dialog.Backdrop className="gg-team-dialog-backdrop" /><Dialog.Viewport className="gg-team-dialog-viewport"><Dialog.Popup className="gg-team-dialog">
      <UiPortalContainerProvider zIndex="var(--z-settings-modal)">
      <div className="gg-team-dialog-heading"><Dialog.Title>{title}</Dialog.Title>
        <IconButton aria-label={t('close')} onClick={onClose}><X size={18} /></IconButton>
      </div>
      <div className="gg-team-dialog-body">{children}</div>
      {actions && <div className="gg-team-dialog-actions">{actions}</div>}
      </UiPortalContainerProvider>
    </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
  </Dialog.Root>
}

export function TeamCheckbox({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <Button variant="ghost" className="gg-team-checkbox" role="checkbox" aria-checked={checked} aria-label={label}
    disabled={disabled} onClick={() => onChange(!checked)}>
    <span data-checked={checked || undefined}>{checked && <Check size={12} />}</span>
  </Button>
}
