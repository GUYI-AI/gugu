/**
 * The rail's geometry, split out of the component so「一条 260 轮的会话画成什么样」
 * 判得起来 —— 组件那边要 React + mobx + 一整套 store 才挂得起来(#4874 把取刻度的
 * `session-timeline-turns` 拆出去,也是同一个理由)。
 *
 * 参照 owner 2026-09-04 指的 vivid-layer Chat Minimap:12px 行 + 2px 药丸 + 3× 余弦透镜。
 *
 * ⚠️ 12px 是**定死的行高,不是上限**:轨道能站下多少格由它的高度决定(`railCapacity`),
 * 轮数超过就一格代表多轮(`turnsPerTick`),❌ 不是把行距压细。压细那条路试过 ——
 * 260 轮时一行 3.3px,owner 2026-09-10:「要不弄个上限吧,现在太密了」。所以任何长度的
 * 会话画出来都是同一种疏密,轨道也永远落在框内;格数另有固定上限 `MAX_TICKS`。
 */

/** Marker row height and the resting pill length. */
export const ITEM_SIZE = 12;
/** Hovered pill length as a multiple of ITEM_SIZE. */
export const MAGNIFICATION = 3;
/** Neighbours on each side of the hovered marker that swell with it. */
const LENS_RANGE = 3;
/** Pill thickness. */
export const PILL_WIDTH = 2;
/** The reading line: px below the viewport top; the first row crossing it names「the turn being read」. */
export const READING_LINE = 24;
/** Synthetic rows flattenTier mints per turn (`${turnId}:<suffix>`), so they map back to their turn too. */
export const SYNTHETIC_ROW_SUFFIXES = ['day', 'process', 'outcome'];

/**
 * 轨道最多画几格,不管这一列有多高。只按高度封顶时,长会话的轨永远是一整列 12px 的梳子
 * (owner 2026-11-20 截图:三千轮的会话从顶栏排到输入框,「有点崩坏了」);一格那时已经代表
 * 十来条输入,再多画格子也分不出什么。32 格 = 384px,短会话(≤32 条输入)不受影响。
 */
export const MAX_TICKS = 32;

/**
 * 这条轨道站得下多少格 —— 它的高度除以行高,再封在 `MAX_TICKS` 以内。还没量到高度
 * (首帧之前)就按 `MAX_TICKS` 算:那一帧也不会为长会话挂出上千个格子。
 */
export function railCapacity(railHeight: number): number {
  if (!Number.isFinite(railHeight) || railHeight <= 0) return MAX_TICKS;
  return Math.max(1, Math.min(MAX_TICKS, Math.floor(railHeight / ITEM_SIZE)));
}

/**
 * 一格代表几轮。放得下就 1(一轮一格,与短会话一模一样);放不下就均摊到站得下的格子里。
 * 均摊而不是「只画最近 N 轮」:轨道要能带你回到会话开头 —— owner 撞见这个 bug 时
 * 干的就是往上翻。
 */
export function turnsPerTick(count: number, capacity: number): number {
  if (count <= 0 || capacity <= 0) return 1;
  return Math.max(1, Math.ceil(count / capacity));
}

// Adapted from Mantine Lens Select (MIT), via the vivid-layer Chat Minimap.
export function markerWidth(index: number, hoveredIndex: number | null): number {
  if (hoveredIndex === null) return ITEM_SIZE;
  const distance = Math.abs(index - hoveredIndex);
  if (distance >= LENS_RANGE) return ITEM_SIZE;
  const factor = (1 + Math.cos((Math.PI * distance) / LENS_RANGE)) / 2;
  return ITEM_SIZE + (ITEM_SIZE * MAGNIFICATION - ITEM_SIZE) * factor;
}
