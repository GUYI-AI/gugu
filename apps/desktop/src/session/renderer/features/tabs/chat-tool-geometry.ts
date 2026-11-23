export type ChatToolSide = 'left' | 'right';

// Past a pane's narrowest width the divider stops and the drag starts folding that pane: the preview shows at once, and
// 65 pt further (the reference's 180 → 115 pt) a release folds it. Measured from the pane's minimum, not the block's
// edge, so no stretch of the drag does nothing.
export const CHAT_TOOL_COLLAPSE_COMMIT_PAST_MIN_PX = 65;
export const CHAT_TOOL_MIN_VISIBLE_PANE_PX = 324;
/** Below this tool width the header's exit-full-view button keeps only its icon, so the tabs keep room for their names. */
export const CHAT_TOOL_COMPACT_HEADER_MAX_WIDTH_PX = 420;

export const CHAT_TOOL_DROP_PREFIX = 'chat-tool-group-edge-';
export const chatToolDropId = (side: ChatToolSide, chatPaneId: string) => `${CHAT_TOOL_DROP_PREFIX}${side}-${chatPaneId}`;

export function chatDividerAt(offset: number, width: number, leftMin: number, rightMin: number): {
  sizes: [number, number];
  preview: ChatToolSide | undefined;
  collapse: ChatToolSide | undefined;
} {
  const usable = width - 1;
  const left = Math.max(leftMin, Math.min(usable - rightMin, offset));
  const fraction = (left / usable) * 100;
  const past = (by: number): ChatToolSide | undefined =>
    leftMin - offset >= by ? 'left' : rightMin - (usable - offset) >= by ? 'right' : undefined;
  return {
    sizes: [fraction, 100 - fraction],
    preview: past(1),
    collapse: past(CHAT_TOOL_COLLAPSE_COMMIT_PAST_MIN_PX),
  };
}
