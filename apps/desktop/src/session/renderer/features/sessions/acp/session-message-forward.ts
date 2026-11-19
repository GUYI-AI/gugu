import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ChatMessage, TranscriptTurn } from '@gugu/session-chat-ui';
import type { ForwardPiece } from '@/components/chat/forwardToChats';
import { sessionPromptBody } from './session-message-quote';

/** A forwarded answer brings the prompt it answers, cut here: the answer is what is forwarded, the prompt only says what it answers. */
export const FORWARD_PROMPT_MAX = 280;

/**
 * What forwarding one timeline bubble carries, or null when it carries nothing that can go. A chat message the agent sent goes
 * as itself; words go as words. An agent's answer goes with the prompt that opened its turn (`turns`), so it can be read
 * away from the task. `sender` is the name the timeline shows on an agent's bubble; `null` names the forwarder.
 */
export function sessionForwardPieces(input: {
  itemId: string; message: ChatMessage; text: string; sender: string | null; carried?: MessageItem;
  turns: readonly TranscriptTurn[];
}): ForwardPiece[] | null {
  const { carried } = input;
  if (carried) {
    // A chat message the agent sent goes as itself; what it handed its owner in the task has no chat message behind it:
    // its words go as words, and a file kept in the task's folder cannot go (its bytes are not readable here).
    if (carried.chat_id && !carried.session_file) return [{ kind: 'message', message: carried, sender: input.sender ?? undefined }];
    return carried.content_type === 'text' && carried.content?.trim() ? [{ kind: 'text', sender: input.sender, text: carried.content }] : null;
  }
  if (input.message.role !== 'assistant') {
    // A prompt is the forwarder's own unless it was delivered from someone; the timeline's label for one's own is not a name.
    const facts = input.message.guguDelivery?.segments[0]?.facts;
    return [facts ? { kind: 'text', sender: input.sender, senderId: userIdOf(facts.fromId), text: input.text } : { kind: 'text', sender: null, text: input.text }];
  }
  const said: ForwardPiece = { kind: 'text', sender: input.sender, text: input.text };
  const turn = input.turns.find(turn => turn.items.some(item => item.id === input.itemId));
  const prompt = turn?.items.find(item => item.kind === 'message' && item.role === 'user');
  if (!prompt || prompt.kind !== 'message') return [said];
  const envelope = readDeliveryEnvelope(prompt.text);
  const text = envelope ? envelope.body : sessionPromptBody(prompt.text);
  if (!text.trim()) return [said];
  const facts = envelope?.segments[0]?.facts;
  return [{ kind: 'text', sender: facts?.from ?? null, senderId: userIdOf(facts?.fromId), text: clip(text.trim(), FORWARD_PROMPT_MAX) }, said];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The user a delivery's `from_id` names (`user:<id>`), if it names one. */
function userIdOf(fromId: string | null | undefined): string | null {
  return fromId?.startsWith('user:') ? fromId.slice('user:'.length) : null;
}
