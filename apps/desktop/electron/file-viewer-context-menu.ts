import { randomUUID } from 'node:crypto';
import { BrowserWindow, clipboard, shell, type App, type ContextMenuParams, type WebContents } from 'electron';
import { showContentContextMenu } from './content-context-menu';
import { isWebLink, linkMenuEntries } from '../src/session/shared/link-menu';
import { hostCopy } from './host-locale-store';
import { captureEditableContext, editingEnabled, showEditableContextMenu } from './editable-context-menu';
import { FILE_VIEWER_ATTRIBUTE, FILE_VIEWER_MENU_EVENT, type FileViewerMenuAction, type FileViewerMenuRequest, type FileViewerMenuLabels, fileViewerMenuItems } from '../src/session/shared/preview/file-viewer-menu';

type Context = FileViewerMenuRequest & { viewerId: string };

/** Native points use window coordinates; a webview's DOM hit test uses its local coordinates. */
export function viewerContextScript(params: Pick<ContextMenuParams, 'x' | 'y' | 'isEditable'> & Partial<Pick<ContextMenuParams, 'editFlags'>>, requestId: string, selection: FileViewerMenuRequest['selection'], offset = { x: 0, y: 0 }): string {
  return `(() => {
    const root=document.elementFromPoint(${params.x - offset.x},${params.y - offset.y})?.closest('[${FILE_VIEWER_ATTRIBUTE}]');
    if (!root) return null;
    const detail=${JSON.stringify({ action: 'snapshot', requestId, selection, canSelectAll: true, editable: params.isEditable, ...(params.isEditable && params.editFlags ? { enabled: editingEnabled(params.editFlags) } : {}) })};
    root.dispatchEvent(new CustomEvent(${JSON.stringify(FILE_VIEWER_MENU_EVENT)},{detail}));
    return {...detail,viewerId:root.getAttribute('${FILE_VIEWER_ATTRIBUTE}')};
  })()`;
}

export function viewerActionScript(context: Context, action: FileViewerMenuAction): string {
  return `(() => {
    const root=[...document.querySelectorAll('[${FILE_VIEWER_ATTRIBUTE}]')].find(e=>e.getAttribute('${FILE_VIEWER_ATTRIBUTE}')===${JSON.stringify(context.viewerId)});
    if (!root) return false;
    root.dispatchEvent(new CustomEvent(${JSON.stringify(FILE_VIEWER_MENU_EVENT)},{detail:${JSON.stringify({ ...context, action })}}));
    return true;
  })()`;
}

/** The link under the pointer in one of the app's own pages: select it (so the menu is visibly about it), or click it. */
export function viewerLinkScript(params: Pick<ContextMenuParams, 'x' | 'y'>, offset: { x: number; y: number }, act: 'select' | 'click'): string {
  return `(() => {
    const link=document.elementFromPoint(${params.x - offset.x},${params.y - offset.y})?.closest('a[href]');
    if (!link) return null;
    ${act === 'click' ? 'link.click();' : 'const range=document.createRange();range.selectNodeContents(link);const s=getSelection();s.removeAllRanges();s.addRange(range);'}
    return link.textContent;
  })()`;
}

export function registerFileViewerMenus(app: App, labels: () => FileViewerMenuLabels, report: (error: unknown) => void, acceptsHost: (host: WebContents) => boolean): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_menuEvent, params) => {
      if (!acceptsHost(contents.hostWebContents ?? contents)) return;
      void showFileViewerMenu(contents, params, labels(), report).catch(report);
    });
  });
}

async function showFileViewerMenu(contents: WebContents, params: ContextMenuParams, labels: FileViewerMenuLabels, report: (error: unknown) => void): Promise<void> {
  const frame = params.frame;
  if (!frame || contents.isDestroyed()) return;
  const host = contents.hostWebContents ?? contents;
  const window = BrowserWindow.fromWebContents(host);
  // Native browser child views have their own placement origin and use the same editable presenter there.
  if (!window || window.webContents !== host) return;
  const position = { window, x: params.x, y: params.y };
  const offset = contents.hostWebContents
    ? await contents.hostWebContents.mainFrame.executeJavaScript(`(() => { const view=[...document.querySelectorAll('webview')].find(view=>view.getWebContentsId()===${contents.id});return view?.getBoundingClientRect().toJSON(); })()`) as { x: number; y: number } | undefined
    : { x: 0, y: 0 };
  if (!offset) return;
  const link = isWebLink(params.linkURL) ? params.linkURL : null;
  const linkItems = link ? linkMenuEntries(hostCopy().sessionHost.linkMenu, (action) => {
    if (contents.isDestroyed()) return;
    if (action === 'copy-link') return clipboard.writeText(link);
    if (action === 'open-link-system') return shell.openExternal(link);
    // Gugu's browser: the link's own click, which opens it where that page opens its links.
    return contents.mainFrame.executeJavaScript(viewerLinkScript(params, offset, 'click')).then(() => undefined, report);
  }) : [];
  const context = await contents.mainFrame.executeJavaScript(viewerContextScript(params, randomUUID(), { text: params.selectionText }, offset)) as Context | null;
  // @@@link-menu: a right-clicked link in a file or an App page is selected first, so the menu reads as being about it.
  const selectLink = async () => {
    const text = link && !params.selectionText ? await contents.mainFrame.executeJavaScript(viewerLinkScript(params, offset, 'select')) as string | null : null;
    if (text && context) context.selection = { text };
  };
  if (!context) {
    if (params.isEditable) await showEditableContextMenu(contents, params, position, report, labels);
    else if (linkItems.length && contents.hostWebContents) { await selectLink(); showContentContextMenu(linkItems, position); }
    return;
  }
  await selectLink();
  const editing = params.isEditable ? await captureEditableContext(contents, frame, report) : null;
  const run = (action: FileViewerMenuAction | 'copy') => {
    if (contents.isDestroyed()) return;
    const perform = async () => {
      if (action === 'copy') { await clipboard.writeText(context.selection.text); return; }
      if (action === 'select-all' && !context.customSelectAll) {
        if (editing) { await editing.run('selectAll'); return; }
        const root = frame === contents.mainFrame
          ? `[...document.querySelectorAll('[${FILE_VIEWER_ATTRIBUTE}]')].find(e=>e.getAttribute('${FILE_VIEWER_ATTRIBUTE}')===${JSON.stringify(context.viewerId)})`
          : 'document.body';
        await frame.executeJavaScript(`(() => { const root=${root};if(!root)return;const range=document.createRange();range.selectNodeContents(root.querySelector('[data-file-selection]')||root);const s=getSelection();s.removeAllRanges();s.addRange(range); })()`, true);
        return;
      }
      if (!context.customEditing && !(context.editorHistory && (action === 'undo' || action === 'redo')) && (action === 'undo' || action === 'redo' || action === 'cut' || action === 'paste')) {
        if (!editing) throw new Error('The editable file target is unavailable');
        await editing.run(action);
        return;
      }
      await contents.mainFrame.executeJavaScript(viewerActionScript(context, action), true);
    };
    return perform().catch(report);
  };
  showContentContextMenu([...linkItems, ...(linkItems.length ? [{ type: 'separator' as const }] : []), ...fileViewerMenuItems(context, labels, run, editing?.editorHistory)], position, editing?.close);
}
