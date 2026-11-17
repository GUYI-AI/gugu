import { useCallback, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ChevronDown, ChevronLeft, ChevronUp, X } from '@/lib/icons'
import { useBackLayer } from '@/components/ui/sheetStack'
import { preserveComposerFocus, preservePanelComposerFocus } from './composer-focus'
import { PhoneViewportContext } from '../usePhoneViewport'
import '../agent-watch/create-controls-catalog'
import './phone-menu-bar-catalog'
import './phone-composer-controls.css'

export function PhoneComposerControlRow({ children, conversationKey }: { children: ReactNode; conversationKey?: string }) {
  return <ComposerControlRow key={conversationKey}>{children}</ComposerControlRow>
}

function ComposerControlRow({ children }: { children: ReactNode }) {
  const { t } = useTranslation('phoneComposerMenuBar')
  const itemsId = useId()
  const row = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null)
  const collapsed = manualCollapsed ?? hasDraft
  const keyboardVisible = useContext(PhoneViewportContext)?.keyboardVisible
  useLayoutEffect(() => {
    const scope = row.current?.closest('[data-slot="composer"], [data-chat-composer], [data-chat-composer-host], [data-chat-bottom-dock], .gg-aw-create-host')
    if (!scope) return
    const update = () => {
      const editor = scope.querySelector('[data-slot="composer-input"] [contenteditable], [data-slot="composer-input"] textarea')
      const text = editor instanceof HTMLTextAreaElement ? editor.value : editor?.textContent ?? ''
      const hasAttachments = !!scope.querySelector('[data-slot="composer-attachments"]')
      setHasDraft(!!text.trim() || hasAttachments)
      setEditing(keyboardVisible !== false && document.activeElement instanceof Element
        && scope.contains(document.activeElement)
        && !!document.activeElement.closest('[data-slot="composer-input"] [contenteditable], [data-slot="composer-input"] textarea'))
    }
    const afterBlur = () => queueMicrotask(update)
    update()
    scope.addEventListener('focusin', update)
    scope.addEventListener('focusout', afterBlur)
    scope.addEventListener('input', update)
    const observer = new MutationObserver(update)
    observer.observe(scope, { childList: true, characterData: true, subtree: true })
    return () => { observer.disconnect(); scope.removeEventListener('input', update); scope.removeEventListener('focusin', update); scope.removeEventListener('focusout', afterBlur) }
  }, [keyboardVisible])
  return <div ref={row} className="gg-phone-composer-controls" data-phone-composer-controls="" data-editing={editing || undefined}
    data-collapsed={collapsed || undefined} inert={editing || undefined} aria-hidden={editing || undefined}>
    <div id={itemsId} className="gg-phone-composer-controls-items" hidden={collapsed} inert={collapsed || undefined}>{children}</div>
    <IconButton size="sm" aria-label={t(collapsed ? 'expand' : 'collapse')} aria-expanded={!collapsed} aria-controls={itemsId}
      data-testid="phone-composer-menu-toggle" className="gg-phone-composer-menu-toggle"
      onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
      onClick={() => setManualCollapsed(!collapsed)}>
      {collapsed ? <ChevronUp /> : <ChevronDown />}
    </IconButton>
  </div>
}

export function PhoneComposerControl({ label, icon, active, dot, disabled, onClick, testId, buttonRef, menuExpanded }: {
  label: string; icon?: ReactNode; active?: boolean; dot?: boolean; disabled?: boolean
  onClick: () => void; testId: string; buttonRef?: RefObject<HTMLButtonElement | null>; menuExpanded?: boolean
}) {
  return <Button ref={buttonRef} variant="ghost" className="gg-phone-composer-control gap-1" disabled={disabled}
    aria-haspopup={menuExpanded === undefined ? undefined : 'dialog'} aria-expanded={menuExpanded}
    data-testid={testId} data-active={active || undefined} onClick={onClick}>
    {menuExpanded === undefined && icon}<span className="gg-phone-composer-control-label">{label}</span>
    {menuExpanded !== undefined && (menuExpanded
      ? <ChevronDown data-phone-menu-direction="down" aria-hidden />
      : <ChevronUp data-phone-menu-direction="up" aria-hidden />)}
    {dot && <span className="gg-phone-composer-control-dot" />}
  </Button>
}

export function PhoneComposerSheet({ open, onClose, onBack, title, children, footer, testId, anchor, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; testId: string
  /** Child navigation returns one level; the persistent top-right Close dismisses the whole panel. */
  onBack?: () => void
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
  useBackLayer(onBack ?? onClose, open)
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
  return <Dialog.Root open={open} modal={false} disablePointerDismissal onOpenChange={(next, details) => {
    if (next) return
    if (details.reason === 'escape-key' && onBack) { details.cancel(); onBack(); return }
    onClose()
  }}>
    {open ? <Dialog.Portal>
      <div ref={setShade} className="gg-phone-composer-shade"
        onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClose} />
      <Dialog.Popup ref={setPopup} className={['gg-phone-composer-sheet', className].filter(Boolean).join(' ')} data-testid={testId} data-compact={compact || undefined}
        initialFocus={true} finalFocus={false} aria-modal={false}
        onPointerDownCapture={preservePanelComposerFocus} onMouseDownCapture={preservePanelComposerFocus}>
        {!compact && <div className="gg-phone-composer-sheet-handle" aria-hidden="true" />}
        <div className="gg-phone-composer-sheet-head">
          {onBack && <IconButton size="lg" aria-label={t('back')} className="gg-phone-composer-sheet-back"
            data-testid={`${testId}-back`}
            onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onBack}><ChevronLeft /></IconButton>}
          <Dialog.Title>{title}</Dialog.Title>
          <IconButton size="lg" aria-label={t('close')} className="gg-phone-composer-sheet-close"
            data-testid={`${testId}-close`}
            onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClose}><X /></IconButton>
        </div>
        <div className="gg-phone-composer-sheet-list">{children}</div>
        {footer && <div className="gg-phone-composer-sheet-footer">{footer}</div>}
      </Dialog.Popup>
    </Dialog.Portal> : null}
  </Dialog.Root>
}
