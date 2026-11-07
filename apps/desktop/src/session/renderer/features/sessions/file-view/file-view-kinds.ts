import { getFileKind } from '@renderer/lib/editor/fileKind';

/** Plain text and code open straight in the folder App's editor; everything else is read first, in the file preview. */
export function opensInEditor(path: string): boolean {
  const kind = getFileKind(path);
  return kind === 'text' || kind === 'markdown';
}

export const FOLDER_APP_FILE_TAB = 'workspace.file';

/** The tab a file opens in when no other App takes it. */
export function fileTabTarget(path: string, external?: boolean): { kind: string; args: Record<string, unknown> } {
  return opensInEditor(path)
    ? { kind: FOLDER_APP_FILE_TAB, args: { filePath: path } }
    : { kind: 'file-view', args: { path, ...(external ? { external: true } : {}) } };
}

/** The folder App's list, at one folder of the working copy, in the tab asked from (or the tab that shows the list already). */
export const FOLDER_APP_LIST_TAB = 'workspace.main';
type FolderTabLayout = { open(kind: string, args: Record<string, unknown>, config: { from: string | null; intent: 'navigate'; inPlace: true; viewState: Record<string, unknown> }): string | undefined };
export function openFolderInTab(layout: FolderTabLayout, from: string | null, folder: string): void {
  layout.open(FOLDER_APP_LIST_TAB, {}, { from, intent: 'navigate', inPlace: true, viewState: { root: 'workspace', folder } });
}
