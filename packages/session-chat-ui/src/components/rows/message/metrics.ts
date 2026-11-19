import { type FileRowKind, fileRowsHeight } from '@gugu/session-shared/file-row';
import { type ChatLayout, isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import { CONVERSATION_BLOCK_GAP } from '@session-chat/core/spacing';
import type { ChatAttachment } from '@session-chat/model';

export type MessageVars = {
  cardBorder: number;
  collapsedMaxH: number;
  expandedMaxH: number;
  userCardPadX: number;
  userCardPadY: number;
  attachGap: number;
  footerH: number;
};

/** Subset of MessageVars projected into CSS via the VE contract. */
export type MessageStyleVars = {
  userCardPadX: number;
  userCardPadY: number;
  cardBorder: number;
  attachGap: number;
};

export const USER_MESSAGE_ACTION_GAP = 4;

/** Reserve the action row even while its hover controls are hidden. */
export function actionGap(layout?: ChatLayout): number {
  return layout?.agentConversation ? CONVERSATION_BLOCK_GAP : USER_MESSAGE_ACTION_GAP;
}

export function userMessageActionsHeight(vars: Pick<MessageVars, 'footerH'>, gap = USER_MESSAGE_ACTION_GAP): number {
  return gap + vars.footerH;
}

export function messageAttachmentGap(vars: Pick<MessageVars, 'attachGap'>, layout: ChatLayout | undefined, hasBody: boolean): number {
  return layout?.agentConversation && !hasBody ? 0 : vars.attachGap;
}

export const conversationGutter = (width: number): number => Math.max(32, Math.round(width * .14));
export function conversationColumnWidth(width: number): number {
  return userAvailableWidth(width, { preset: 'double', userGutter: conversationGutter(width) });
}

/**
 * Per-layout overrides of the user card geometry (#4874 「对话视图」).
 *
 * `base` turns the bordered full-width card into a borderless pill with tighter
 * padding. Kept as a pure function of (vars, layout) so measure, estimate and
 * render all derive the same numbers — the geometry contract stays one source.
 */
export function effectiveMessageVars(vars: MessageVars, layout: ChatLayout | undefined): MessageVars {
  if (!isDoubleColumnLayout(layout)) return vars;
  return { ...vars, cardBorder: 0, userCardPadX: 16, userCardPadY: 12 };
}

/**
 * Width the user card may occupy inside the row. In `base` the layout's
 * `userGutter` is reserved on the left so the pill never spans the column —
 * but never more than a quarter of it: a narrow column (a session squeezed into
 * one of several screen blocks, #7052) keeps ≥3/4 for the pill instead of
 * crushing it to one character per line.
 */
export function userAvailableWidth(ctxWidth: number, layout: ChatLayout | undefined): number {
  if (!isDoubleColumnLayout(layout)) return ctxWidth;
  const gutter = Math.min(Math.max(0, layout?.userGutter ?? 0), Math.floor(ctxWidth / 4));
  return Math.max(1, ctxWidth - gutter);
}

/** Available width for block layout inside the user card. */
export function userInnerWidth(ctxWidth: number, vars: MessageVars): number {
  return Math.max(1, ctxWidth - 2 * vars.userCardPadX - 2 * vars.cardBorder);
}

/**
 * Outer width of the `base` pill: hug the widest measured line, capped at the
 * available width. Text geometry never changes with the hug because every
 * fragment is projected at an absolute x measured against the full inner width;
 * only the painted box shrinks. Returns `available` outside `base` or when the
 * content has no measurable extent (attachments-only, empty).
 */
export function userPillWidth(
  available: number,
  contentWidth: number | null,
  vars: MessageVars,
  layout: ChatLayout | undefined
): number {
  if (!isDoubleColumnLayout(layout) || contentWidth === null) return available;
  const hug = Math.ceil(contentWidth) + 2 * vars.userCardPadX + 2 * vars.cardBorder;
  return Math.max(1, Math.min(available, hug));
}

/**
 * 附件条占掉的高度(含它与气泡之间那道间距);一件都没有时是 0(❌ 不留那道间距)。
 *
 * 每一枚是一条定宽的文件行(图片是同高的方形缩略图),形状和尺寸只在 `@gugu/session-shared/file-row`,
 * 绘制读的也是那一组数 ⇒ 这里只把附件翻成「图 / 文件」交给它排。
 */
export function attachStripHeight(attachments: readonly ChatAttachment[] | undefined, available: number, vars: Pick<MessageVars, 'attachGap'>): number {
  if (!attachments?.length) return 0;
  return fileRowsHeight(attachments.map(attachmentRowKind), available) + vars.attachGap;
}

/** 缺席 = 图片(历史生产者只送图,见 `ChatAttachment.kind`)。 */
export function attachmentRowKind(attachment: ChatAttachment): FileRowKind {
  return attachment.kind === 'file' ? 'file' : 'image';
}
