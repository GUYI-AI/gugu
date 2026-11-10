/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js';
import { layout as layoutText, prepareWithSegments } from '@chenglou/pretext';
import type { MeasureCtx } from '@session-chat/core/define';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import { isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import type { ChatMessage } from '@session-chat/model';
import { conversationContext } from './ConversationMessage';
import { conversationRoot } from './conversation-message.css';
import { effectiveMessageVars, userAvailableWidth, userInnerWidth, type MessageVars } from './metrics';
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
  const text = parse(item.id, item.text).map(blockPlainText).join(' ').replace(/\s+/g, ' ').trim()
    || (item.attachments ?? []).map(attachment => attachment.name).join(', ');
  const inner = userInnerWidth(userAvailableWidth(ctx.width, layout), vars);
  const lineHeight = ctx.theme.fonts.body.lineHeight;
  const lines = layoutText(prepareWithSegments(text, ctx.theme.fonts.body.font, { whiteSpace: 'pre-wrap' }), inner, lineHeight).lineCount;
  const height = Math.min(Math.max(lines, 1), 2) * lineHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  return { text, vars, conversation, hug: isDoubleColumnLayout(layout), height, clipped: lines > 2 };
}

/** Clicking it scrolls back to the message (ChatRoot reads `data-pin-summary`). */
export function PinnedUserSummary(props: { item: ChatMessage; ctx: MeasureCtx; vars: MessageVars }) {
  const s = createMemo(() => pinSummary(props.item, props.ctx, props.vars));
  return (
    <div class={s().conversation ? conversationRoot : undefined} data-side="right">
      <div role="button" tabIndex={0} data-pin-summary={props.item.id} class={card({ state: 'static' })} style={{
        width: s().hug ? 'fit-content' : '100%', 'max-width': '100%', height: `${s().height}px`, 'margin-left': 'auto',
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
