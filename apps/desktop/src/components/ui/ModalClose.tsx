import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, X } from '@/lib/icons'
import { IconButton } from './IconButton'
import { MODAL_CLOSE_TOP } from './modalGeometry'

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

/** Settings' back from a page inside it (its header's leading button); a page modal's inner page goes back the same way. */
export function ModalBack({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <IconButton shape="pill" size="lg" className="bg-foreground/[0.06]" aria-label={label} onClick={onBack}>
      <ChevronLeft />
    </IconButton>
  )
}

// Above what the page floats in its corner (the contacts drawer, z-20).
const FLOATING: CSSProperties = { position: 'absolute', zIndex: 30, top: MODAL_CLOSE_TOP, right: 'var(--spacing-lg)' }
