import type { CSSProperties } from 'react'

/** @@@page-modal-close — geometry shared by the page modals (ModalClose and the headers lined up with it). */
/** Settings' header geometry: the ✕'s top, the row's centre line, and where the page under the header starts. */
export const MODAL_CLOSE_TOP = 'var(--spacing-2xl)'
export const MODAL_ROW_CENTER = 'calc(var(--spacing-2xl) + var(--control-h-lg) / 2)'
export const MODAL_HEADER_H = 'calc(var(--spacing-2xl) + var(--control-h-lg) + var(--spacing-md))'
/** Settings' page title (settings.css: --font-heading, semibold), for a page modal whose title is its own. */
export const MODAL_TITLE: CSSProperties = { fontSize: 'var(--font-heading)', lineHeight: 'var(--lh-heading)', fontWeight: 'var(--font-weight-semibold)' }
