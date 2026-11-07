/**
 * 主题包用的颜色算术:解析、透明度合成、WCAG 对比度、OKLab 里只动亮度。
 * 纯函数、零依赖 —— 内置主题表由同一套函数从上游文件生成,导入走的也是这一套,两边不会算出两种结果。
 */

export type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → 0..1 的 rgba;认不出来就是 null(❌ 不猜)。 */
export function parseHexColor(value: string | undefined | null): Rgba | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), full.length === 8 ? channel(6) : 1];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** 带透明度的色合成到底色上,得到实际看到的实色。对比度只对实色有意义。 */
export function compositeOver(value: string | undefined | null, base: string): string | null {
  const top = parseHexColor(value);
  const under = parseHexColor(base);
  if (!top || !under) return null;
  const a = top[3];
  return toHex([0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as unknown as Rgb);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbOf(hex: string): Rgb {
  const parsed = parseHexColor(hex);
  if (!parsed) throw new Error(`not a colour: ${hex}`);
  return [parsed[0], parsed[1], parsed[2]];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Lab = [number, number, number];

export function toOklab(hex: string): Lab {
  const [r, g, b] = rgbOf(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return toHex([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma) as unknown as Rgb);
}

export function oklabLightness(hex: string): number {
  return toOklab(hex)[0];
}

/** 色相、彩度不动,只把 OKLab 亮度挪 `delta`。 */
export function shiftLightness(hex: string, delta: number): string {
  const [L, a, b] = toOklab(hex);
  return fromOklab([Math.min(1, Math.max(0, L + delta)), a, b]);
}

/** `a` 往 `b` 混 `amount`(0..1),在 OKLab 里混 —— 与 tokens.css 的 `color-mix(in oklab, …)` 同一个空间。 */
export function mixOklab(a: string, b: string, amount: number): string {
  const x = toOklab(a);
  const y = toOklab(b);
  return fromOklab([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as Lab);
}
