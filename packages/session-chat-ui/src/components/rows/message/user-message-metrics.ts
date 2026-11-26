import { conversationDestinationLayout } from './conversation-destination';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { MeasureCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { ChatMessage } from '@session-chat/model';
import { isMessageEditing, messageEditorMetrics } from './message-editor-metrics';
import { inputSendStatusHeight } from './InputSendStatus';
import { sentBodiesLayout } from './SentMessageBodies';
import {
  actionGap, attachStripHeight, effectiveMessageVars, messageAttachmentGap, userAvailableWidth, userInnerWidth,
  userMessageActionsHeight, type MessageVars,
} from './metrics';

/** Both typed and delivered inputs use the same measured user-message body. */
export function measureUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const editing = !item.guguDelivery && isMessageEditing(item.id, ctx);
  return userBubbleBottom(item, ctx, baseVars) + inputSendStatusHeight(item)
    + (editing ? 0 : userMessageActionsHeight(effectiveMessageVars(baseVars, ctx.theme.layout), actionGap(ctx.theme.layout)));
}

/** Where the bubble as drawn ends below the top of the message card (its attachments sit above it). */
function userBubbleBottom(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachStripHeight(item.attachments, available, vars) + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  const inner = userInnerWidth(available, vars);
  const destination = conversationDestinationLayout(item, ctx, inner);
  const body = userBubbleBody(item, ctx, inner);
  const attachGap = messageAttachmentGap(vars, ctx.theme.layout, body !== null);
  const strip = attachStripHeight(item.attachments, available, { attachGap });
  // 没有正文就没有气泡(UserMessageCard);还在流、一个字没到的除外,那时先占一行。
  if (!body) return strip + (item.attachments?.length ? destination?.height ?? 0 : 0);
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return strip + Math.min(body.height + 2 * vars.userCardPadY + 2 * vars.cardBorder, cap) + (destination?.height ?? 0);
}

/** The bubble's unfolded text or sent bodies, or null when there is no bubble. */
function userBubbleBody(item: ChatMessage, ctx: MeasureCtx, inner: number): { height: number } | null {
  if (item.sentMessages?.length) return sentBodiesLayout(item.sentMessages, ctx, inner);
  const blocks = item.streaming ? ctx.caches.parseBlocksStreaming(item.id, item.text) : ctx.caches.parseBlocks(item.id, item.text);
  if (blocks.length === 0) return item.streaming ? { height: ctx.theme.fonts.body.lineHeight } : null;
  return layoutBlockStack(blocks, { ...ctx, width: inner }, { isCollapsed: ctx.isCollapsed });
}

export function estimateUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const attachments = attachStripHeight(item.attachments, available, vars) + inputSendStatusHeight(item);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachments + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  if (!item.text.trim()) return attachments
    + (item.attachments?.length ? conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0 : 0)
    + userMessageActionsHeight(vars, actionGap(ctx.theme.layout));
  const lines = Math.max(1, Math.ceil(item.text.length / 60));
  const fullHeight = proseLinesHeight(lines, ctx.theme) + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return attachments + Math.min(fullHeight, cap) + (conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0) + userMessageActionsHeight(vars, actionGap(ctx.theme.layout));
}
