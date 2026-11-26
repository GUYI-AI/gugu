import {
  FILE_VIEWER_ATTRIBUTE,
  FILE_VIEWER_MENU_EVENT,
  type FileViewerMenuRequest,
  type FileViewerEditAction,
  type FileViewerSelection,
} from '@/session/shared/preview/file-viewer-menu';
import type { ResourceContext } from '@/session/shared/resource-actions';
import { resourceMenuItems, runResourceAction } from '@/lib/resourceActions';

export interface FileViewerSnapshot {
  resource?: ResourceContext;
  /** A comment on the selection, in the viewer's conversation: the comment box at `at` (the selection's box, else the viewer's). */
  comment?: (selection: FileViewerSelection, at: DOMRect) => void;
  selection?: FileViewerSelection;
  selectAll?: () => void;
  canSelectAll?: boolean;
  edit?: (action: FileViewerEditAction) => void;
  editable?: boolean;
  enabled?: FileViewerMenuRequest['enabled'];
  editorHistory?: FileViewerMenuRequest['editorHistory'];
}

/** A single binding per viewer; callbacks and editor selections are captured before the menu takes focus. */
export function bindFileViewerMenu(
  element: HTMLElement,
  snapshot: () => FileViewerSnapshot,
  onError: (error: unknown) => void,
): () => void {
  const id = crypto.randomUUID();
  let pending: { requestId: string; snapshot: FileViewerSnapshot; at: DOMRect } | null = null;
  element.setAttribute(FILE_VIEWER_ATTRIBUTE, id);
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<FileViewerMenuRequest>).detail;
    if (detail.action === 'snapshot') {
      const current = snapshot();
      // Where the selection is, read before the menu takes focus: the comment box opens there.
      const picked = element.ownerDocument.getSelection();
      const at = picked?.rangeCount && element.contains(picked.getRangeAt(0).commonAncestorContainer) ? picked.getRangeAt(0).getBoundingClientRect() : element.getBoundingClientRect();
      pending = { requestId: detail.requestId, snapshot: current, at };
      detail.commentable = Boolean(current.comment);
      if (current.resource) detail.resourceActions = resourceMenuItems(current.resource).map(({ id, label }) => ({ id, label }));
      if (current.selection) detail.selection = current.selection;
      if (current.canSelectAll !== undefined) detail.canSelectAll = current.canSelectAll;
      detail.customSelectAll = Boolean(current.selectAll);
      detail.customEditing = Boolean(current.edit);
      if (current.editable !== undefined) detail.editable = current.editable;
      if (current.enabled) detail.enabled = { ...detail.enabled, ...current.enabled };
      if (current.editorHistory) {
        if (!current.edit) throw new Error('Editor history requires its editing commands');
        detail.editorHistory = current.editorHistory;
      }
      return;
    }
    if (!pending || pending.requestId !== detail.requestId) return;
    const { snapshot: captured, at } = pending;
    pending = null;
    if (detail.action === 'copy-resource-url' || detail.action === 'send-resource-url') {
      if (captured.resource) void runResourceAction(detail.action, captured.resource);
      return;
    }
    if (detail.action === 'select-all') {
      captured.selectAll?.();
      return;
    }
    if (detail.action === 'undo' || detail.action === 'redo' || detail.action === 'cut' || detail.action === 'paste') {
      captured.edit?.(detail.action);
      return;
    }
    if (detail.action === 'comment-selection') {
      try { captured.comment?.(detail.selection, at); } catch (error) { onError(error); }
    }
  };
  element.addEventListener(FILE_VIEWER_MENU_EVENT, receive);
  return () => {
    pending = null;
    element.removeEventListener(FILE_VIEWER_MENU_EVENT, receive);
    if (element.getAttribute(FILE_VIEWER_ATTRIBUTE) === id) element.removeAttribute(FILE_VIEWER_ATTRIBUTE);
  };
}
