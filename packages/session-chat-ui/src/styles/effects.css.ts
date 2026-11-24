/**
 * effects.css.ts — ports the @utility effects from the old tokens.css §3.
 *
 * running-text and fade-overlay-top/bottom are typed VE style objects. Components
 * import the class names directly instead of using Tailwind utility strings.
 */

import { style } from '@vanilla-extract/css';
import { vars } from './theme.css';

// ── artifact surface ──────────────────────────────────────────────────────────

/**
 * 「agent 正文」与「内嵌的逐字产物」之间的那道边界。三个调用点共用:代码块 / 表格 /
 * mermaid —— 它们各自手抄过一遍同一条公式,三份定义处。ui-visual-spec §8 缺口 3
 * 点名了这份重复,这里把它并成一档。
 *
 * ⚠️ **导出的是规则对象,不是 class,这一点是被实测逼出来的。**
 * 用 `style([artifactSurface, {…}])` 组合过一版,三个块全瞎了(mermaid 契约测试报
 * `no mermaid wrapper: expected +0 to be 1`)。根因在 VE 源码里:
 * `composeStylesIntoSet(set, ...className.trim().split(' '))` —— 组合的导出是**空格分隔
 * 的多个类名**,而这三个文件都用 `globalStyle(\`${x} svg\`)` 之类拿它拼选择器,
 * `"a b"` 一插进去就变成后代选择器 `.a .b svg`,再也匹配不到任何东西。
 * ⇒ 谁的 class 会被拼进选择器,谁就不能用 composition。
 *
 * ⚠️ 只收「面本身」的两条声明。滚动、内边距、hover、boxSizing 都是各块自己的事,
 * 留在各自文件里 —— 把它们一起收进来会让这个名字名不副实,下一个人就不敢用它了。
 *
 * ⚠️ 这不是「卡片」。§6 说层次用颜色表达而不是投影:这道面**不填色、不投影**,
 * 只画一条闭合的边。契约测试(`markdown-rows.contract.test.tsx`)两个方向都钉着它 ——
 * 加填色红、加投影红、把边剥掉也红。
 */
export const artifactSurface = {
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusMd,
} as const;

// ── running text ──────────────────────────────────────────────────────────────

/**
 * 「有名字的动作正在跑」时那段字的墨色:静止的次级墨色。动的只有同一行(或同一轮)的那枚共用字形
 * (@gugu/session-shared/running-glyph);字本身不扫光 —— 一道扫光每个 vsync 都要整窗出一帧。
 */
export const runningText = style({
  color: vars.fgPassive,
  WebkitTextFillColor: vars.fgPassive,
});

/** Shared with the host message viewport; paint only, never intercept selection or scrolling. */
export const viewportTopFade = {
  height: 16,
  pointerEvents: 'none',
  background: 'linear-gradient(to bottom, var(--chat-bg), transparent)',
} as const;

// ── fade-overlay-top ──────────────────────────────────────────────────────────

export const fadeOverlayTop = style({
  background: `linear-gradient(
    to bottom,
    ${vars.bg} 0%,
    color-mix(in oklab, ${vars.bg}, transparent 50%) 40%,
    color-mix(in oklab, ${vars.bg}, transparent 100%) 100%
  )`,
});

// ── fade-overlay-bottom ───────────────────────────────────────────────────────

export const fadeOverlayBottom = style({
  background: `linear-gradient(
    to top,
    ${vars.bg} 0%,
    color-mix(in oklab, ${vars.bg}, transparent 50%) 40%,
    color-mix(in oklab, ${vars.bg}, transparent 100%) 100%
  )`,
});
