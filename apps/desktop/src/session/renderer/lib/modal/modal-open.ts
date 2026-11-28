import { deepActiveElement } from '@renderer/features/sidebar/session-navigation-focus';
import { modalStore } from './modal-store';

/**
 * A modal dialog open anywhere in the document owns the keyboard, wherever focus happens to be. `modalStore` only knows
 * the task page's own modals — the gugu shell's modals (the settings Sheet, the image preview, contacts) live outside
 * it and mark themselves with aria-modal (ui/Sheet, ImagePreviewProvider).
 */
export function hasOpenModalDialog(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/** A modal of the task page or of the shell is up: it owns the keyboard wherever the focus is. */
export function aModalIsOpen(): boolean {
  return modalStore.isOpen || hasOpenModalDialog();
}

/**
 * Close the modal that is up the way its own Escape does (each modal already listens for it), so ⌘W over a sheet
 * closes the sheet — not the tab or the window behind it.
 */
export function dismissOpenModal(): void {
  const target = deepActiveElement() ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true, cancelable: true }));
}
