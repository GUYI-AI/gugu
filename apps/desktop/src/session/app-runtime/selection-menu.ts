import { fileRefOf, type AppFileRef } from '@shared/extensions/app-runtime-protocol';
import { selectionFileKey, type SelectionMenuItem } from '@shared/extensions/file-selection';
import { drawSelectionMenu, placeSelectionMenu } from '@shared/extensions/selection-menu-dom';
import { guguError, type GuguHost } from './host';

/**
 * `gugu.files.showSelection` (API 60, file-selection.ts): the host's selection menu, drawn in this page from the table its
 * file came with (`files.open`), so it is where the selection is in the same frame — nothing asked of the host until a
 * press. Not while the pointer is still selecting; not while the selection is out of view. Copy is the host's clipboard;
 * Comment (wire `send`) hands the selection to the host in the person's gesture (`filesSelectionAction`).
 */
export function selectionMenuApi(host: GuguHost) {
  const menus = new Map<string, SelectionMenuItem[]>();
  type Shown = { file: AppFileRef; version?: number; places: unknown; text?: string; code?: boolean; rect: { x: number; y: number; width: number; height: number } };
  let shown: Shown | null = null;
  let menu: HTMLElement | null = null;
  let pressing = false;

  const draw = () => {
    menu?.remove();
    menu = null;
    if (!shown || pressing) return;
    const items = menus.get(selectionFileKey(shown.file));
    if (!items?.length) return;
    const current = shown;
    menu = drawSelectionMenu(document, items, Boolean(current.text), (action) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (action === 'copy') void host.clipboard?.writeText(current.text ?? '');
      else void host.appFiles.selectionAction?.({ action, file: { ...current.file, ...(current.version ? { version: current.version } : {}) }, places: current.places, ...(current.text ? { text: current.text } : {}), ...(current.code ? { code: true } : {}), rect: current.rect, viewport });
      shown = null;
      draw();
    });
    document.body.append(menu);
    placeSelectionMenu(menu, current.rect, { width: window.innerWidth, height: window.innerHeight });
  };

  // Listened for from the first selection shown: a program or a worker has no document and never shows one.
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (menu && event.composedPath().includes(menu))) return;
      pressing = true;
      draw();
    }, true);
    for (const ended of ['pointerup', 'pointercancel']) {
      document.addEventListener(ended, () => {
        if (!pressing) return;
        pressing = false;
        draw();
      }, true);
    }
  };

  return {
    /** The table an opened file came with, kept for its selections on this page. */
    remember(entry: unknown, items: SelectionMenuItem[] | undefined) {
      if (items) menus.set(selectionFileKey(fileRefOf(entry)), items);
    },
    show(selection: unknown) {
      listen();
      if (selection === null || selection === undefined) { shown = null; draw(); return; }
      const { file, places, text, code, rect } = selection as Partial<Shown>;
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw guguError('invalid', 'files.showSelection takes null or { file, places, text?, code?, rect } (CSS px)');
      // The version the page draws (an entry's `version`): what is picked is picked on it, and its pills point there.
      const version = (file as { version?: unknown } | null)?.version;
      const next = { file: fileRefOf(file), ...(typeof version === 'number' ? { version } : {}), places, ...(typeof text === 'string' && text ? { text } : {}), ...(code === true ? { code } : {}), rect };
      // Moved, not drawn again: the same pick in the same file only takes its new place.
      const moved = menu && shown && JSON.stringify([shown.file, shown.places, shown.text]) === JSON.stringify([next.file, next.places, next.text]);
      shown = next;
      if (moved) placeSelectionMenu(menu!, rect, { width: window.innerWidth, height: window.innerHeight });
      else draw();
    },
  };
}
