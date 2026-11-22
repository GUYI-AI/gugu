/**
 * @@@guest-press - a press inside an embedded guest page (an App's or a file's `<webview>`, an `<iframe>`) lands in the
 * guest's own document. The host document gets no pointerdown, only its window's blur, with the guest's element now its
 * focused element. Everything in the host that closes on "a press outside" listens for pointerdown on the document (Base UI's
 * menus, popovers and selects; the file selection menus), so a press in an App or a file page left them all open.
 * Replay the press on the guest's element, in the capture phase only (no bubbling): the document-wide "press outside"
 * listeners see a press there, while element handlers around the guest (meant for presses on the host's own content, such
 * as a viewer focusing itself) stay out of it — the guest already handled the real press.
 */
export function installGuestPress(win: Window): () => void {
  const blur = () => {
    const guest = win.document.activeElement
    if (guest?.localName !== 'webview' && guest?.localName !== 'iframe') return
    guest.dispatchEvent(new PointerEvent('pointerdown', { bubbles: false, composed: true, pointerType: 'mouse', isPrimary: true }))
  }
  win.addEventListener('blur', blur)
  return () => win.removeEventListener('blur', blur)
}

if (typeof window !== 'undefined') installGuestPress(window)
