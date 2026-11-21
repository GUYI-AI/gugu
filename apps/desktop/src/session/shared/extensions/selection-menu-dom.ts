import { drawnItems, type FileSelectionAction, type SelectionMenuItem } from './file-selection';

/**
 * The one selection menu's DOM (file-selection.ts), drawn in the document whose selection it is: an App's page (by the
 * runtime) and the host's text preview alike — one look, one order, one placement. Its colors are the App page's
 * palette (`--em-*`) where there is one, else the host's own tokens: the same rule reads right in both.
 */
const CSS = `
.gugu-selection-menu { position: fixed; z-index: 2147483000; display: flex; gap: 2px; padding: 4px; margin: 0;
  border: 1px solid var(--em-border, var(--border-subtle)); border-radius: var(--em-radius-control, var(--radius-control));
  background: var(--em-background, var(--bg-primary)); color: var(--em-foreground, var(--text-primary));
  box-shadow: var(--em-shadow-dialog, var(--shadow-popover)); font: inherit; font-size: 14px; line-height: 20px; }
.gugu-selection-menu[hidden] { display: none; }
.gugu-selection-menu > button { all: unset; box-sizing: border-box; height: 32px; padding: 0 10px; cursor: pointer; white-space: nowrap;
  border-radius: var(--em-radius-control, var(--radius-control)); }
.gugu-selection-menu > button:hover { background: var(--em-hover, var(--hover)); }
.gugu-selection-menu > button:focus-visible:not([data-pointer-focus]) { outline: 2px solid var(--em-focus-ring, var(--focus-ring)); outline-offset: -2px; }
`;

const STYLE_ID = 'gugu-selection-menu-style';

/** The menu's element, its buttons in the table's order (Copy only with words); a press keeps the selection where it is. */
export function drawSelectionMenu(doc: Document, items: readonly SelectionMenuItem[], words: boolean, run: (action: FileSelectionAction) => void): HTMLElement {
  if (!doc.getElementById(STYLE_ID)) doc.head.append(Object.assign(doc.createElement('style'), { id: STYLE_ID, textContent: CSS }));
  const menu = doc.createElement('div');
  menu.className = 'gugu-selection-menu';
  menu.setAttribute('role', 'toolbar');
  menu.dataset.occludesBrowserPage = '';
  for (const item of drawnItems(items, words)) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.dataset.fileSelectionAction = item.id;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => run(item.id));
    menu.append(button);
  }
  return menu;
}

/**
 * Under the selection's box, or over it when there is no room below; kept inside the viewport sideways; hidden while the
 * box is out of view. `rect` and `viewport` in the document's CSS px. Synchronous: called as the selection moves, the
 * menu is where it is in the same frame.
 */
export function placeSelectionMenu(menu: HTMLElement, rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }): void {
  const out = rect.y + rect.height < 0 || rect.y > viewport.height || rect.x + rect.width < 0 || rect.x > viewport.width;
  menu.hidden = out;
  if (out) return;
  const gap = 8, width = menu.offsetWidth, height = menu.offsetHeight;
  const below = rect.y + rect.height + gap;
  const top = below + height <= viewport.height - gap ? below : Math.max(gap, rect.y - gap - height);
  const left = Math.max(gap, Math.min(rect.x, viewport.width - width - gap));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}
