import { useObserver } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { resolveConversationMessageReference, type ChatView, type TranscriptTurn } from '@gugu/session-chat-ui';
import { takeTaskReveal } from '@/hooks/useSourceMessageReveal';
import { revealSourceMessage, SOURCE_MESSAGE_FLASH_MS } from '@/lib/sourceMessageReveal';
import { UI_EVENTS } from '@/lib/uiEvents';
import { parseMessageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import { storedOutlineSeq } from '../view/session-timeline-outline';

type SourceStore = {
  sessionId: string;
  chatState: { transcript: { state: { committedTurns: readonly TranscriptTurn[]; activeTurnSnapshot?: TranscriptTurn | null } } };
  canLoadOlderHistory: boolean;
  loadOlderHistory(): Promise<TranscriptTurn[]>;
  /** Changes whenever the store starts its history over (reattach, revert): pages read before that belong to nothing. */
  historyEpoch?: number;
  /** A phone host applies fetched pages through its timeline props. */
  historyManagedByHost?: boolean;
  /**
   * @@@history-window — a store that can show a stretch of stored history in place of its live transcript. While a
   * window is open it is what the list shows (`shownChatState`) and pages (`historyWindow.loadOlder`).
   */
  shownChatState?: SourceStore['chatState'];
  historyWindow?: { loadOlder(): Promise<TranscriptTurn[]> } | null;
  /** The oldest stored turn the live transcript holds. */
  oldestLoadedSeq?: number;
  openHistoryWindow?(seq: number, anchor?: (turns: readonly TranscriptTurn[]) => string | null): Promise<boolean>;
  closeHistoryWindow?(opts?: { keepPosition?: boolean }): void;
};

/** How many turns a reveal reading back to a far message lets pile up before it prepends them. */
const REVEAL_BATCH_TURNS = 300;
/**
 * A message more than this many turns above the loaded history is shown in a history window instead of being paged to:
 * everything between would have to be loaded and laid out first, which is seconds of work at a few thousand turns.
 */
const FAR_REVEAL_TURNS = 300;

/** The chat reveal controller, with the session's history loader and virtual list. */
export function useSessionSourceMessage(store: SourceStore | null | undefined, view: MutableRefObject<ChatView | null>, onMissing: () => void) {
  const latest = useRef(store);
  latest.current = store;
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const request = useRef(0);
  const mounted = useRef(true);
  const loading = useRef<{ store: SourceStore; promise: Promise<TranscriptTurn[]> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    setFlashMessageId(null);
    return () => {
      mounted.current = false;
      request.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [store]);

  // Top-edge pagination and quote navigation share this request, so one page is prepended once.
  // `until` (a reveal reading back to a far message): keep reading pages until one of them satisfies it, prepending
  // them a batch at a time. Each prepend rebuilds the list, so thirty pages landed one by one are thirty rebuilds on
  // the way to a place the reader has not seen yet, while all of them landed at once is one rebuild that holds the
  // window for seconds. The list's own asks meanwhile join this request.
  const loadOlder = useCallback(async (until?: (turns: readonly TranscriptTurn[]) => boolean) => {
    const current = latest.current;
    if (!current) return [];
    if (loading.current?.store === current) return loading.current.promise;
    const currentView = view.current;
    const shownWindow = current.historyWindow;
    if (shownWindow) {
      // The list is showing a history window: its top edge pages the window, not the live transcript underneath.
      const paging = shownWindow.loadOlder().then(async turns => {
        if (loading.current?.promise === paging) loading.current = null;
        if (!turns.length || !mounted.current || latest.current !== current || current.historyWindow !== shownWindow || view.current !== currentView) return [];
        currentView?.loadOlder(turns);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        return turns;
      });
      loading.current = { store: current, promise: paging };
      try { return await paging; }
      finally { if (loading.current?.promise === paging) loading.current = null; }
    }
    const epoch = current.historyEpoch;
    // A store that started over while pages were being read has drawn its history anew, without them.
    const shown = () => mounted.current && latest.current === current && view.current === currentView && current.historyEpoch === epoch;
    const land = async (turns: TranscriptTurn[]) => {
      if (!shown() || !currentView || !turns.length) return;
      if (!current.historyManagedByHost) currentView.loadOlder(turns);
      // History is committed before the virtual list publishes its rows and height map.
      // Let that layout frame finish before resolving an anchor or starting its flash.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    // The pages are in hand, so this request is over: prepending them re-arms the list, and what the list asks for
    // next is the page above. Kept as "in flight" through the frame a prepend waits, that ask got this finished request back.
    const over = () => { if (loading.current?.promise === request) loading.current = null; };
    const request: Promise<TranscriptTurn[]> = (async () => {
      let held = await current.loadOlderHistory();
      if (until && !current.historyManagedByHost) {
        let found = until(held);
        while (!found && held.length && current.canLoadOlderHistory && shown()) {
          const older = await current.loadOlderHistory();
          if (!older.length) break;
          found = until(older);
          if (!found && held.length + older.length > REVEAL_BATCH_TURNS) {
            await land(held);
            held = older;
          } else held = [...older, ...held];
        }
        if (!shown()) held = [];
      }
      over();
      await land(held);
      return held;
    })();
    loading.current = { store: current, promise: request };
    try { return await request; }
    finally { over(); }
  }, [view]);

  const reveal = useCallback((reference: string) => {
    const current = latest.current;
    const currentView = view.current;
    if (!current || !currentView) return;
    const token = ++request.current;
    const source = parseMessageQuoteLink(reference);
    if (source?.kind === 'session' && source.sessionId !== current.sessionId) {
      missing.current();
      return;
    }
    const valid = () => request.current === token && latest.current === current && view.current === currentView;
    const within = (chat: SourceStore['chatState']) => {
      const state = chat.transcript.state;
      return resolveConversationMessageReference([...state.committedTurns, ...(state.activeTurnSnapshot ? [state.activeTurnSnapshot] : [])], reference, current.sessionId);
    };
    // What the list shows: a history window while one is open, the live transcript otherwise.
    const target = () => within(current.shownChatState ?? current.chatState);
    // One frame for the panel to hand the list its other state, one for the list to lay it out.
    const shownAgain = async () => { for (let frames = 0; frames < 2; frames += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
    const showLoaded = () => {
      const id = target();
      if (!id || !valid()) return false;
      currentView.scrollToItem(id, { align: 'center' });
      return true;
    };
    void revealSourceMessage(reference, {
      showLoaded,
      load: async () => {
        const holds = (turns: readonly TranscriptTurn[]) => resolveConversationMessageReference(turns, reference, current.sessionId) !== null;
        // Far above the loaded history: show the stretch around it, not everything on the way there.
        const seq = storedOutlineSeq(current.sessionId, source?.kind === 'session' ? source.itemId : reference);
        const oldest = current.oldestLoadedSeq;
        if (current.openHistoryWindow && seq !== undefined && oldest !== undefined && oldest - seq > FAR_REVEAL_TURNS
          && await current.openHistoryWindow(seq, turns => resolveConversationMessageReference(turns, reference, current.sessionId))) {
          if (!valid()) return;
          await shownAgain();
          if (showLoaded()) return;
        }
        // In the live transcript, or reached by paging it: a window that is open gives way first.
        if (current.historyWindow && valid()) {
          current.closeHistoryWindow?.({ keepPosition: within(current.chatState) !== null });
          await shownAgain();
          if (showLoaded()) return;
        }
        while (valid() && current.canLoadOlderHistory) {
          const turns = await loadOlder(holds);
          if (showLoaded()) return;
          if (!turns.length) break;
        }
        throw new Error('Original session message is unavailable');
      },
      current: valid,
      missing: () => missing.current(),
      flash: () => {
        setFlashMessageId(target());
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlashMessageId(null), SOURCE_MESSAGE_FLASH_MS);
      },
    });
  }, [loadOlder, view]);
  return { reveal, loadOlder, flashMessageId };
}

/**
 * A message found by the global search panel is revealed once this task's view and first history page are in, now or
 * when it opens. Taking the request any earlier spends it: nothing is loaded yet and there is no cursor to page back with.
 */
export function useSearchedTaskReveal(store: { sessionId: string; historyLoading: boolean } | null | undefined, view: ChatView | null, reveal: (reference: string) => void) {
  const sessionId = store?.sessionId;
  const ready = useObserver(() => !!view && store?.historyLoading === false);
  useEffect(() => {
    if (!ready || !sessionId) return;
    const take = () => {
      const reference = takeTaskReveal(sessionId);
      if (reference) reveal(reference);
    };
    take();
    window.addEventListener(UI_EVENTS.chatAsked, take);
    return () => window.removeEventListener(UI_EVENTS.chatAsked, take);
  }, [ready, sessionId, reveal]);
}
