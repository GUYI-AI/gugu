import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import type { PreviewActivitySource } from '@gugu/session-core/session-record/preview-activity';
import type { SegmentCtx } from '../core/units';
import type { ChatMessage, TranscriptTurn } from '../model';
import { incomingActivity, outgoingActivity, viewerGroupReply } from './agent-activity';
import { activitySummary, activitySummaryText } from './activity-summary';
import { conversationOutput } from './conversation-process';
import { planConversationSegments } from './conversation-segments';
import { withSentReplies } from './sent-replies';

/** Search keeps source identity, never a second copy of a folded message's text. */
export type ActivityPreviewSource = PreviewActivitySource;

export function activityPreviewSources(turn: TranscriptTurn): Map<string, ActivityPreviewSource | null> {
  const sources = new Map<string, ActivityPreviewSource | null>();
  let input: ActivityPreviewSource | null = null;
  const projected = withSentReplies(turn, { allDestinations: true });
  for (const block of planConversationSegments(projected, false)) {
    if (block.kind === 'input') {
      const item = block.item;
      const delivery = item.kind === 'message' ? readDeliveryEnvelope(item.text) : null;
      input = delivery ? { kind: 'received', id: item.id, facts: delivery.segments.map(({ facts }) => facts ? { fromId: facts.fromId, from: facts.from, ...(facts.fromType !== undefined ? { fromType: facts.fromType } : {}) } : null) } : null;
      sources.set(messageReferenceId(turn, item.id) ?? item.id, input);
    } else {
      const reply = conversationOutput(block.items).reply;
      const source: ActivityPreviewSource | null = reply ? { kind: 'sent', id: reply.id, addresses: reply.sentAddresses ?? null } : input;
      for (const item of block.items) if (item.kind === 'message') sources.set(messageReferenceId(turn, item.id) ?? item.id, source);
    }
  }
  return sources;
}

export function activityPreviewSource(turn: TranscriptTurn, reference: string): ActivityPreviewSource | null {
  return activityPreviewSources(turn).get(reference) ?? null;
}

/** Use exactly the transcript's identity classification and semantic summary. */
export function activityPreviewLabel(source: ActivityPreviewSource | null | undefined, ctx: Pick<SegmentCtx, 'actor' | 'chatKind' | 'chatName' | 'translate' | 'viewerId'>): string | null {
  if (!source) return null;
  const event = source.kind === 'sent' ? outgoingActivity(source.id, source.addresses, ctx)
    : incomingActivity({ kind: 'message', id: source.id, seq: 0, role: 'user', text: '',
      guguDelivery: { body: '', segments: source.facts.map(facts => ({ facts, body: '' })) } } as ChatMessage, ctx);
  if (event) return activitySummaryText(activitySummary({ id: event.id, events: [event] }, ctx.translate));
  const group = source.kind === 'sent' ? viewerGroupReply({ sentAddresses: source.addresses } as ChatMessage, ctx) : null;
  return group ? ctx.translate('transcript.activityReplyToYou', { name: group.name }) : null;
}
