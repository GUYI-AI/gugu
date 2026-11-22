import type { ChatMessage } from '@session-chat/model';
import type { MeasureCtx } from '@session-chat/core/define';
import { conversationReferenceInFooter, conversationShowsName, messageReplyReference } from '@session-chat/state/conversation-density';
import { readableLabel } from '../readable-label';
import { processButtonLayout, processRowHeight, backgroundPillLayout } from './process-row-layout';

// @@@sender-label-once — a sender line is laid out for its row and again for its pinned summary each time the pin geometry
// is rebuilt (every anchor at once): with 500 delivered anchors that was 14 ms a rebuild (#2629, Chromium). Unwrapped, the
// label depends on its text, the theme and the font epoch alone, so the most recently asked keep theirs.
const SENDER_LABELS_KEPT = 4096;
const senderLabels = new WeakMap<MeasureCtx['theme'], Map<string, ReturnType<typeof readableLabel>>>();
function senderLabel(text: string, ctx: MeasureCtx): ReturnType<typeof readableLabel> {
  let kept = senderLabels.get(ctx.theme);
  if (!kept) senderLabels.set(ctx.theme, kept = new Map());
  const key = `${ctx.measureEpoch ?? 0}\n${text}`;
  const label = kept.get(key) ?? readableLabel(text, ctx, Number.MAX_SAFE_INTEGER, 12, 18, 650);
  kept.delete(key);
  if (kept.size >= SENDER_LABELS_KEPT) kept.delete(kept.keys().next().value!);
  kept.set(key, label);
  return label;
}

/** Hover only changes paint. The inline metadata has the same measured geometry at rest. */
export function conversationHeaderLayout(item: ChatMessage, ctx: MeasureCtx, senderName: string) {
  const showName = conversationShowsName(item, item.conversationPreviousSpeaker, ctx.selfIdentity?.userId);
  const quote = Boolean(messageReplyReference(item));
  const process = item.role === 'assistant' ? item.conversationProcess : undefined;
  const separator = quote && process;
  const metadataWidth = (quote ? 18 : 0) + (separator ? 4 : 0);
  // The name and the process row lay out like flex items with flex-wrap: on one line when both fit at their natural
  // widths; otherwise the name keeps the first line (cut only when it is wider than the whole line) and the process row,
  // with the reply reference, moves to its own line below. ❌ Shrinking the name to make room: on a phone that left two or
  // three characters of it. The live timer is measured at its widest ('999h59m') so nothing moves as the clock ticks.
  const naturalCtx = { ...ctx, width: Number.MAX_SAFE_INTEGER };
  const naturalButton = process && processButtonLayout(process, naturalCtx);
  const naturalBackground = process && backgroundPillLayout(item.id, naturalCtx);
  const naturalProcess = naturalButton ? naturalButton.width + (naturalBackground ? naturalBackground.width + 19 : 0) : 0;
  const trailing = Number(quote) + Number(Boolean(process)) + Number(Boolean(separator));
  const name = showName ? senderLabel(senderName, ctx) : null;
  const wrap = Boolean(name && process) && name!.width + naturalProcess + metadataWidth + trailing * 8 > ctx.width;
  const slots = (wrap ? 0 : Number(Boolean(name))) + trailing;
  const namePrefix = name && !wrap ? senderLabel(`${Array.from(senderName)[0] ?? ''}…`, ctx).width : 0;
  const gap = slots > 1 ? Math.min(8, Math.max(0, (ctx.width - naturalProcess - metadataWidth - namePrefix) / (slots - 1))) : 8;
  const nameWidth = name ? Math.min(name.width, wrap ? ctx.width : Math.max(0, ctx.width - naturalProcess - metadataWidth - Math.max(0, slots - 1) * gap)) : 0;
  const shown = name && (wrap || nameWidth > 0) ? name : null;
  const referenceInFooter = conversationReferenceInFooter(item, Boolean(shown));
  const gapWidth = Math.max(0, slots - 1) * gap;
  const processCtx = { ...ctx, width: Math.max(40, ctx.width - (wrap ? 0 : nameWidth) - metadataWidth - gapWidth) };
  const button = process && processButtonLayout(process, processCtx);
  const background = process && backgroundPillLayout(item.id, processCtx);
  const processWidth = button ? Math.min(processCtx.width, button.width + (background ? background.width + 19 : 0)) : 0;
  const processHeight = process ? processRowHeight(item.id, process, processCtx) : 0;
  const lineHeight = Math.max(processHeight, quote ? 18 : 0);
  return { name: shown, nameWidth, gap, wrap, processCtx, processWidth, referenceInFooter,
    height: !shown && !process ? 0 : (wrap ? shown!.height + lineHeight : Math.max(shown?.height ?? 0, lineHeight)) + 6 };
}
