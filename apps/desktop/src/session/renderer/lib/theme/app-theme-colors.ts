/**
 * @@@app-theme-colors — App 页面(含文件预览)在自己的 webview 里,调色板是构建时从 tokens.css 算好的(app-palette.mjs),
 * 主题改的是宿主文档根上的种子,够不到那边。所以主题生效时,把同一张表在宿主当下的值算出来交给页面;
 * 没有主题(默认)就是 undefined,页面继续用构建时那份。值从 APP_PALETTE_COLORS 一条条解析,❌ 另列一份名字。
 */
import { APP_PALETTE_COLORS } from '../../../app-runtime/ui/app-palette.mjs';
import { THEME_PACK_STYLE_ID } from './theme-pack-ids';

export function appThemeColors(): Record<string, string> | undefined {
  if (typeof document === 'undefined') return undefined;
  const root = document.documentElement;
  // 一个主题可以只有一种明暗:当下这种没有它的配色,就还是默认。
  if (!document.getElementById(THEME_PACK_STYLE_ID)?.textContent?.includes(`[data-theme='${root.dataset.theme}']`)) return undefined;
  const probe = document.createElement('div');
  probe.style.display = 'none';
  for (const [name, token] of APP_PALETTE_COLORS) probe.style.setProperty(name, token);
  root.appendChild(probe);
  const computed = getComputedStyle(probe);
  const colors = Object.fromEntries(APP_PALETTE_COLORS.map(([name]) => [name, computed.getPropertyValue(name).trim()]));
  probe.remove();
  return colors;
}
