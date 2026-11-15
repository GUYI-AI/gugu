import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ChevronRight, X } from '@/lib/icons'
import { useBackLayer } from '@/components/ui/sheetStack'
import { preserveComposerFocus } from './composer-focus'
import './phone-composer-controls.css'

export function PhoneComposerControlRow({ children }: { children: ReactNode }) {
  return <div className="gg-phone-composer-controls" data-phone-composer-controls="">{children}</div>
}

export function PhoneComposerControl({ label, icon, active, dot, disabled, onClick, testId, buttonRef }: {
  label: string; icon?: ReactNode; active?: boolean; dot?: boolean; disabled?: boolean
  onClick: () => void; testId: string; buttonRef?: RefObject<HTMLButtonElement | null>
}) {
  return <Button ref={buttonRef} variant="ghost" className="gg-phone-composer-control" disabled={disabled}
    data-testid={testId} data-active={active || undefined} onPointerDown={preserveComposerFocus}
    onMouseDown={preserveComposerFocus} onClick={onClick}>
    {icon}<span className="gg-phone-composer-control-label">{label}</span>
    {dot && <span className="gg-phone-composer-control-dot" />}<ChevronRight />
  </Button>
}

export function PhoneComposerSheet({ open, onClose, title, children, footer, testId, anchor }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; testId: string
  /** A short model/device menu grows above its row; long lists use the bottom sheet. */
  anchor?: RefObject<HTMLButtonElement | null>
}) {
  const { t } = useTranslation('mobileCreateControls')
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0, anchorTop: 0 })
  useBackLayer(onClose, open)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const v = window.visualViewport
      setViewport({ left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? innerWidth,
        height: v?.height ?? innerHeight, anchorTop: anchor?.current?.getBoundingClientRect().top ?? 0 })
    }
    measure()
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [open, anchor])
  const compact = !!anchor
  // When the keyboard leaves little room above the row, keep the whole menu in the visible viewport.
  const above = viewport.anchorTop - viewport.top - 20
  const anchored = compact && above >= 144
  const bottom = anchored ? viewport.anchorTop - 8 : viewport.top + viewport.height - 8
  const height = Math.max(0, anchored ? above : viewport.height - 24)
  return <Dialog.Root open={open} modal={false} disablePointerDismissal onOpenChange={(next) => { if (!next) onClose() }}>
    {open ? <Dialog.Portal>
      <div className="gg-phone-composer-shade" style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height }}
        onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClose} />
      <Dialog.Popup className="gg-phone-composer-sheet" data-testid={testId} data-compact={compact || undefined}
        initialFocus={false} finalFocus={false} aria-modal={false}
        onPointerDownCapture={(event) => { if ((event.target as Element).closest('button')) event.preventDefault() }}
        onMouseDownCapture={(event) => { if ((event.target as Element).closest('button')) event.preventDefault() }}
        style={{ left: viewport.left + 12, top: bottom, width: Math.max(0, Math.min(compact ? 320 : Infinity, viewport.width - 24)),
          maxHeight: Math.min(compact ? 440 : 500, height), transform: 'translateY(-100%)' }}>
        {!compact && <div className="gg-phone-composer-sheet-handle" aria-hidden="true" />}
        <div className="gg-phone-composer-sheet-head">
          <Dialog.Title>{title}</Dialog.Title>
          <IconButton size="lg" aria-label={t('close')} className="gg-phone-composer-sheet-close"
            onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClose}><X /></IconButton>
        </div>
        <div className="gg-phone-composer-sheet-list">{children}</div>
        {footer && <div className="gg-phone-composer-sheet-footer">{footer}</div>}
      </Dialog.Popup>
    </Dialog.Portal> : null}
  </Dialog.Root>
}
