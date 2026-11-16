import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { X } from '@/lib/icons'
import { useBackLayer } from '@/components/ui/sheetStack'
import { preserveComposerFocus, preservePanelComposerFocus } from './composer-focus'
import { PhoneViewportContext } from '../usePhoneViewport'
import './phone-composer-controls.css'

export function PhoneComposerControlRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const keyboardVisible = useContext(PhoneViewportContext)?.keyboardVisible
  useLayoutEffect(() => {
    const scope = row.current?.closest('[data-slot="composer"], [data-chat-composer], [data-chat-composer-host], [data-chat-bottom-dock], .gg-aw-create-host')
    if (!scope) return
    const update = () => setEditing(keyboardVisible !== false && document.activeElement instanceof Element
      && scope.contains(document.activeElement)
      && !!document.activeElement.closest('[data-slot="composer-input"] [contenteditable], [data-slot="composer-input"] textarea'))
    const afterBlur = () => queueMicrotask(update)
    update()
    scope.addEventListener('focusin', update)
    scope.addEventListener('focusout', afterBlur)
    return () => { scope.removeEventListener('focusin', update); scope.removeEventListener('focusout', afterBlur) }
  }, [keyboardVisible])
  return <div ref={row} className="gg-phone-composer-controls" data-phone-composer-controls="" data-editing={editing || undefined} inert={editing || undefined} aria-hidden={editing || undefined}>{children}</div>
}

export function PhoneComposerControl({ label, icon, active, dot, disabled, onClick, testId, buttonRef }: {
  label: string; icon?: ReactNode; active?: boolean; dot?: boolean; disabled?: boolean
  onClick: () => void; testId: string; buttonRef?: RefObject<HTMLButtonElement | null>
}) {
  return <Button ref={buttonRef} variant="ghost" className="gg-phone-composer-control gap-1" disabled={disabled}
    data-testid={testId} data-active={active || undefined} onPointerDown={preserveComposerFocus}
    onMouseDown={preserveComposerFocus} onClick={onClick}>
    {icon}<span className="gg-phone-composer-control-label">{label}</span>
    {dot && <span className="gg-phone-composer-control-dot" />}
  </Button>
}

export function PhoneComposerSheet({ open, onClose, title, children, footer, testId, anchor, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; testId: string
  /** A short model/device menu grows above its row; long lists use the bottom sheet. */
  anchor?: RefObject<HTMLButtonElement | null>; className?: string
}) {
  const { t } = useTranslation('mobileCreateControls')
  const shade = useRef<HTMLDivElement | null>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const compact = !!anchor
  const measure = useCallback(() => {
    const v = window.visualViewport
    const left = v?.offsetLeft ?? 0, top = v?.offsetTop ?? 0
    const width = v?.width ?? innerWidth, height = v?.height ?? innerHeight
    const anchorTop = anchor?.current?.getBoundingClientRect().top ?? 0
    const rowLeft = anchor?.current?.closest('[data-phone-composer-controls]')?.getBoundingClientRect().left
    const inset = compact && rowLeft !== undefined ? Math.max(12, rowLeft - left) : 12
    // When the keyboard leaves little room above the row, use the visible viewport's bottom.
    const above = anchorTop - top - 20, anchored = compact && above >= 144
    const geometry = [
      [shade.current, { left, top, width, height }],
      [popup.current, { left: left + inset, top: anchored ? anchorTop - 8 : top + height - 8,
        width: Math.max(0, Math.min(compact ? 320 : Infinity, width - inset - 12)),
        'max-height': Math.min(compact ? 440 : 500, Math.max(0, anchored ? above : height - 24)) }],
    ] as const
    for (const [element, values] of geometry) {
      for (const [name, value] of Object.entries(values)) element?.style.setProperty(`--phone-control-${name}`, `${value}px`)
    }
  }, [anchor, compact])
  const setShade = useCallback((element: HTMLDivElement | null) => { shade.current = element; measure() }, [measure])
  const setPopup = useCallback((element: HTMLDivElement | null) => { popup.current = element; measure() }, [measure])
  useBackLayer(onClose, open)
  useLayoutEffect(() => {
    if (!open) return
    measure()
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])
  return <Dialog.Root open={open} modal={false} disablePointerDismissal onOpenChange={(next) => { if (!next) onClose() }}>
    {open ? <Dialog.Portal>
      <div ref={setShade} className="gg-phone-composer-shade"
        onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClose} />
      <Dialog.Popup ref={setPopup} className={['gg-phone-composer-sheet', className].filter(Boolean).join(' ')} data-testid={testId} data-compact={compact || undefined}
        initialFocus={false} finalFocus={false} aria-modal={false}
        onPointerDownCapture={preservePanelComposerFocus} onMouseDownCapture={preservePanelComposerFocus}>
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
