import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { timelineRailCandidates, timelineRailPreviewText } from '@gugu/core/shared/timelineRail';
import { messageReferenceId } from '@gugu/session-core/acp/client';

/**
 * @@@outline-of-the-whole-conversation — what a timeline rail needs to draw the turns its window has not loaded:
 * who asked what, and how the reply began. A window loads history a page at a time from the newest end; without
 * this its rail ends where the loaded pages end, and a conversation of thousands of turns shows as its last few
 * dozen. The machine that keeps the conversation reads the outline off its timeline without sending the turns: a few
 * hundred bytes per input.
 *
 * It lists candidates (`timelineRailCandidates`): the reader's own identity directory decides which of them its rail
 * shows, exactly as it does for loaded turns.
 */
export type SessionOutlineSender = Pick<DeliveryReadFacts, 'route' | 'from' | 'fromId' | 'fromType' | 'chatKind' | 'sourceLink'>;
export type SessionOutlineInput = {
  /** The user message, by the id it has in a loaded turn. */
  itemId: string;
  /** Its durable reference (`messageReferenceId`): what a reveal is asked with. */
  reference: string;
  /** Whether it is the turn's first user message: that input shares the turn's own id on the rail. */
  first: boolean;
  /** How many deliveries the message holds, or null for typed text. A reply to a mixed batch is nobody's. */
  segments: number | null;
  candidates: { text: string; sender: SessionOutlineSender | null }[];
  /** The first thing the agent said before the next input, cut to a preview. */
  reply: string;
};
export type SessionOutlineTurn = { id: string; inputs: SessionOutlineInput[] };
/**
 * `after`: the answer holds only the turns after that one (the reader asked with `afterTurnId` and the machine has it).
 * Absent: the whole outline before `beforeTurnId`, which is also what a machine that does not know `afterTurnId` sends.
 */
export type SessionOutline = { turns: SessionOutlineTurn[]; after?: string };

/** One message item of a turn, as the outline reads it: in turn order, then item order. */
export type OutlineMessageRow = {
  turnId: string; referenceId: string | null; initiator: string | null;
  itemId: string; role: string; text: string | null;
};

/** Long enough for the rail's two-line prompt and four-line reply; the rest stays on the machine. */
export const OUTLINE_PROMPT_CHARS = 200;
export const OUTLINE_REPLY_CHARS = 320;

/** The first `chars` characters, without walking the rest of a long text. */
const preview = (text: string, chars: number) => text.length <= chars ? text : [...text.slice(0, 2 * chars)].slice(0, chars).join('');

function senderOf(facts: DeliveryReadFacts): SessionOutlineSender {
  return { ...(facts.sourceLink ? { sourceLink: facts.sourceLink } : {}), route: facts.route, from: facts.from, fromId: facts.fromId,
    ...(facts.fromType ? { fromType: facts.fromType } : {}), chatKind: facts.chatKind } as SessionOutlineSender;
}

/** The outline of these messages' turns, oldest first. The same reading of a turn as the rail's own (`timelineTurnsFromTranscript`). */
export function outlineOfMessages(rows: readonly OutlineMessageRow[]): SessionOutlineTurn[] {
  const turns: SessionOutlineTurn[] = [];
  let turn: SessionOutlineTurn | undefined, input: SessionOutlineInput | undefined, first = true;
  for (const row of rows) {
    if (typeof row.turnId !== 'string' || typeof row.itemId !== 'string') continue;
    if (turn?.id !== row.turnId) {
      turn = { id: row.turnId, inputs: [] };
      turns.push(turn);
      input = undefined;
      first = true;
    }
    const text = row.text ?? '';
    if (row.role === 'user') {
      // Every input ends the preceding preview, including one the rail does not show.
      input = undefined;
      const firstInput = first;
      first = false;
      const delivery = readDeliveryEnvelope(text);
      if (row.initiator !== 'user' && !delivery) continue;
      const candidates = timelineRailCandidates(text).map(candidate => ({
        text: preview(candidate.text, OUTLINE_PROMPT_CHARS), sender: candidate.sender ? senderOf(candidate.sender) : null,
      }));
      if (!candidates.length) continue;
      const identity = { id: row.turnId, ...(row.referenceId ? { referenceId: row.referenceId } : {}) };
      input = { itemId: row.itemId, reference: messageReferenceId(identity, row.itemId) ?? row.itemId, first: firstInput,
        segments: delivery ? delivery.segments.length : null, candidates, reply: '' };
      turn.inputs.push(input);
      continue;
    }
    if (input && !input.reply && row.role === 'assistant') input.reply = preview(timelineRailPreviewText(text), OUTLINE_REPLY_CHARS);
  }
  return turns.filter(one => one.inputs.length > 0);
}
