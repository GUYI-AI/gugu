export type ChatToolSide = 'left' | 'right';

// The desktop reference stayed split at 180 px and collapsed at 115 px from the chat edge.
export const CHAT_TOOL_COLLAPSE_EDGE_PX = 144;
export const CHAT_TOOL_MIN_WIDTH_PX = 320;

export const CHAT_TOOL_DROP_PREFIX = 'chat-tool-group-edge-';
export const chatToolDropId = (side: ChatToolSide, chatPaneId: string) => `${CHAT_TOOL_DROP_PREFIX}${side}-${chatPaneId}`;

export function chatDividerAt(offset: number, width: number, leftMin: number, rightMin: number): {
  sizes: [number, number];
  collapse: ChatToolSide | undefined;
} {
  const usable = width - 1;
  const left = Math.max(leftMin, Math.min(usable - rightMin, offset));
  const fraction = (left / usable) * 100;
  const collapse = offset <= CHAT_TOOL_COLLAPSE_EDGE_PX ? 'left'
    : usable - offset <= CHAT_TOOL_COLLAPSE_EDGE_PX ? 'right'
    : undefined;
  return { sizes: [fraction, 100 - fraction], collapse };
}
