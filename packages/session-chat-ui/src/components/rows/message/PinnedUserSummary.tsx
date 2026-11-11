/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js';
import { layout as layoutText, prepareWithSegments } from '@chenglou/pretext';
import type { MeasureCtx } from '@session-chat/core/define';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import { isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import type { ChatMessage } from '@session-chat/model';
import { conversationContext, conversationVars } from './ConversationMessage';
import { conversationRoot } from './conversation-message.css';
import { attachStripHeight, effectiveMessageVars, userAvailableWidth, userInnerWidth, type MessageVars } from './metrics';
import { userMessageFolds } from './user-message-metrics';
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
  const body = parse(item.id, item.text).map(blockPlainText).join(' ').replace(/\s+/g, ' ').trim();
  const text = body || (item.attachments ?? []).map(attachment => attachment.name).join(', ');
  const available = userAvailableWidth(ctx.width, layout);
  const inner = userInnerWidth(available, vars);
  const lineHeight = ctx.theme.fonts.body.lineHeight;
  const lines = summaryLineCount(text, ctx.theme.fonts.body.font, inner, lineHeight, ctx.measureEpoch ?? 0);
  const height = Math.min(Math.max(lines, 1), 2) * lineHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  // Where the message's bubble starts inside its row: below its attachments, which sit above the bubble.
  const bubbleTop = body ? attachStripHeight(item.attachments?.length ?? 0, available, vars) : 0;
  // A message the transcript folds is too tall to push along: it pins only once it has gone (ChatRoot placeRow).
  const folds = conversation ? userMessageFolds(item, conversationContext(ctx, item), conversationVars(item, baseVars)) : userMessageFolds(item, ctx, baseVars);
  return { text, vars, conversation, hug: isDoubleColumnLayout(layout), height, clipped: lines > 2, bubbleTop, available, folds };
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
      <div role="button" tabIndex={0} data-pin-summary={props.item.id} class={card({ state: 'static' })} style={{
        // As wide as the message's own bubble, so its two lines break where the message's first two do.
        width: s().hug ? 'fit-content' : `${s().available}px`, 'max-width': `${s().available}px`, height: `${s().height}px`, 'margin-left': 'auto',
        padding: `${s().vars.userCardPadY}px ${s().vars.userCardPadX}px`, 'border-width': `${s().vars.cardBorder}px`,
        font: props.ctx.theme.fonts.body.font, 'line-height': `${props.ctx.theme.fonts.body.lineHeight}px`, cursor: 'pointer',
      }}>
        <span style={{ display: '-webkit-box', '-webkit-box-orient': 'vertical', '-webkit-line-clamp': 2, overflow: 'hidden', 'overflow-wrap': 'anywhere',
          // Cut off: the first line whole, the second fading out over its last third.
          ...(s().clipped ? { 'mask-image': 'linear-gradient(black, black), linear-gradient(to right, black 67%, transparent)',
            'mask-size': `100% ${props.ctx.theme.fonts.body.lineHeight}px`, 'mask-position': 'top, bottom', 'mask-repeat': 'no-repeat' } : {}) }}>{s().text}</span>
      </div>
    </div>
  );
}
