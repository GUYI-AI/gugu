/**
 * @@@theme-packs — 资源库「主题」(owner 2026-11-07:配色从 VS Code / Obsidian 社区拿来,借鉴 spexcode)。
 *
 * 一个主题 = 一族配色,每族最多两套:深色一套、浅色一套(都有 = 双模式)。只取**颜色值**,❌ 第三方 CSS 进咕咕的文档。
 * 咕咕的表面与文字全从十来个 canonical 变量出来(tokens.css:--page/--bg/--card/--fg/--muted-fg/--live…;
 * 边框、悬停、选中由 --fg 混出),所以一套主题只覆盖这十来个变量,整个 app 跟着走。
 *
 * 一条路:上游配色(VS Code 的 colors / Obsidian 的变量)→ RawPalette → resolvePalette(补齐 + 表面阶梯 + 对比度兜底)
 * → paletteDeclarations → `:root[data-theme=…] { … }`。内置的七族是同一个 paletteFromVSCode 跑上游文件生成的数据,
 * 导入的走同一条路,只是数据当场算。
 */
import Color from 'colorjs.io';

export type ThemeMode = 'dark' | 'light';

export const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow', 'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const;
export type AnsiName = (typeof ANSI_NAMES)[number];

/** 上游给的颜色,已合成为实色 `#rrggbb`;缺的由 resolvePalette 推出来。 */
export type RawPalette = {
  page?: string;
  bg: string;
  card?: string;
  fg: string;
  muted?: string;
  /** 主题自己的「低一档」:选中行 / 分隔线的色。不少主题所有面同一个底,层次全在这里。 */
  layer?: string;
  mutedFg?: string;
  faintFg?: string;
  live?: string;
  danger?: string;
  warn?: string;
  ansi?: Partial<Record<AnsiName, string>>;
};

export type ThemePackSource = {
  kind: 'builtin' | 'vscode' | 'obsidian';
  /** 上游的页面(Open VSX 扩展页 / GitHub 仓库)。 */
  url: string;
  author: string;
  /** SPDX;上游没声明时是空串,卡片上写「—」。 */
  license: string;
  version?: string;
  /** 每个模式取的是上游哪一套(「Tokyo Night Light」)。 */
  variants?: Partial<Record<ThemeMode, string>>;
};

export type ThemePack = {
  id: string;
  name: string;
  modes: Partial<Record<ThemeMode, RawPalette>>;
  source: ThemePackSource;
};

export type PaletteRole = 'fg' | 'mutedFg' | 'faintFg' | 'live' | 'dangerFg' | 'warnFg' | 'okFg';

export type ResolvedPalette = {
  page: string;
  bg: string;
  card: string;
  fg: string;
  muted: string;
  mutedFg: string;
  faintFg: string;
  live: string;
  danger: string;
  dangerFg: string;
  warn: string;
  warnFg: string;
  okFg: string;
  ansi: Partial<Record<AnsiName, string>>;
};

export function packModes(pack: Pick<ThemePack, 'modes'>): ThemeMode[] {
  return (['dark', 'light'] as const).filter((mode) => pack.modes[mode]);
}

/**
 * 可读性下限,以及每个角色要对哪些表面成立(取最差那个)。
 * 正文 6(长时间读的字,比 AA 留余量);次级字 / 链接(--live 兼做链接色)/ 危险字 / 警告字 4.5(正文 AA);
 * 图标 / 装饰字:3(WCAG 1.4.11,和默认主题 theme-contrast-floors.test.tsx 同一条)。
 */
export const CONTRAST_FLOORS: Record<PaletteRole, { min: number; on: ReadonlyArray<'page' | 'bg' | 'card' | 'muted'> }> = {
  fg: { min: 6, on: ['page', 'bg', 'card', 'muted'] },
  mutedFg: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
  faintFg: { min: 3, on: ['page', 'bg', 'card', 'muted'] },
  live: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
  dangerFg: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
  warnFg: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
  okFg: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
};

/** 上游没给时用 tokens.css 的同名默认值(--live-dark / --live-light / --danger / --warn)。 */
/** 正文与次级字之间至少差这么多 OKLab 亮度(咕咕默认两套各是 0.24 / 0.30)。 */
export const MIN_TEXT_STEP = 0.1;

const FALLBACK = { live: { dark: '#61a5fa', light: '#3b82f6' }, danger: '#ef4444', warn: '#f59e0b', ok: '#16a34a' } as const;

// 颜色算术交给仓库已有的 colorjs.io(session-ui 的主题生成也用它);这里只包成「进出都是 #rrggbb」的几行。
const toHex = (c: Color) => c.to('srgb').toString({ format: 'hex', collapse: false });
const lightness = (value: string) => new Color(value).to('oklab').coords[0];
const contrastRatio = (a: string, b: string) => new Color(a).contrast(new Color(b), 'WCAG21');
const mixOklab = (a: string, b: string, amount: number) => toHex(Color.mix(a, b, amount, { space: 'oklab' }) as Color);

/** 色相、彩度不动,只把 OKLab 亮度挪 `delta`。 */
function shiftLightness(value: string, delta: number): string {
  const lab = new Color(value).to('oklab');
  lab.coords[0] = Math.min(1, Math.max(0, lab.coords[0] + delta));
  return toHex(lab);
}

/** 带透明度的色合成到底色上得到实际看到的实色(对比度只对实色有意义);认不出来是 null,❌ 猜。 */
function compositeOver(value: string | undefined, base: string): string | null {
  if (!value) return null;
  let top: Color;
  try {
    top = new Color(value);
  } catch {
    return null;
  }
  const alpha = Number(top.alpha);
  top.alpha = 1;
  return toHex(Color.mix(base, top, alpha, { space: 'srgb' }) as Color);
}

/** 背景说了算:上游标的 uiTheme 与实际底色不符时(标了深色、底却是亮的),按底色。 */
export function modeOfBackground(bg: string): ThemeMode {
  return new Color(bg).luminance > 0.18 ? 'light' : 'dark';
}

const lighterBy = (a: string, b: string) => lightness(a) - lightness(b);

/**
 * @@@theme-surface — 编辑器主题的底是配着满屏彩色语法字设计的;咕咕界面几乎没有彩色,同一个底铺满就只剩一大片色
 * (Gruvbox 亮 #fbf1c7:彩度 0.055,owner 11-08「看上去那么丑」)。大面积的面只收这两样,色相不动,字和强调色不动:
 * 彩度有上限;亮色内容面不低于这个亮度(Tokyo Night 亮 0.93,一整片灰),整组面一起抬,阶梯不变。
 */
const SURFACE_MAX_CHROMA: Record<ThemeMode, number> = { light: 0.028, dark: 0.045 };
const LIGHT_BG_MIN_LIGHTNESS = 0.955;

function tameChroma(value: string, mode: ThemeMode): string {
  const lch = new Color(value).to('oklch');
  if (lch.coords[1] <= SURFACE_MAX_CHROMA[mode]) return value;
  lch.coords[1] = SURFACE_MAX_CHROMA[mode];
  return toHex(lch);
}

function raiseContrast(color: string, surfaces: string[], min: number, mode: ThemeMode): string {
  let next = color;
  const worst = () => Math.min(...surfaces.map((s) => contrastRatio(next, s)));
  // 深色往亮、浅色往暗,一次 0.01;100 步走到头(纯白 / 纯黑)也就停了。
  for (let i = 0; i < 100 && worst() < min; i += 1) next = shiftLightness(next, mode === 'dark' ? 0.01 : -0.01);
  return next;
}

/**
 * 补齐 + 表面阶梯 + 对比度兜底。
 * 大面积的面先过 @@@theme-surface。阶梯照咕咕默认那套的形状:page(窗口底层)比 bg(内容)低一档;card(浮层、分组卡)深色时比 bg 亮、浅色时不比 bg 暗;
 * muted(填充面)与 card 分得开。上游不满足这个形状时由 bg 推,❌ 让浮层陷进内容里。
 */
export function resolvePalette(raw: RawPalette, mode: ThemeMode): ResolvedPalette {
  const fg = raw.fg;
  const lift = mode === 'light' ? Math.max(0, LIGHT_BG_MIN_LIGHTNESS - lightness(raw.bg)) : 0;
  const surface = (value: string) => shiftLightness(tameChroma(value, mode), lift);
  const bg = surface(raw.bg);
  const rawPage = raw.page && surface(raw.page);
  const layer = raw.layer && surface(raw.layer);
  const belowBg = (value: string | undefined) => !!value && lighterBy(bg, value) >= 0.012;
  // 主题的侧栏和内容同色时,窗口底层用它自己的「低一档」(深色的选中行比内容亮,当不了底层)。
  const page = belowBg(rawPage) ? rawPage! : belowBg(layer) ? layer! : shiftLightness(bg, mode === 'dark' ? -0.03 : -0.02);
  const rawCard = raw.card && surface(raw.card);
  const card = mode === 'dark'
    ? (rawCard && lighterBy(rawCard, bg) >= 0.02 ? rawCard : shiftLightness(bg, 0.035))
    : (rawCard && lighterBy(rawCard, bg) >= 0 ? rawCard : bg);
  // 填充面比 card 再往前景走一档(深色更亮、浅色更暗),上游的 input 底常常就是 bg 本身或全透明;再看主题自己的「低一档」,都不够才由 fg 推。
  const stepped = (value: string | undefined) => !!value
    && Math.min(...[card, bg].map((s) => (mode === 'dark' ? lighterBy(value, s) : lighterBy(s, value)))) >= 0.025;
  const rawMuted = raw.muted && surface(raw.muted);
  const muted = stepped(rawMuted) ? rawMuted! : stepped(layer) ? layer! : tameChroma(mixOklab(card, fg, mode === 'dark' ? 0.07 : 0.06), mode);
  const surfaces = { page, bg, card, muted };
  const guard = (role: PaletteRole, color: string): string => {
    const { min, on } = CONTRAST_FLOORS[role];
    return raiseContrast(color, on.map((k) => surfaces[k]), min, mode);
  };
  const danger = raw.danger ?? FALLBACK.danger;
  const warn = raw.warn ?? FALLBACK.warn;
  const resolvedFg = guard('fg', fg);
  // 次级字要和正文分得开:上游给成同一个色(Gruvbox 的 descriptionForeground = foreground)时层级就没了,改由 fg/bg 推。
  const upstreamMuted = raw.mutedFg && Math.abs(lightness(raw.mutedFg) - lightness(fg)) >= MIN_TEXT_STEP ? raw.mutedFg : undefined;
  return {
    page,
    bg,
    card,
    fg: resolvedFg,
    muted,
    mutedFg: guard('mutedFg', upstreamMuted ?? mixOklab(fg, bg, 0.35)),
    faintFg: guard('faintFg', raw.faintFg ?? mixOklab(fg, bg, 0.55)),
    live: guard('live', raw.live ?? FALLBACK.live[mode]),
    danger,
    dangerFg: guard('dangerFg', danger),
    warn,
    warnFg: guard('warnFg', warn),
    // 成功字:主题的终端绿(内置和 VS Code 导入都有),没有就是 tokens.css 的 --ok。
    okFg: guard('okFg', raw.ansi?.green ?? FALLBACK.ok),
    ansi: raw.ansi ?? {},
  };
}

/**
 * 兜底救不回来的配色:底色亮度不上不下时(相对亮度 0.125~0.18),字推到纯白 / 纯黑也到不了下限。
 * 内置的都过(themePacks.test.ts);导入时这样的一套不收(theme-pack-import.ts),❌ 收进来给人一片读不清的字。
 */
export function paletteIsReadable(raw: RawPalette, mode: ThemeMode): boolean {
  const p = resolvePalette(raw, mode);
  const colorOf: Record<PaletteRole, string> = { fg: p.fg, mutedFg: p.mutedFg, faintFg: p.faintFg, live: p.live, dangerFg: p.dangerFg, warnFg: p.warnFg, okFg: p.okFg };
  return (Object.keys(CONTRAST_FLOORS) as PaletteRole[]).every((role) => {
    const { min, on } = CONTRAST_FLOORS[role];
    return on.every((surface) => contrastRatio(colorOf[role], p[surface]) >= min);
  });
}

/** 一套解析好的配色写成 CSS 声明。只写种子色;气泡、--bg-secondary 这些由种子算出来的,tokens.css 在 [data-theme] 上自己跟着重算。 */
export function paletteDeclarations(p: ResolvedPalette, mode: ThemeMode): string[] {
  const d = (name: string, value: string) => `--${name}: ${value};`;
  const lines = [
    d('page', p.page), d('bg', p.bg), d('card', p.card), d('popover', p.card),
    d('fg', p.fg), d('muted', p.muted), d('muted-fg', p.mutedFg), d('faint-fg', p.faintFg),
    // --live 本身由 tokens.css 按主题指向这两档之一,所以覆盖的是档位,不是 --live。
    d(mode === 'dark' ? 'live-dark' : 'live-light', p.live),
    d('danger', p.danger), d('danger-fg', p.dangerFg), d('warn', p.warn), d('warn-fg', p.warnFg), d('ok-fg', p.okFg),
  ];
  for (const name of ANSI_NAMES) {
    const value = p.ansi[name];
    if (value) lines.push(d(`xterm-ansi-${name}`, value));
  }
  return lines;
}

/**
 * 两个槽位(深色时用哪族、浅色时用哪族)→ 一段样式表。
 * `:root[data-theme='dark']`(0,2,0)压过 tokens.css 的 `:root` / `[data-theme="light"]`(都是 0,1,0)。
 */
export function themePackStylesheet(slots: Partial<Record<ThemeMode, ThemePack>>): string {
  return (['dark', 'light'] as const)
    .flatMap((mode) => {
      const raw = slots[mode]?.modes[mode];
      if (!raw) return [];
      const body = paletteDeclarations(resolvePalette(raw, mode), mode).map((line) => `  ${line}`).join('\n');
      // tokens.css 的「提高对比度」写在 :root 上(0,1,0),压不过上面这条:这里接着把次级字和装饰字提回正文。
      return [
        `:root[data-theme='${mode}'] {\n${body}\n}`,
        `@media (prefers-contrast: more) {\n  :root[data-theme='${mode}'] { --muted-fg: var(--fg); --faint-fg: var(--fg); }\n}`,
      ];
    })
    .join('\n');
}

// ── 上游 → RawPalette ─────────────────────────────────────────────────────────────

function pick(colors: Record<string, string | undefined>, keys: readonly string[], base: string): string | undefined {
  for (const key of keys) {
    const solid = compositeOver(colors[key], base);
    if (solid) return solid;
  }
  return undefined;
}

const VSCODE_ANSI: Record<AnsiName, string> = {
  black: 'terminal.ansiBlack', red: 'terminal.ansiRed', green: 'terminal.ansiGreen', yellow: 'terminal.ansiYellow',
  blue: 'terminal.ansiBlue', magenta: 'terminal.ansiMagenta', cyan: 'terminal.ansiCyan', white: 'terminal.ansiWhite',
  'bright-black': 'terminal.ansiBrightBlack', 'bright-red': 'terminal.ansiBrightRed', 'bright-green': 'terminal.ansiBrightGreen',
  'bright-yellow': 'terminal.ansiBrightYellow', 'bright-blue': 'terminal.ansiBrightBlue', 'bright-magenta': 'terminal.ansiBrightMagenta',
  'bright-cyan': 'terminal.ansiBrightCyan', 'bright-white': 'terminal.ansiBrightWhite',
};

/**
 * VS Code 颜色主题的 `colors` → RawPalette。每个角色按顺序取第一个有值的键(映射表见设计稿 §4)。
 * errorForeground 排在后面:不少主题把它给成灰(Tokyo Night 是 #515670),编辑器里的错误色才是红。
 */
export function paletteFromVSCode(colors: Record<string, string | undefined>): RawPalette | null {
  const bg = compositeOver(colors['editor.background'], '#000000');
  if (!bg) return null;
  const fg = pick(colors, ['editor.foreground', 'foreground'], bg);
  if (!fg) return null;
  const ansi: Partial<Record<AnsiName, string>> = {};
  for (const name of ANSI_NAMES) {
    const value = pick(colors, [VSCODE_ANSI[name]], bg);
    if (value) ansi[name] = value;
  }
  return {
    bg,
    fg,
    page: pick(colors, ['sideBar.background', 'activityBar.background'], bg),
    card: pick(colors, ['editorWidget.background', 'dropdown.background', 'menu.background'], bg),
    muted: pick(colors, ['input.background', 'dropdown.background'], bg),
    layer: pick(colors, ['list.inactiveSelectionBackground', 'sideBar.border', 'panel.border'], bg),
    mutedFg: pick(colors, ['descriptionForeground', 'sideBarSectionHeader.foreground'], bg),
    faintFg: pick(colors, ['disabledForeground', 'editorLineNumber.foreground'], bg),
    // button.background 排最后:深色主题里它常是灰按钮(Dracula #44475a),不是强调色。
    live: pick(colors, ['textLink.foreground', 'progressBar.background', 'activityBarBadge.background', 'button.background'], bg),
    danger: pick(colors, ['editorError.foreground', 'terminal.ansiRed', 'errorForeground'], bg),
    warn: pick(colors, ['editorWarning.foreground', 'terminal.ansiYellow'], bg),
    ansi,
  };
}

/** VS Code 的 uiTheme → 模式。高对比两档 v1 不收(它们的整套是另一种设计,映进咕咕的十来个变量会走样)。 */
export function modeOfUiTheme(uiTheme: string | undefined): ThemeMode | null {
  if (uiTheme === 'vs') return 'light';
  if (uiTheme === 'vs-dark') return 'dark';
  return null;
}

/** Obsidian 主题算出来的变量(已是实色)→ RawPalette。 */
export function paletteFromObsidian(vars: Record<string, string | undefined>): RawPalette | null {
  const bg = compositeOver(vars['--background-primary'], '#000000');
  if (!bg) return null;
  const fg = pick(vars, ['--text-normal'], bg);
  if (!fg) return null;
  return {
    bg,
    fg,
    page: pick(vars, ['--background-secondary', '--background-secondary-alt'], bg),
    card: pick(vars, ['--background-primary-alt', '--background-secondary'], bg),
    muted: pick(vars, ['--background-modifier-form-field', '--background-secondary-alt'], bg),
    layer: pick(vars, ['--background-modifier-border'], bg),
    mutedFg: pick(vars, ['--text-muted'], bg),
    faintFg: pick(vars, ['--text-faint'], bg),
    live: pick(vars, ['--interactive-accent', '--text-accent', '--color-accent'], bg),
    danger: pick(vars, ['--text-error', '--color-red'], bg),
    warn: pick(vars, ['--color-orange', '--color-yellow'], bg),
  };
}

export const OBSIDIAN_VARIABLES = [
  '--background-primary', '--background-primary-alt', '--background-secondary', '--background-secondary-alt',
  '--background-modifier-form-field', '--background-modifier-border', '--text-normal', '--text-muted', '--text-faint', '--text-accent',
  '--interactive-accent', '--color-accent', '--text-error', '--color-red', '--color-orange', '--color-yellow',
] as const;

export type ThemeSwatch = Pick<ResolvedPalette, 'page' | 'bg' | 'card' | 'fg' | 'mutedFg' | 'live'>;

/**
 * 「咕咕默认」那张卡的预览色:tokens.css 里两套默认值的原样副本。❌ 读 var(--bg):主题生效时根上的变量已经是那一族的了,
 * 默认卡会画成当下的主题。themePacks.test.ts 逐字对齐 tokens.css,那边改了这里跟不上会红。
 */
export const GUGU_DEFAULT_SWATCH: Record<ThemeMode, ThemeSwatch> = {
  dark: { page: '#121212', bg: '#181818', card: '#212121', fg: '#dfdfdf', mutedFg: '#939393', live: 'oklch(0.714 0.143 255)' },
  light: { page: '#f9f9f9', bg: '#ffffff', card: '#ffffff', fg: '#1a1c1f', mutedFg: '#68696b', live: 'oklch(0.623 0.188 260)' },
};
