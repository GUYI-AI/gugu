/**
 * The conversation in a record is a tree, and the timeline is the path to its newest line. Every harness writes a
 * rewind the same way in the end: a new line hangs off an older one, and the lines after that older one stay in the
 * file as a branch nobody continues (Claude `/rewind` and revert marks, Qwen and Pi `/rewind`, CodeBuddy's fork notice,
 * a Codex `thread_rolled_back` once its adapter points it at the line before the turns it took back). An adapter only
 * says what each line is (`RecordNode`); which lines the timeline keeps is decided here, the same way for all of them.
 *
 * A fork is a `prompt` or `rewind` node whose parent is not the newest tree line. From the first other child of that
 * parent up to the fork node, every tree line belongs to the abandoned branch. A record has one writer, so the old branch
 * stopped growing at the fork, and the range is exactly that branch. Other lines (tool results beside a parallel call,
 * attachments) never fork, so they stay.
 *
 * A fork is usually seen after the lines it abandons were already handed out. The reader then reads the record again
 * knowing its forks (`TreeState.fresh`), and this time drops those lines as it meets them. The forks travel with the
 * reader's state, so a later open or resume knows them from the start and reads once.
 */
import { withoutSessionContext } from '../../acp/session-context';
import type { RecordEntry } from '../contract';

export type RecordNode = {
  id: string;
  /**
   * Null = no parent known: such a line never forks. An adapter whose rewinds can go back to the very start gives the
   * start an id of its own (`RECORD_START`) and hangs its first lines off it.
   */
  parent: string | null;
  /** `prompt` opens a turn, `rewind` only moves the conversation back; either can fork. */
  kind: 'prompt' | 'rewind' | 'line';
};

export type RecordFork = { parent: string; at: string };

/** The parent of a conversation's first lines, for adapters that can rewind to before them. */
export const RECORD_START = '#start';

export type TreeState = {
  /** The newest tree line kept. */
  leaf: string | null;
  forks: RecordFork[];
  /** Forks whose abandoned branch this read is inside. */
  open: string[];
  /** Forks whose abandoned branch this read has already met. */
  met: string[];
  /** A fork this read found that it did not know when it started: what it handed out before it is wrong. */
  fresh: boolean;
};

export const initialTree = (forks: RecordFork[] = []): TreeState => ({ leaf: null, forks, open: [], met: [], fresh: false });

/**
 * A person's prompt starts a turn: its first user message carries the line's id (`RecordEntry.turn`). The session
 * context Gugu sent in front of a prompt is not part of it (`withoutSessionContext`).
 */
export function markTurn(entries: RecordEntry[], node: RecordNode): RecordEntry[] {
  if (node.kind !== 'prompt') return entries;
  entries = entries.flatMap((entry): RecordEntry[] => {
    if (!hasEvent(entry) || entry.event.kind !== 'message' || entry.event.role !== 'user') return [entry];
    const text = withoutSessionContext(entry.event.text);
    if (text === entry.event.text) return [entry];
    return text ? [{ ...entry, event: { ...entry.event, text } }] : [];
  });
  const first = entries.findIndex((entry) => entry.event?.kind === 'message' && entry.event.role === 'user' && entry.event.steering !== true);
  if (first < 0) return entries;
  const opening = entries[first]!;
  if (!opening.event) return entries;
  return entries.map((entry, index) => index === first ? { ...opening, turn: node.id } : entry);
}

export const hasEvent = (entry: RecordEntry): entry is Extract<RecordEntry, { event: unknown }> => entry.event !== undefined;

/** Takes in the next tree line in file order; false = it is on an abandoned branch. `tree` is changed in place. */
export function keepNode(tree: TreeState, node: RecordNode): boolean {
  for (const fork of tree.forks) {
    if (fork.at === node.id) {
      if (tree.open.includes(fork.at)) tree.open = tree.open.filter((at) => at !== fork.at);
    } else if (fork.parent === node.parent && !tree.met.includes(fork.at)) {
      tree.met = [...tree.met, fork.at];
      tree.open = [...tree.open, fork.at];
    }
  }
  if (tree.open.length > 0) return false;
  if (node.kind !== 'line' && node.parent !== null && tree.leaf !== null && node.parent !== tree.leaf
    && !tree.forks.some((fork) => fork.at === node.id)) {
    tree.forks = [...tree.forks, { parent: node.parent, at: node.id }];
    tree.fresh = true;
  }
  tree.leaf = node.id;
  return true;
}
