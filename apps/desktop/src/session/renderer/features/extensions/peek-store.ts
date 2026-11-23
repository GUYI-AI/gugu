import { action, makeObservable, observable } from 'mobx';
import type { PeekTarget } from '@shared/extensions/app-runtime-protocol';
import { opensInImageViewer } from '@/lib/imageViewer';
import { openAttachmentImage } from '@/lib/attachmentBytes';
import { beginWorkspaceRead, previewReadsBytes, type BegunRead } from '@renderer/features/sessions/workspace-backend/read-workspace-bytes';

const key = (sessionId: string | null, tabId: string) => `${sessionId ?? ''}\u0000${tabId}`;

/**
 * G1 What is open beside an App's page (`files.openWith(file, { peek: true })`, `showSession(id, { peek: true })`), by the
 * slot that page is drawn in — a session's tab, the dock, a chat's panel (`sessionId` null), a phone's frame: the slot draws
 * it (`AppPeekSlot`), and the page is left as it is. One at a time: a new one takes the place of the last.
 */
class PeekStore {
  private readonly peeks = observable.map<string, PeekTarget>({}, { deep: false });
  /** A folder file's read, begun as it opens (`@@@first-read-early`): its preview's first read takes it. */
  private readonly begun = new WeakMap<PeekTarget, BegunRead>();

  constructor() {
    makeObservable(this, { open: action, close: action });
  }

  of(sessionId: string | null, tabId: string): PeekTarget | null {
    return this.peeks.get(key(sessionId, tabId)) ?? null;
  }

  open(sessionId: string | null, tabId: string, target: PeekTarget): void {
    if (target.kind === 'chat' && target.detail.choice.kind === 'none' && opensInImageViewer(target.detail.name, target.detail.file.contentType, undefined)) {
      const { detail } = target;
      openAttachmentImage({ kind: 'item', itemId: detail.itemId, version: detail.file.version }, detail.name, { chatId: detail.chatId });
      return;
    }
    if (target.kind === 'folder' && !target.ask && previewReadsBytes(target.path)) this.begun.set(target, beginWorkspaceRead(target.projectId, target.workspaceId, target.path));
    this.peeks.set(key(sessionId, tabId), target);
  }

  /** The read begun when `target` opened, once: a read again (the file changed) starts its own. */
  takeBegunRead(target: PeekTarget): BegunRead | undefined {
    const begun = this.begun.get(target);
    this.begun.delete(target);
    return begun;
  }

  close(sessionId: string | null, tabId: string): void {
    this.peeks.delete(key(sessionId, tabId));
  }
}

export const peekStore = new PeekStore();
