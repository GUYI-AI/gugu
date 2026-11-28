/**
 * @@@link-menu — a right-clicked link is selected first, so the menu that opens is visibly about it. Unless the person
 * has selected something else: a selection that is not inside the link is theirs and stays. (macOS selects the word
 * under a right press before the menu event; that word is inside the link, so the whole link takes its place.)
 */
export function selectLinkForMenu(link: Element | null | undefined): boolean {
  const selection = link?.ownerDocument.getSelection()
  if (!link || !selection) return false
  if (selection.rangeCount && !selection.isCollapsed && !link.contains(selection.getRangeAt(0).commonAncestorContainer)) return false
  const range = link.ownerDocument.createRange()
  range.selectNodeContents(link)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}
