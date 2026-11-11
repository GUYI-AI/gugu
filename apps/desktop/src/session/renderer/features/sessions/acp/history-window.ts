import { createChatState, type ChatContext, type ChatState, type TranscriptTurn } from '@gugu/session-chat-ui';
import { turnHeld } from '@gugu/session-core/session-record/held-turn';

/**
 * @@@history-window — a stretch of a conversation's stored history, shown in place of the live transcript.
 *
 * The live transcript holds everything from its oldest loaded turn to the newest one. Reaching a turn thousands of
 * turns up through it means loading and laying out all of them: seconds of work, however it is batched. A window
 * holds only the pages around the turn the reader asked for. It pages both ways like any history, and the live
 * transcript stays as it is underneath, still receiving the conversation, to be shown again when the reader returns
 * to the newest turn.
 *
 * It reads the same stored pages the live transcript's older history does, so a turn looks the same in both.
 */
export type StoredPage = { turns: TranscriptTurn[]; nextCursor: number | null };
/** The stored turns before `before` (exclusive), newest first to fill a page: the conversation's own page read. */
export type ReadStoredPage = (before: number) => Promise<StoredPage | null>;

/** How many turns after the target the first page reaches for, so the target is not the last thing on screen. */
const TURNS_BELOW_TARGET = 8;
/**
 * A first page with fewer turns than this may not fill the viewport. A list that cannot be scrolled never reaches its
 * end, so nothing would ask for the turns below: they are read as the window opens. A fuller page waits for the reader
 * to reach its end, as every later page does (appending eighty turns is a frame of layout the landing does not need).
 */
const SHORT_FIRST_PAGE_TURNS = 30;
/** How far past the newest held turn one read for newer turns reaches. */
const NEWER_STEP_TURNS = 80;

export class HistoryWindow {
  readonly state: ChatState;
  private olderCursor: number | null = null;
  /** The read in flight each way. The two ways do not wait on each other: one extends the top, the other the bottom. */
  private readonly reading: { older: Promise<unknown> | null; newer: Promise<unknown> | null } = { older: null, newer: null };
  private closed = false;

  private constructor(context: ChatContext, uri: string, private readonly read: ReadStoredPage, private readonly newestStored: () => number) {
    this.state = createChatState(context, { uri });
  }

  /** A window around the turn stored at `seq`, or null when that turn cannot be read. */
  static async open(input: { context: ChatContext; uri: string; read: ReadStoredPage; seq: number; newestStored(): number }): Promise<HistoryWindow | null> {
    const window = new HistoryWindow(input.context, input.uri, input.read, input.newestStored);
    const holds = (page: StoredPage | null) => !!page?.turns.some(turn => turn.seq === input.seq);
    // A page is cut from its older end when it is over the size a read may carry: reaching for turns below the target
    // can push the target itself out. Then the page that ends at the target is read instead.
    let page = await input.read(input.seq + 1 + TURNS_BELOW_TARGET);
    if (!holds(page)) page = await input.read(input.seq + 1);
    if (!page || !holds(page)) { window.dispose(); return null; }
    window.olderCursor = page.nextCursor;
    window.state.transcript.history.seed(page.turns);
    // Over a device link one large turn is a page of its own: see SHORT_FIRST_PAGE_TURNS.
    if (page.turns.length < SHORT_FIRST_PAGE_TURNS) void window.loadNewer();
    return window;
  }

  get turns(): readonly TranscriptTurn[] { return this.state.transcript.history.get(); }
  get hasOlder(): boolean { return this.olderCursor !== null; }
  /** Whether stored turns newer than the window's remain: until then, the newest turn on screen is not the conversation's. */
  get hasNewer(): boolean { return (this.turns.at(-1)?.seq ?? -1) < this.newestStored(); }

  /** The page above the window, for the list to prepend (`view.loadOlder`, which also holds the reader's row). */
  loadOlder(): Promise<TranscriptTurn[]> {
    return this.once('older', async () => {
      if (this.olderCursor === null) return [];
      const page = await this.read(this.olderCursor);
      if (!page || this.closed) return [];
      this.olderCursor = page.nextCursor;
      return page.turns;
    }, []);
  }

  /**
   * The turns below the window, appended to it. Pages are read newest first, so a read that reaches past the window's
   * end may come back cut short of it; the pages between are read until they meet, and only then appended: the window
   * never shows a history with a hole in it.
   */
  loadNewer(): Promise<TranscriptTurn[]> {
    return this.once('newer', async () => {
      const newest = this.turns.at(-1)?.seq;
      if (newest === undefined || !this.hasNewer) return [];
      let cursor: number | null = Math.min(newest + 1 + NEWER_STEP_TURNS, this.newestStored() + 1);
      let found: TranscriptTurn[] = [];
      while (cursor !== null && cursor > newest + 1) {
        const page = await this.read(cursor);
        if (!page || this.closed) return [];
        found = [...page.turns.filter(turn => turn.seq > newest), ...found];
        if (!page.turns.length || page.turns[0]!.seq <= newest + 1) break;
        cursor = page.nextCursor;
      }
      // Appended to what the window holds now: the page above may have been prepended while these were read.
      if (found.length) this.state.transcript.history.append(found);
      return found;
    }, []);
  }

  /** Put turns read whole (by sequence) in the place of the ones a page sent as their folded form. */
  fill(whole: ReadonlyMap<number, TranscriptTurn>): void {
    const turns = this.turns;
    if (this.closed || !turns.some(one => whole.has(one.seq) && turnHeld(one))) return;
    this.state.transcript.history.seed(turns.map(one => turnHeld(one) ? whole.get(one.seq) ?? one : one));
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.state.dispose();
  }

  /** One read at a time each way: the list asks again while a page is on its way. */
  private once<T>(way: 'older' | 'newer', run: () => Promise<T>, busy: T): Promise<T> {
    if (this.reading[way] || this.closed) return Promise.resolve(busy);
    const reading = run().finally(() => { if (this.reading[way] === reading) this.reading[way] = null; });
    this.reading[way] = reading;
    return reading;
  }

  /** Settles when no read is in flight (tests, and a caller that needs the window whole before acting on it). */
  async settled(): Promise<void> {
    while (this.reading.older || this.reading.newer) await Promise.allSettled([this.reading.older, this.reading.newer]);
  }
}
