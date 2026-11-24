/**
 * 第 16 版 .capsule:对话卡片顶上那颗浮动胶囊(34 高、两侧 16、14.5px 粗、最宽 80%、暖色底)。
 * 最窄是两个高:名字只有一两个字时仍是横着的胶囊,❌ 一个圆(yangchichi 11-24),名字居中。
 */
export const CONVERSATION_CAPSULE_CLASS = 'flex [--capsule-h:34px] h-(--capsule-h) max-w-[80%] min-w-[calc(var(--capsule-h)*2)] cursor-pointer items-center justify-center gap-[6px] rounded-full bg-[var(--capsule-bg)] px-4 text-[length:var(--font-body)] font-semibold whitespace-nowrap text-[var(--fg)] shadow-[var(--capsule-shadow)] [-webkit-app-region:no-drag] hover:bg-[var(--capsule-hover)]';

/**
 * The layer that centres the capsule on the whole card. It covers the strip, so it must not be a window-drag region of its
 * own: -webkit-app-region is inherited, and a drag rectangle later in the document re-adds drag over the no-drag holes
 * drawn before it (the split handle at the strip's start). `none` = this layer is no region at all; the strip under it
 * still drags the window and the capsule on it still opts out.
 */
export const CONVERSATION_CAPSULE_LAYER_CLASS = 'pointer-events-none absolute inset-0 flex items-center justify-center [-webkit-app-region:none]';
