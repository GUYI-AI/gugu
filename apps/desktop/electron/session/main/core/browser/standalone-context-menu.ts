import { BrowserWindow, clipboard, webContents } from 'electron';
import { showContentContextMenu } from '../../../../content-context-menu';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { browserOpenInNewTabChannel } from '@shared/events/browserEvents';
import { textContextMenuItems, type TextEditAction } from '@shared/text-context-menu';
import type { TaskPageContents, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import { browserContextMenuItems, type BrowserMenuContext } from './browser-context-menu';

export type StandaloneMenuPoint = { x: number; y: number; windowX: number; windowY: number };

type CapturedContext = BrowserMenuContext & {
  editable: boolean;
  enabled: { undo: boolean; redo: boolean; cut: boolean; copy: boolean; paste: boolean; selectAll: boolean };
};

function snapshotContext(x: number, y: number) {
  let doc = document;
  let px = x * innerWidth;
  let py = y * innerHeight;
  let hit = doc.elementFromPoint(px, py);
  for (let depth = 0; hit?.localName === 'iframe' && depth < 8; depth++) {
    const frame = hit as HTMLIFrameElement;
    const nested = frame.contentDocument;
    if (!nested) break;
    const rect = frame.getBoundingClientRect();
    px -= rect.left + frame.clientLeft;
    py -= rect.top + frame.clientTop;
    doc = nested;
    hit = doc.elementFromPoint(px, py);
  }
  for (let depth = 0; hit?.shadowRoot && depth < 8; depth++) {
    const nested = hit.shadowRoot.elementFromPoint(px, py);
    if (!nested || nested === hit) break;
    hit = nested;
  }

  const field = hit?.closest('input,textarea') as HTMLInputElement | HTMLTextAreaElement | null;
  const password = field?.localName === 'input' && (field as HTMLInputElement).type === 'password';
  const textField = field && (typeof field.selectionStart === 'number' || password) ? field : null;
  let editable = hit as HTMLElement | null;
  while (editable?.parentElement?.isContentEditable) editable = editable.parentElement;
  const editor = textField && !textField.disabled && !textField.readOnly ? textField
    : editable?.isContentEditable ? editable : null;
  const start = textField?.selectionStart;
  const end = textField?.selectionEnd;
  const direction = textField?.selectionDirection;
  const selection = doc.getSelection();
  const range = !textField && editor && selection?.rangeCount
    && editor.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0).cloneRange() : null;
  const selectionText = (password ? '' : textField
    ? typeof start === 'number' && typeof end === 'number' ? textField.value.slice(start, end) : ''
    : editor ? range?.toString() ?? '' : selection?.toString() ?? '').slice(0, 64 * 1024);
  const link = hit?.closest('a[href],area[href]') as HTMLAnchorElement | null;
  const image = hit?.closest('img') as HTMLImageElement | null;
  const info: CapturedContext = {
    selectionText, linkURL: (link?.href ?? '').slice(0, 8192),
    srcURL: (image?.currentSrc || image?.src || '').slice(0, 8192), mediaType: image ? 'image' : '',
    editable: !!editor,
    enabled: { undo: doc.queryCommandEnabled('undo'), redo: doc.queryCommandEnabled('redo'),
      cut: !!selectionText, copy: !!selectionText, paste: !!editor, selectAll: !!editor },
  };
  return {
    info,
    edit(action: 'undo' | 'redo' | 'delete' | 'selectAll' | 'insertText', text?: string) {
      if (!editor?.isConnected || editor.ownerDocument !== doc) return false;
      editor.focus({ preventScroll: true });
      if (textField && typeof start === 'number' && typeof end === 'number') {
        textField.setSelectionRange(start, end, direction ?? undefined);
      } else if (range) {
        const current = doc.getSelection();
        current?.removeAllRanges();
        current?.addRange(range);
      }
      return doc.execCommand(action, false, text);
    },
  };
}

type RemoteResult<T> = { result?: { value?: T; objectId?: string }; exceptionDetails?: unknown };

export async function showStandaloneBrowserContextMenu(
  sender: number,
  point: StandaloneMenuPoint,
  page: TaskPageContents,
  screen: TaskPageScreenTarget,
  browserId: string,
  current: () => boolean,
): Promise<boolean> {
  if (!point || ![point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || ![point.windowX, point.windowY].every(value => Number.isFinite(value) && value >= 0 && value <= 16384)
    || !page.hostCommand || !current()) return false;
  const source = webContents.fromId(sender);
  const window = source && BrowserWindow.fromWebContents(source);
  if (!window || window.isDestroyed() || window.webContents !== source) return false;

  const address = screen.state().url;
  const send = page.hostCommand.bind(page);
  const before = await send('Page.getFrameTree', {}) as { frameTree: { frame: { id: string; loaderId: string } } };
  const frame = before.frameTree.frame;
  if (!frame.loaderId) return false;
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'gugu:browser-context-menu' }) as { executionContextId: number };
  const captured = await send('Runtime.evaluate', {
    expression: `(${snapshotContext.toString()})(${point.x},${point.y})`,
    contextId: executionContextId,
  }) as RemoteResult<never>;
  const objectId = captured.result?.objectId;
  if (captured.exceptionDetails || !objectId) return false;

  const call = async <T>(functionDeclaration: string, values: unknown[] = []) => {
    const reply = await send('Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true,
      arguments: values.map(value => ({ value })) }) as RemoteResult<T>;
    if (reply.exceptionDetails) throw new Error('The browser menu source changed');
    return reply.result?.value;
  };
  const close = () => { void send('Runtime.releaseObject', { objectId }).catch(() => undefined); };
  const stillCurrent = () => current() && !window.isDestroyed() && screen.state().url === address;
  const onCurrentPage = async (run: () => unknown) => {
    if (!stillCurrent()) return;
    const tree = await send('Page.getFrameTree', {}) as typeof before;
    if (stillCurrent() && tree.frameTree.frame.loaderId === frame.loaderId) await run();
  };

  let opened = false;
  try {
    const info = await call<CapturedContext>('function () { return this.info; }');
    if (!info || !stillCurrent()) return false;
    const tree = await send('Page.getFrameTree', {}) as typeof before;
    if (!stillCurrent() || tree.frameTree.frame.loaderId !== frame.loaderId) return false;
    const edits: TextEditAction[] = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'];
    const run = (action: TextEditAction) => onCurrentPage(async () => {
      const edit = (command: string, text?: string) => call<boolean>(
        'function (command, text) { return this.edit(command, text); }', [command, text ?? null]);
      if (action === 'copy') {
        if (info.selectionText) await clipboard.writeText(info.selectionText);
      } else if (action === 'cut') {
        if (info.selectionText && await edit('delete')) await clipboard.writeText(info.selectionText);
      } else if (action === 'paste') {
        const text = await clipboard.readText();
        if (text && stillCurrent()) await edit('insertText', text);
      } else {
        await edit(action);
      }
    });
    const actions = Object.fromEntries(edits.map(action => [action, () => run(action)]));
    const items = info.editable
      ? textContextMenuItems({ selectionText: info.selectionText, enabled: info.enabled, actions })
      : browserContextMenuItems(info, {
        open: (url) => onCurrentPage(() => screen.control({ action: 'navigate', url })),
        openTab: (url) => onCurrentPage(() => events.emit(browserOpenInNewTabChannel, { sourceBrowserId: browserId, url })),
        reload: () => onCurrentPage(() => screen.control({ action: 'reload' })),
      });
    showContentContextMenu(items, { window, x: point.windowX, y: point.windowY }, close);
    opened = true;
    return true;
  } catch {
    log.warn('Could not show the standalone browser context menu');
    return false;
  } finally {
    if (!opened) close();
  }
}
