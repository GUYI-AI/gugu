/**
 * 第 16 版 .capsule:对话卡片顶上那颗浮动胶囊(34 高、两侧 16、14.5px 粗、最宽 80%、暖色底)。
 * 最窄是两个高:名字只有一两个字时仍是横着的胶囊,❌ 一个圆(yangchichi 11-24),名字居中。
 */
export const CONVERSATION_CAPSULE_CLASS = 'flex [--capsule-h:34px] h-(--capsule-h) max-w-[80%] min-w-[calc(var(--capsule-h)*2)] cursor-pointer items-center justify-center gap-[6px] rounded-full bg-[var(--capsule-bg)] px-4 text-[length:var(--font-body)] font-semibold whitespace-nowrap text-[var(--fg)] shadow-[var(--capsule-shadow)] [-webkit-app-region:no-drag] hover:bg-[var(--capsule-hover)]';

/**
 * The layer that centres the capsule on the whole card. It covers the strip and inherits its window-drag region: the
 * strip's blank stays a handle to move the window, and only the capsule on it opts out. ❌ `app-region: none` here:
 * Chromium computes it as `no-drag`, so a layer this size made the whole header undraggable (with the inner column folded
 * nothing on the window moved it). The controls at the strip's start keep their holes because the strip draws them after
 * this layer (TabStripShell's leading slot): Electron adds and subtracts the regions in document order.
 */
export const CONVERSATION_CAPSULE_LAYER_CLASS = 'conversation-capsule-layer pointer-events-none absolute inset-0 flex items-center justify-center';
