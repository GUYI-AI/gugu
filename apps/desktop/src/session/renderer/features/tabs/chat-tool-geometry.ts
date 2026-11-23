export type ChatToolSide = 'left' | 'right';

// The reference stayed split at 180 pt and collapsed at 115 pt from the chat edge.
export const CHAT_TOOL_COLLAPSE_PREVIEW_PX = 180;
export const CHAT_TOOL_COLLAPSE_COMMIT_PX = 115;
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
  const edgeAt = (distance: number): ChatToolSide | undefined =>
    offset <= distance ? 'left' : usable - offset <= distance ? 'right' : undefined;
  return {
    sizes: [fraction, 100 - fraction],
    preview: edgeAt(CHAT_TOOL_COLLAPSE_PREVIEW_PX),
    collapse: edgeAt(CHAT_TOOL_COLLAPSE_COMMIT_PX),
  };
}
