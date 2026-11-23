import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { IconButton } from './IconButton'

/**
 * @@@page-modal-close — the ✕ of a page shown as a modal (设置、联系人、App 市场、一个 App 的页): one button, one place.
 * Settings draws it in its own header's actions (settings-content.css: header padded --spacing-2xl on top); a page whose
 * header is its own (联系人、App 市场、App 的页) floats it at that same spot and lines its header row up with it.
 */
export function ModalClose({ onClose, label, floating = false }: { onClose: () => void; /** Default: the generic 关闭对话框. */ label?: string; floating?: boolean }) {
  const { t } = useTranslation()
  return (
    <IconButton shape="pill" size="lg" className="bg-foreground/[0.06]" aria-label={label ?? t('dialog.close')} onClick={onClose}
      data-testid="page-modal-close" style={floating ? FLOATING : undefined}>
      <X />
    </IconButton>
  )
}

/** Settings' header geometry: the ✕'s top, the row's centre line, and where the page under the header starts. */
export const MODAL_CLOSE_TOP = 'var(--spacing-2xl)'
export const MODAL_ROW_CENTER = 'calc(var(--spacing-2xl) + var(--control-h-lg) / 2)'
export const MODAL_HEADER_H = 'calc(var(--spacing-2xl) + var(--control-h-lg) + var(--spacing-md))'
/** Settings' page title (settings.css: --font-heading, semibold), for a page modal whose title is its own. */
export const MODAL_TITLE: CSSProperties = { fontSize: 'var(--font-heading)', lineHeight: 'var(--lh-heading)', fontWeight: 'var(--font-weight-semibold)' }

// Above what the page floats in its corner (the contacts drawer, z-20).
const FLOATING: CSSProperties = { position: 'absolute', zIndex: 30, top: MODAL_CLOSE_TOP, right: 'var(--spacing-lg)' }
