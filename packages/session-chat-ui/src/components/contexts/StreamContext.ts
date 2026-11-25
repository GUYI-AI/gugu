/**
 * StreamContext — per-message streaming animation state.
 *
 * Provided by every row that draws a reply's blocks (AssistantRender, and the
 * conversation bubble the agent-conversation layout draws replies in) while the
 * message is streaming; null for committed messages so there is zero animation
 * overhead in the non-streaming case.
 *
 * `frontier` maps blockId → number of characters already painted on the
 * previous render. An html block fades only the text past it, not text that was
 * already visible.
 *
 * The Map is shared by reference — the html block writes into it each time it
 * paints, so the next streaming tick finds the correct frontier without any
 * extra reactivity.
 *
 * `streaming` and `settledCount` are reactive accessors (not plain values).
 * Code.tsx reads them to highlight each block as soon as it crosses a safe
 * parse boundary (fence close or blank line), rather than waiting for the
 * whole message to commit. Using accessors (not plain values in the context)
 * is necessary because Solid context values are not reactive when swapped.
 */

import { createContext, useContext } from 'solid-js';
import type { Accessor } from 'solid-js';

export type StreamAnimation = {
  /** blockId → count of characters that were already visible on the previous render. */
  frontier: Map<string, number>;
  /**
   * Reactive accessor: true while the parent message is still streaming,
   * false once the message commits.
   */
  streaming: Accessor<boolean>;
  /**
   * Reactive accessor: the number of blocks currently in the stable settled
   * prefix for this message. A block at index `i` has crossed a safe parse
   * boundary (fence close or blank line outside a fence) when `i < settledCount()`.
   * Code blocks use this to highlight as soon as they settle rather than
   * waiting for the whole message to commit.
   */
  settledCount: Accessor<number>;
};

export const StreamContext = createContext<StreamAnimation | null>(null);

/** Returns the current StreamAnimation, or null outside a streaming row. */
export const useStreamAnimation = (): StreamAnimation | null => useContext(StreamContext);

/**
 * One row's StreamAnimation, made once per mounted row: its frontier persists across streaming chunks because the
 * row stays mounted while its message grows.
 */
export function createStreamAnimation(streaming: Accessor<boolean>, settledCount: Accessor<number>): StreamAnimation {
  return { frontier: new Map(), streaming, settledCount };
}
