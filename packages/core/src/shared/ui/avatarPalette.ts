/** The twelve identity hues shared by every default avatar. No generated color is persisted. */
export interface BodyColor {
  zh: string
  en: string
  /** OKLCH 色相(度) */
  hue: number
}

/** 全家同一个亮度 / 彩度(OKLCH)。 */
export const BODY_LIGHTNESS = 0.895
export const BODY_CHROMA = 0.0487

export const BODY_COLORS: readonly BodyColor[] = [
  { zh: '奶油', en: 'Cream', hue: 83.3 },
  { zh: '抹茶', en: 'Matcha', hue: 113.3 },
  { zh: '青芽', en: 'Sprout', hue: 143.3 },
  { zh: '薄荷', en: 'Mint', hue: 173.3 },
  { zh: '湖水', en: 'Lagoon', hue: 203.3 },
  { zh: '晴空', en: 'Sky', hue: 233.3 },
  { zh: '雾蓝', en: 'Haze', hue: 263.3 },
  { zh: '薰衣草', en: 'Lavender', hue: 293.3 },
  { zh: '丁香', en: 'Lilac', hue: 323.3 },
  { zh: '樱花', en: 'Sakura', hue: 353.3 },
  { zh: '蜜桃', en: 'Peach', hue: 23.3 },
  { zh: '杏子', en: 'Apricot', hue: 53.3 }
]

/** FNV-1a + murmur3 的收尾搅拌:短串(uuid)取模时低位也够匀。 */
export function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export type Rgb = readonly [number, number, number]

export function oklchToLinearSrgb(L: number, C: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export type AvatarTheme = 'light' | 'dark'

export function avatarColorIndex(id: string): number {
  const key = id.trim()
  if (!key) throw new Error('A default avatar color requires a stable identity id')
  return hash32(`color:${key}`) % BODY_COLORS.length
}

function hex(L: number, C: number, hue: number): string {
  const rgb = oklchToLinearSrgb(L, C, hue)
  return '#' + rgb.map((v) => {
    const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255).toString(16).padStart(2, '0')
  }).join('')
}

export const AVATAR_FEATURE_COLOR = '#131518'

/** Approved light/dark shades of the same hue; stored as 8-bit sRGB for identical SVG/CSS contrast. */
export const AVATAR_PALETTE = BODY_COLORS.map(({ hue }) => ({
  light: {
    body: hex(BODY_LIGHTNESS, BODY_CHROMA, hue),
    background: hex(.55, .075, hue),
    human: hex(BODY_LIGHTNESS, BODY_CHROMA, hue),
    groupFill: hex(BODY_LIGHTNESS, BODY_CHROMA, hue),
    groupStroke: hex(.58, .075, hue),
    groupText: hex(.37, .06, hue),
  },
  dark: {
    body: hex(.79, .09, hue),
    background: hex(.54, .07, hue),
    human: hex(.72, .065, hue),
    groupFill: hex(.29, .035, hue),
    groupStroke: hex(.65, .07, hue),
    groupText: hex(.82, .06, hue),
  },
}))
