import { webContents } from 'electron';
import { isFrameSender } from '../../host-ws/frame-host';

/**
 * #2558 A new task's first turn is queued the moment the person sends it: from then on the pending row owns it, the
 * page draws it from there, and its queueing starts the agent. The files it names may still be on their way into the
 * agent's folder: the page that created the task places them (a desktop publishes its own copy; an SSH or other-machine
 * host gets the bytes pushed). Dispatching before they land would hand the agent a not-saved line for each, so the
 * row's dispatch waits for that placement, as part of preparing its files.
 *
 * The wait has one owner, the page that is placing them (the connection that created the task). It ends when that page
 * says placement settled (whatever landed), or when that page is gone — its window closed, crashed or reloaded, its
 * connection dropped: nobody is placing any more, so the turn goes with what landed. A host restart has no waits.
 *
 * ❌ Hold the turn outside the queue while the files travel (#2558: it then had no owner, a start that came first made
 * its late admission read as "already ran", and the first message was dropped with the page left blank).
 */
type Placement = { sender: number; done: Promise<void>; settle: () => void };
const placing = new Map<string, Placement>();
const watchedWindows = new Set<number>();

/** The creating page is placing `sessionId`'s first-turn files: its dispatch waits until it settles or goes away. */
export function holdFirstTurnForPlacement(sessionId: string, sender: number): void {
  if (placing.has(sessionId)) return;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => { settle = resolve; });
  placing.set(sessionId, { sender, done, settle });
  if (!isFrameSender(sender)) watchWindow(sender);
}

/** Placement of `sessionId`'s first-turn files settled (all placed or not): its dispatch goes on. */
export function firstTurnFilesPlaced(sessionId: string): void {
  const placement = placing.get(sessionId);
  if (!placement) return;
  placing.delete(sessionId);
  placement.settle();
}

/** A page that was placing files is gone: every first turn it was placing for goes on with what landed. */
export function releasePlacementsOf(sender: number): void {
  for (const [sessionId, placement] of [...placing]) if (placement.sender === sender) firstTurnFilesPlaced(sessionId);
}

/**
 * While a page is placing `sessionId`'s first-turn files: resolves once it is not any more, or `signal` aborts (a stop).
 * Null when nothing is placing them: the dispatch goes on in the same tick.
 */
export function firstTurnPlacement(sessionId: string, signal: AbortSignal): Promise<void> | null {
  const placement = placing.get(sessionId);
  if (!placement || signal.aborted) return null;
  return new Promise<void>((resolve) => {
    const stop = () => resolve();
    signal.addEventListener('abort', stop, { once: true });
    void placement.done.then(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    });
  });
}

/**
 * A window of this app reports no connection close (only network lines do, through `onConnectionClosed`): its page
 * is gone when the window is destroyed, its renderer dies, or its main frame loads another document (a reload).
 */
function watchWindow(sender: number): void {
  if (watchedWindows.has(sender)) return;
  const contents = webContents.fromId(sender);
  if (!contents || contents.isDestroyed()) {
    releasePlacementsOf(sender);
    return;
  }
  watchedWindows.add(sender);
  const gone = () => {
    watchedWindows.delete(sender);
    contents.removeListener('destroyed', gone);
    contents.removeListener('render-process-gone', gone);
    contents.removeListener('did-navigate', gone);
    releasePlacementsOf(sender);
  };
  contents.once('destroyed', gone);
  contents.once('render-process-gone', gone);
  contents.once('did-navigate', gone);
}
