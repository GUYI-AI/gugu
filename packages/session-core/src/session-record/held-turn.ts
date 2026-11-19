import type { TranscriptTurn } from '../acp/client';

type Held = { held?: true; children?: readonly Held[] };

/**
 * Whether a page sent this turn as its folded form (transport-trim `folded-form`): some of what its folds show when
 * opened was left out. A reader that brings a row of such a turn on screen from behind a fold reads the turn again,
 * whole, and puts it in this one's place.
 */
export function turnHeld(turn: TranscriptTurn): boolean {
  const held = (node: Held): boolean => node.held === true || node.children?.some(held) === true;
  return turn.items.some(item => held(item as Held));
}
