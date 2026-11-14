/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js';
import { layout as layoutText, prepareWithSegments } from '@chenglou/pretext';
import type { MeasureCtx } from '@session-chat/core/define';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import type { ChatMessage } from '@session-chat/model';
import { conversationBubbleTop, conversationContext, conversationVars } from './ConversationMessage';
import { DELIVERY_VARS, deliveryBodyTop } from './DeliveryCard';
import { conversationRoot } from './conversation-message.css';
import { effectiveMessageVars, userInnerWidth, type MessageVars } from './metrics';
import { userBubbleBox } from './user-message-metrics';
import { card } from './user-message.css';

/**
 * The stuck form of a user message (@@@sticky-user-lanes): the same bubble, its text clamped to two lines.
 * Pure geometry, so the lane math reads its height without touching the DOM. A text longer than two lines
 * fades out at the end of its second line, as a cut-off title in the sidebar does.
 */
export function pinSummary(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars) {
  const conversation = !!ctx.theme.layout?.agentConversation;
  const layout = (conversation ? conversationContext(ctx) : ctx).theme.layout;
  const vars = effectiveMessageVars(baseVars, layout);
  const parse = item.streaming ? ctx.caches.parseBlocksStreaming : ctx.caches.parseBlocks;
  // The message's own lines, so a message of one or two lines and its summary are the same picture.
  const body = parse(item.id, item.text).map(blockPlainText).join('\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\n ]*/g, '\n').trim();
  const text = body || (item.attachments ?? []).map(attachment => attachment.name).join(', ');
  // The summary rests behind the last `height` px of the bubble it repeats, in the bubble's own box (ChatRoot @@@pin-cover).
  const bubble = conversation ? userBubbleBox(item, conversationContext(ctx, item), conversationVars(item, baseVars)) : userBubbleBox(item, ctx, baseVars);
  // `bubble.bottom` is counted from the top of the message card; a delivered message draws more above that card — its
  // sender's name in the agent conversation, the delivery card's padding and source line elsewhere. Without it the
  // summary rested that much above its bubble: over the attachment's name and the bubble's top edge (#2629).
  const above = conversation ? conversationBubbleTop(item, ctx) : item.role === 'user' && item.guguDelivery ? deliveryBodyTop(item, ctx, DELIVERY_VARS) : 0;
  const lineHeight = ctx.theme.fonts.body.lineHeight;
  const lines = summaryLineCount(text, ctx.theme.fonts.body.font, userInnerWidth(bubble.width, vars), lineHeight, ctx.measureEpoch ?? 0);
  // Never taller than the bubble it rests behind: a cite pill is one cut line in the bubble but its whole label here.
  const height = Math.min(Math.min(Math.max(lines, 1), 2) * lineHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder, bubble.height ?? Infinity);
  const shown = Math.max(1, Math.min(2, Math.floor((height - 2 * vars.userCardPadY - 2 * vars.cardBorder) / lineHeight)));
  return { text, vars, conversation, height, shown, clipped: lines > 2 || (bubble.height !== undefined && lines > 1 && bubble.height < 2 * lineHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder), rest: Math.max(0, above + bubble.bottom - height), width: bubble.width, bare: !bubble.drawn };
}

// @@@summary-lines-once — the list asks for every anchor's summary each time it is rebuilt (an older page lands, a
// name arrives), and laying the text out is nearly all of a summary's cost: with a few hundred typed messages loaded
// it was a fifth of a landing. The count depends on these five values alone, so the most recently asked keep theirs.
const SUMMARY_LINES_KEPT = 4096;
const summaryLines = new Map<string, number>();
function summaryLineCount(text: string, font: string, width: number, lineHeight: number, epoch: number): number {
  const key = `${epoch}\n${width}\n${lineHeight}\n${font}\n${text}`;
  const kept = summaryLines.get(key);
  if (kept !== undefined) {
    summaryLines.delete(key);
    summaryLines.set(key, kept);
    return kept;
  }
  const lines = layoutText(prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' }), width, lineHeight).lineCount;
  if (summaryLines.size >= SUMMARY_LINES_KEPT) summaryLines.delete(summaryLines.keys().next().value!);
  summaryLines.set(key, lines);
  return lines;
}

/** Clicking it scrolls back to the message (ChatRoot reads `data-pin-summary`). */
export function PinnedUserSummary(props: { item: ChatMessage; ctx: MeasureCtx; vars: MessageVars }) {
  const s = createMemo(() => pinSummary(props.item, props.ctx, props.vars));
  return (
    <div class={s().conversation ? conversationRoot : undefined} data-side="right">
      <div role="button" tabIndex={0} data-pin-summary={props.item.id} data-pin-bare={s().bare ? '' : undefined} class={card({ state: 'static' })} style={{
        // The bubble's own box, so the bubble hides it at rest and its two lines break where the message's first two do.
        width: `${s().width}px`, height: `${s().height}px`, 'margin-left': 'auto',
        padding: `${s().vars.userCardPadY}px ${s().vars.userCardPadX}px`, 'border-width': `${s().vars.cardBorder}px`,
        font: props.ctx.theme.fonts.body.font, 'line-height': `${props.ctx.theme.fonts.body.lineHeight}px`, cursor: 'pointer',
      }}>
        <span style={{ display: '-webkit-box', 'white-space': 'pre-wrap', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': s().shown, overflow: 'hidden', 'overflow-wrap': 'anywhere',
          // Cut off: the first line whole, the second fading out over its last third.
          ...(s().clipped ? { 'mask-image': s().shown > 1 ? 'linear-gradient(black, black), linear-gradient(to right, black 67%, transparent)' : 'linear-gradient(to right, black 67%, transparent)',
            'mask-size': `100% ${props.ctx.theme.fonts.body.lineHeight}px`, 'mask-position': 'top, bottom', 'mask-repeat': 'no-repeat' } : {}) }}>{s().text}</span>
      </div>
    </div>
  );
}
