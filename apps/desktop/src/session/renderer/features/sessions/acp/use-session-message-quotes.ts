import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import type { ChatCommands } from '@gugu/session-chat-ui';
import type { PromptEditorRef } from '@gugu/session-ui/react/components';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { showRendererContentMenu, showRendererMessageMenu } from '@/lib/contentContextMenu';
import { openSentFile } from '@renderer/lib/chat/sent-message-open';
import { rendererLogger } from '@/lib/log';
import { platform } from '@/platform';
import { notifyCopied } from '@/lib/copyFeedback';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AcpChatStore } from './acp-chat-store';
import { quotedIntoDraft, selectedMessageText, sessionPromptBody } from './session-message-quote';
import { sessionForwardPieces } from './session-message-forward';
import { openForward } from '@/components/chat/forwardToChats';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { bindMessageQuoteTouchMenu } from './message-quote-touch-menu';

type Target = Parameters<NonNullable<ChatCommands['onMessageTextMount']>>[0];
const log = rendererLogger('session/message-actions');

/** What a task page adds to the chat's message menu: the desktop edits and forks; the phone lifts the bubble as the chat's phone menu does. */
export type SessionMessageActions = {
  canEdit?: (itemId: string) => boolean;
  onEdit?: (itemId: string) => void;
  onForkTask?: () => void;
  phone?: boolean;
};


/** The chat's own message menu on the timeline's bubbles, and restoration of previously saved prompts. */
/** The turns a forwarded answer finds its prompt in. */
type TranscriptReader = { chatState: { transcript: { state: { committedTurns: readonly TranscriptTurn[]; activeTurnSnapshot?: TranscriptTurn | null } } } };

export function useSessionMessageQuotes(store: (Pick<AcpChatStore, 'sessionId' | 'setDraftText'> & TranscriptReader) | null | undefined, editor: MutableRefObject<PromptEditorRef | null>, actions: SessionMessageActions) {
  const { translate } = useSessionMessages();
  const latest = useRef({ store, translate, actions });
  latest.current = { store, translate, actions };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const restorePrompt = useCallback(({ text }: { text: string }) => {
    const current = latest.current.store;
    if (!current) return;
    const body = sessionPromptBody(text);
    current.setDraftText(body);
    editor.current?.setText(body);
    editor.current?.focus('end');
  }, [editor]);
  const onMessageTextMount = useCallback((target: Target) => {
    const copy = (text: string, adjusted?: () => string | undefined) => {
      const t = latest.current.translate;
      void platform.writeClipboardText(adjusted?.()?.trim() ? adjusted()! : text).then(() => notifyCopied(t('transcript.copied'))).catch(error => {
        log.error({ error }, 'Message copy failed');
        toast({ title: t('task.copyFailed'), tier: 'error' });
      });
    };
    // A right press selects the word under it (macOS) before the menu event: only what was selected before it counts.
    let pressed: { selection: string | null | undefined } | null = null;
    const press = (event: PointerEvent) => {
      if (event.button === 2) pressed = { selection: selectedMessageText(target.root, target.root.ownerDocument.getSelection()) };
    };
    const open = (event: MouseEvent) => {
      const current = latest.current.store;
      if (!current) return;
      const before = pressed;
      pressed = null;
      const selection = before ? before.selection : selectedMessageText(target.root, target.root.ownerDocument.getSelection());
      if (selection === null) return;
      const clicked = event.target instanceof Element ? event.target : null;
      const { actions: acts } = latest.current;
      if (selection === undefined && clicked?.closest('input,textarea,[contenteditable]')) return;
      const message = target.message();
      const text = selection ?? message.text;
      const sent = message.sentMessages;
      const carried = sent?.find(row => row.id === clicked?.closest<HTMLElement>('[data-sent-message-body]')?.dataset.sentMessageBody) ?? (sent?.length === 1 ? sent[0] : undefined);
      // The card has already said this file is gone: the menu does not offer to open it.
      const unavailable = !!clicked?.closest('[data-sent-message-body]')?.querySelector('[data-attachment-unavailable]');
      const file = carried?.content_type === 'attachment' ? parseAttachmentContent(carried.content, carried.session_file
        ? { ...carried, session_file: { ...carried.session_file, session_id: current.sessionId } } : carried) : null;
      if (!text.trim() && !file) return;
      // Whole-message copy keeps a snapshot; selected text can still be extended with handles.
      const selectionRange = selection !== undefined && Capacitor.getPlatform() === 'android'
        ? target.root.ownerDocument.getSelection()?.getRangeAt(0).cloneRange() : undefined;
      event.preventDefault();
      event.stopPropagation();
      // Android's selection handles stay with the system: the copy menu keeps the range they adjust.
      if (selectionRange) {
        void showRendererContentMenu([{ id: 'copy', label: latest.current.translate(selection === undefined ? 'transcript.copyMessage' : 'transcript.copySelection') }], { x: event.clientX, y: event.clientY }, selectionRange).then(action => {
          if (alive.current && latest.current.store === current && action === 'copy') copy(text, selectionRange ? () => target.root.ownerDocument.getSelection()?.toString() : undefined);
        }).catch(error => log.error({ error }, 'Message copy menu failed'));
        return;
      }
      if (before && selection === undefined) target.root.ownerDocument.getSelection()?.removeAllRanges();
      const usable = (act: () => void) => () => { if (alive.current && latest.current.store === current) act(); };
      const anchor = clicked?.closest<HTMLAnchorElement>('a[href]');
      const link = anchor?.getAttribute('href');
      const commands = target.commands?.();
      const transcript = current.chatState.transcript.state;
      const turns = transcript.activeTurnSnapshot ? [...transcript.committedTurns, transcript.activeTurnSnapshot] : transcript.committedTurns;
      const pieces = sessionForwardPieces({ itemId: target.itemId, message, text: message.text, sender: target.sender?.() ?? null, carried, turns });
      showRendererMessageMenu({
        x: event.clientX, y: event.clientY, isRetracted: false, content: text, hasSelection: selection !== undefined,
        ...(acts.phone ? { lift: { bubble: menuRoot, touchY: event.clientY, mine: message.role === 'user' } } : {}),
        onCopy: usable(() => copy(text)),
        onQuoteToComposer: usable(() => {
          const quoted = quotedIntoDraft(editor.current?.getText() ?? '', text);
          current.setDraftText(quoted);
          editor.current?.setText(quoted);
          editor.current?.focus('end');
        }),
        ...(link ? {
          onCopyLink: usable(() => copy(link)),
          // The link's own click: a reference, a group file, a working-folder file and a web link each open their own way.
          onOpenLink: usable(() => anchor?.click()),
        } : {}),
        ...(file && carried && !unavailable ? { onOpenFile: usable(() => openSentFile(file, carried, commands)) } : {}),
        ...(message.role === 'user' && !message.guguDelivery && acts.canEdit?.(target.itemId) ? { onEditMessage: usable(() => acts.onEdit?.(target.itemId)) } : {}),
        ...(acts.onForkTask ? { onForkTask: usable(acts.onForkTask) } : {}),
        ...(pieces ? { onForward: usable(() => openForward(pieces)) } : {}),
      });
    };
    const menuRoot = target.menuRoot ?? target.root;
    menuRoot.addEventListener('pointerdown', press, true);
    menuRoot.addEventListener('contextmenu', open);
    const unbindTouch = bindMessageQuoteTouchMenu(menuRoot, target.root, ({ x, y }) => {
      open(new MouseEvent('contextmenu', { clientX: x, clientY: y }));
    });
    return () => { menuRoot.removeEventListener('pointerdown', press, true); menuRoot.removeEventListener('contextmenu', open); unbindTouch(); };
  }, [editor]);
  return { onMessageTextMount, restorePrompt };
}
