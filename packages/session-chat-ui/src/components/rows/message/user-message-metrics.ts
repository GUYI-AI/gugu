import { conversationDestinationLayout } from './conversation-destination';
import { proseLinesHeight } from '@session-chat/components/rows/markdown/html/layout';
import type { MeasureCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import type { ChatMessage } from '@session-chat/model';
import { isMessageEditing, messageEditorMetrics } from './message-editor-metrics';
import { inputSendStatusHeight } from './InputSendStatus';
import { sentBodiesLayout } from './SentMessageBodies';
import {
  attachStripHeight, effectiveMessageVars, userAvailableWidth, userInnerWidth,
  userMessageActionsHeight, userPillWidth, type MessageVars,
} from './metrics';

/** Both typed and delivered inputs use the same measured user-message body. */
export function measureUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const editing = !item.guguDelivery && isMessageEditing(item.id, ctx);
  return userBubbleBox(item, ctx, baseVars).bottom + inputSendStatusHeight(item)
    + (editing ? 0 : userMessageActionsHeight(effectiveMessageVars(baseVars, ctx.theme.layout)));
}

/**
 * The bubble as drawn, below the top of the message card: where it ends (its attachments sit above it) and how wide it is.
 * The row's height and the pinned summary's rest position both read it, so they cannot disagree. What a row draws above
 * the card (a delivered message's sender line) is added by each of them from one helper of that row (#2629).
 */
export function userBubbleBox(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): { bottom: number; width: number; drawn: boolean } {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const strip = attachStripHeight(item.attachments?.length ?? 0, available, vars);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) return { bottom: strip + messageEditorMetrics(ctx.editingMessage!.text, ctx).height, width: available, drawn: false };
  const inner = userInnerWidth(available, vars);
  const destination = conversationDestinationLayout(item, ctx, inner);
  const body = userBubbleBody(item, ctx, inner);
  // 没有正文就没有气泡(UserMessageCard);还在流、一个字没到的除外,那时先占一行。
  if (!body) return { bottom: strip + (item.attachments?.length ? destination?.height ?? 0 : 0), width: available, drawn: false };
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return { bottom: strip + Math.min(body.height + 2 * vars.userCardPadY + 2 * vars.cardBorder, cap) + (destination?.height ?? 0),
    width: userPillWidth(available, Math.max(body.width, destination?.width ?? 0), vars, ctx.theme.layout), drawn: true };
}

/** The bubble's unfolded text or sent bodies, or null when there is no bubble. */
function userBubbleBody(item: ChatMessage, ctx: MeasureCtx, inner: number): { width: number; height: number } | null {
  if (item.sentMessages?.length) return sentBodiesLayout(item.sentMessages, ctx, inner);
  const blocks = item.streaming ? ctx.caches.parseBlocksStreaming(item.id, item.text) : ctx.caches.parseBlocks(item.id, item.text);
  if (blocks.length === 0) return item.streaming ? { width: 0, height: ctx.theme.fonts.body.lineHeight } : null;
  return layoutBlockStack(blocks, { ...ctx, width: inner }, { isCollapsed: ctx.isCollapsed });
}

export function estimateUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const attachments = attachStripHeight(item.attachments?.length ?? 0, available, vars) + inputSendStatusHeight(item);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachments + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  if (!item.text.trim()) return attachments
    + (item.attachments?.length ? conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0 : 0)
    + userMessageActionsHeight(vars);
  const lines = Math.max(1, Math.ceil(item.text.length / 60));
  const fullHeight = proseLinesHeight(lines, ctx.theme) + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return attachments + Math.min(fullHeight, cap) + (conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0) + userMessageActionsHeight(vars);
}
