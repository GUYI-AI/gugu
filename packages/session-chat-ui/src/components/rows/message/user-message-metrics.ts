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
  userMessageActionsHeight, type MessageVars,
} from './metrics';

/** Both typed and delivered inputs use the same measured user-message body. */
export function measureUserMessage(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): number {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const available = userAvailableWidth(ctx.width, ctx.theme.layout);
  const attachments = attachStripHeight(item.attachments?.length ?? 0, available, vars) + inputSendStatusHeight(item);
  if (!item.guguDelivery && isMessageEditing(item.id, ctx)) {
    return attachments + messageEditorMetrics(ctx.editingMessage!.text, ctx).height;
  }
  const fullHeight = userBubbleFullHeight(item, ctx, vars);
  // 没有正文就没有气泡(UserMessageCard);还在流、一个字没到的除外,那时先占一行。
  if (fullHeight === null) return attachments
    + (item.attachments?.length ? conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0 : 0)
    + userMessageActionsHeight(vars);
  const cap = ctx.expandedId === item.id ? vars.expandedMaxH : vars.collapsedMaxH;
  return attachments + Math.min(fullHeight, cap) + (conversationDestinationLayout(item, ctx, userInnerWidth(available, vars))?.height ?? 0) + userMessageActionsHeight(vars);
}

/** The bubble's unfolded height (text or sent bodies plus padding), or null when there is no bubble. `vars` are effective vars. */
function userBubbleFullHeight(item: ChatMessage, ctx: MeasureCtx, vars: MessageVars): number | null {
  const inner = userInnerWidth(userAvailableWidth(ctx.width, ctx.theme.layout), vars);
  if (item.sentMessages?.length) return sentBodiesLayout(item.sentMessages, ctx, inner).height + 2 * vars.userCardPadY + 2 * vars.cardBorder;
  const blocks = item.streaming ? ctx.caches.parseBlocksStreaming(item.id, item.text) : ctx.caches.parseBlocks(item.id, item.text);
  if (blocks.length === 0 && !item.streaming) return null;
  const stackHeight = blocks.length === 0 ? ctx.theme.fonts.body.lineHeight
    : layoutBlockStack(blocks, { ...ctx, width: inner }, { isCollapsed: ctx.isCollapsed }).height;
  return stackHeight + 2 * vars.userCardPadY + 2 * vars.cardBorder;
}

/**
 * Whether a user message folds (draws 展开全文): its unfolded bubble is taller than the folded cap. The row's measured
 * height above caps at the same number, so this is the same decision the transcript makes, not a second threshold.
 */
export function userMessageFolds(item: ChatMessage, ctx: MeasureCtx, baseVars: MessageVars): boolean {
  const vars = effectiveMessageVars(baseVars, ctx.theme.layout);
  const full = userBubbleFullHeight(item, ctx, vars);
  return full !== null && full > vars.collapsedMaxH;
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
