import { annotationConversationKey, type AnnotationConversation } from '@shared/browser-annotation';
import type { BrowserKernelKind } from '@shared/browser-kernel';

export type BrowserKernelBinding = { browserId: string; partition: string; sessionId?: string; conversation?: AnnotationConversation; kernel: BrowserKernelKind };

function conversationOf(input: { sessionId?: string; conversation?: AnnotationConversation }): AnnotationConversation | undefined {
  return input.conversation ?? (input.sessionId ? { kind: 'session', sessionId: input.sessionId } : undefined);
}
const ownerKey = (input: { sessionId?: string; conversation?: AnnotationConversation }) => {
  const conversation = conversationOf(input);
  return conversation ? annotationConversationKey(conversation) : undefined;
};

/** A tab snapshots its engine once. Preferences never migrate a live page or its cookies. */
export class BrowserKernelBindings {
  private readonly tabs = new Map<string, BrowserKernelBinding>();
  private readonly pending = new Map<string, Promise<unknown>>();
  /** Closing waits for registration, including a tab closed before its installation read has returned. */
  run<T>(browserId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(browserId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(browserId, next);
    void next.finally(() => { if (this.pending.get(browserId) === next) this.pending.delete(browserId); }).catch(() => {});
    return next;
  }
  get(browserId: string) { return this.tabs.get(browserId); }
  assertOwner(input: { browserId: string; sessionId?: string; conversation?: AnnotationConversation }): void {
    const existing = this.tabs.get(input.browserId);
    if (existing && ownerKey(existing) !== ownerKey(input)) throw new Error('This browser tab belongs to another conversation');
  }
  belongsTo(browserId: string, conversation: AnnotationConversation): boolean {
    const existing = this.tabs.get(browserId);
    return !!existing && ownerKey(existing) === annotationConversationKey(conversation);
  }
  forSession(sessionId: string) { return [...this.tabs.values()].filter(tab => tab.sessionId === sessionId); }
  delete(browserId: string) { this.tabs.delete(browserId); }
  bind(input: Omit<BrowserKernelBinding, 'kernel'>, kernel: BrowserKernelKind): BrowserKernelBinding {
    const existing = this.tabs.get(input.browserId);
    this.assertOwner(input);
    const owner = conversationOf(input);
    const conversation = owner ? Object.freeze({ ...owner }) : undefined;
    const sessionId = conversation?.kind === 'session' ? conversation.sessionId : undefined;
    const binding = Object.freeze({ ...input, conversation, sessionId, kernel: existing?.kernel ?? kernel });
    this.tabs.set(input.browserId, binding);
    return binding;
  }
}
