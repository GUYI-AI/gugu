import { useLayoutEffect, type MutableRefObject, type ReactNode } from 'react';
import { InlineImageChip, type PromptEditorRef } from '@gugu/session-ui/react/components';
import { fileImageLinks } from '@gugu/session-core/acp/inline-file-images';
import { renderMentionTokens } from '@renderer/lib/chat/render-mention-tokens';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { useAttachmentObjectUrl } from '@/lib/attachmentBytes';

import { sessionPromptBody } from './session-message-quote';

export function useSessionPromptEditor<Edit extends { text: string }>(store: {
  sessionId: string; draftText: string; chatState: { uri?: string | null }; queuedPromptEdit: Edit | null;
  setDraftText(text: string): void; changeQueuedPromptEdit(text: string): void; finishQueuedPromptEdit(text: string | null): unknown;
}, editor: MutableRefObject<PromptEditorRef | null>) {
  useLayoutEffect(() => {
    const text = sessionPromptBody(store.draftText);
    if (text === store.draftText) return;
    store.setDraftText(text);
    editor.current?.setText(text);
  }, [store, store.draftText, editor]);
  const editing = store.queuedPromptEdit;
  return {
    queuedPromptEdit: editing ? { ...editing, text: sessionPromptBody(editing.text) } : null,
    changeQueuedPromptEdit: (text: string) => store.changeQueuedPromptEdit(text),
    finishQueuedPromptEdit: (text: string | null) => { void store.finishQueuedPromptEdit(text); },
    renderQueuedPromptText: (text: string) => queuedPromptView(sessionPromptBody(text), store.chatState.uri ?? store.sessionId),
  };
}

/**
 * A queued prompt as the composer showed it: mentions by name (`renderMentionTokens`), and each picture placed in the
 * words as its chip with the picture, not its `gugu-file` link. Display only; editing it still edits the words as they will be sent.
 */
export function queuedPromptView(text: string, uri: string): ReactNode {
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const link of fileImageLinks(text)) {
    nodes.push(renderMentionTokens(text.slice(at, link.index), uri), <QueuedImageChip key={link.index} href={link.href} title={link.label} />);
    at = link.index + link.length;
  }
  return nodes.length ? [...nodes, renderMentionTokens(text.slice(at), uri)] : renderMentionTokens(text, uri);
}

/** The picture is read the way a sent picture is: this device's copy of what it just sent, else the folder's thumbnail. */
function QueuedImageChip({ href, title }: { href: string; title: string }) {
  const file = parseGroupFileLink(href);
  const view = useAttachmentObjectUrl({ kind: 'item', itemId: file?.itemId ?? '', version: file?.version ?? 0 }, 'thumb', file?.version !== undefined);
  return <InlineImageChip src={view.status === 'ready' ? view.objectUrl : null} title={title} />;
}
