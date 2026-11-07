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
import {
  compositeOver,
  contrastRatio,
  mixOklab,
  oklabLightness,
  relativeLuminance,
  shiftLightness,
} from './theme-color';

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
  /** SPDX;上游没声明时是空串,详情里写「未声明许可」。 */
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

export type PaletteRole = 'fg' | 'mutedFg' | 'faintFg' | 'live' | 'dangerFg' | 'warnFg';

export type ContrastAdjustment = { role: PaletteRole; from: string; to: string; before: number; after: number };

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
  bubbleAgent: string;
  bubbleOwn: string;
  ansi: Partial<Record<AnsiName, string>>;
  adjustments: ContrastAdjustment[];
};

export function packModes(pack: Pick<ThemePack, 'modes'>): ThemeMode[] {
  return (['dark', 'light'] as const).filter((mode) => pack.modes[mode]);
}

/**
 * 可读性下限,以及每个角色要对哪些表面成立(取最差那个)。
 * 正文 6(长时间读的字,比 AA 留余量);次级字 / 链接(--live 兼做链接色)/ 危险字 / 警告字 4.5(正文 AA);
 * 装饰字只要不消失:2.5(咕咕默认浅色自己的 --faint-fg 是 2.68,tokens.css 的 Semantic theme tokens 一节写着它不承载信息)。
 */
export const CONTRAST_FLOORS: Record<PaletteRole, { min: number; on: ReadonlyArray<'page' | 'bg' | 'card' | 'muted'> }> = {
  fg: { min: 6, on: ['page', 'bg', 'card', 'muted'] },
  mutedFg: { min: 4.5, on: ['page', 'bg', 'card', 'muted'] },
  faintFg: { min: 2.5, on: ['bg', 'card'] },
  live: { min: 4.5, on: ['page', 'bg', 'card'] },
  dangerFg: { min: 4.5, on: ['page', 'bg', 'card'] },
  warnFg: { min: 4.5, on: ['page', 'bg', 'card'] },
};

const FALLBACK = {
  dark: { live: '#5e9ef5', danger: '#ef4444', warn: '#f59e0b' },
  light: { live: '#3b82f6', danger: '#dc2626', warn: '#b45309' },
} as const;

/** 背景说了算:上游标的 uiTheme 与实际底色不符时(标了深色、底却是亮的),按底色。 */
export function modeOfBackground(bg: string): ThemeMode {
  return relativeLuminance(bg) > 0.18 ? 'light' : 'dark';
}

function lighterBy(a: string, b: string): number {
  return oklabLightness(a) - oklabLightness(b);
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
 * 阶梯照咕咕默认那套的形状:page(窗口底层)比 bg(内容)低一档;card(浮层、分组卡)深色时比 bg 亮、浅色时不比 bg 暗;
 * muted(填充面)与 card 分得开。上游不满足这个形状时由 bg 推,❌ 让浮层陷进内容里。
 */
export function resolvePalette(raw: RawPalette, mode: ThemeMode): ResolvedPalette {
  const bg = raw.bg;
  const fg = raw.fg;
  const page = raw.page && lighterBy(bg, raw.page) >= 0.012 ? raw.page : shiftLightness(bg, mode === 'dark' ? -0.03 : -0.02);
  const card = mode === 'dark'
    ? (raw.card && lighterBy(raw.card, bg) >= 0.02 ? raw.card : shiftLightness(bg, 0.035))
    : (raw.card && lighterBy(raw.card, bg) >= 0 ? raw.card : bg);
  // 填充面比 card 再往前景走一档(深色更亮、浅色更暗),上游的 input 底常常就是 bg 本身或全透明。
  const mutedStep = raw.muted
    ? Math.min(...[card, bg].map((s) => (mode === 'dark' ? lighterBy(raw.muted as string, s) : lighterBy(s, raw.muted as string))))
    : 0;
  const muted = raw.muted && mutedStep >= 0.025 ? raw.muted : mixOklab(card, fg, mode === 'dark' ? 0.07 : 0.06);
  const surfaces = { page, bg, card, muted };
  const adjustments: ContrastAdjustment[] = [];
  const guard = (role: PaletteRole, color: string): string => {
    const { min, on } = CONTRAST_FLOORS[role];
    const list = on.map((k) => surfaces[k]);
    const before = Math.min(...list.map((s) => contrastRatio(color, s)));
    const fixed = raiseContrast(color, list, min, mode);
    if (fixed !== color) adjustments.push({ role, from: color, to: fixed, before, after: Math.min(...list.map((s) => contrastRatio(fixed, s))) });
    return fixed;
  };
  const danger = raw.danger ?? FALLBACK[mode].danger;
  const warn = raw.warn ?? FALLBACK[mode].warn;
  const resolvedFg = guard('fg', fg);
  return {
    page,
    bg,
    card,
    fg: resolvedFg,
    muted,
    mutedFg: guard('mutedFg', raw.mutedFg ?? mixOklab(fg, bg, 0.35)),
    faintFg: guard('faintFg', raw.faintFg ?? mixOklab(fg, bg, 0.55)),
    live: guard('live', raw.live ?? FALLBACK[mode].live),
    danger,
    dangerFg: guard('dangerFg', danger),
    warn,
    warnFg: guard('warnFg', warn),
    // 气泡:咕咕默认是比 bg 高一档、两档的中性面;这里照同样的距离从 bg 往 fg 混。
    bubbleAgent: mixOklab(bg, resolvedFg, mode === 'dark' ? 0.05 : 0.04),
    bubbleOwn: mixOklab(bg, resolvedFg, mode === 'dark' ? 0.1 : 0.08),
    ansi: raw.ansi ?? {},
    adjustments,
  };
}

/** 一套解析好的配色写成 CSS 声明。只写 canonical 变量与 tokens.css 里在明暗块各自写死了字面量的那几个。 */
export function paletteDeclarations(p: ResolvedPalette, mode: ThemeMode): string[] {
  const d = (name: string, value: string) => `--${name}: ${value};`;
  const lines = [
    d('page', p.page), d('bg', p.bg), d('card', p.card), d('popover', p.card),
    d('fg', p.fg), d('muted', p.muted), d('muted-fg', p.mutedFg), d('faint-fg', p.faintFg),
    // --live 本身由根上的 .emdark/.emlight 指向这两档之一,所以覆盖的是档位,不是 --live。
    d(mode === 'dark' ? 'live-dark' : 'live-light', p.live),
    d('danger', p.danger), d('danger-fg', p.dangerFg), d('warn', p.warn), d('warn-fg', p.warnFg),
    d('bubble-agent', p.bubbleAgent), d('bubble-own', p.bubbleOwn), d('bubble-other', p.bubbleAgent), d('bubble-mine', p.bubbleOwn),
  ];
  if (mode === 'light') {
    // 浅色块里这几个是写死的灰(rgba(249,249,249,…)),带色相的主题上会露出一块块灰补丁。
    lines.push(
      d('bg-secondary', 'color-mix(in oklab, var(--page) 85%, transparent)'),
      d('sidebar-bg', 'color-mix(in oklab, var(--page) 85%, transparent)'),
      d('topbar-bg', 'color-mix(in oklab, var(--page) 85%, transparent)'),
      d('bg-call-panel', 'color-mix(in oklab, var(--page) 96%, transparent)'),
    );
  }
  for (const name of ANSI_NAMES) {
    const value = p.ansi[name];
    if (value) lines.push(d(`xterm-ansi-${name}`, value));
  }
  return lines;
}

/**
 * 两个槽位(深色时用哪族、浅色时用哪族)→ 一段样式表。
 * `:root[data-theme='dark']`(0,2,0)压过 tokens.css 的 `:root` / `[data-theme="light"]` / 根上的 `.emdark`(都是 0,1,0)。
 */
export function themePackStylesheet(slots: Partial<Record<ThemeMode, ThemePack>>): string {
  return (['dark', 'light'] as const)
    .flatMap((mode) => {
      const raw = slots[mode]?.modes[mode];
      if (!raw) return [];
      const body = paletteDeclarations(resolvePalette(raw, mode), mode).map((line) => `  ${line}`).join('\n');
      return [`:root[data-theme='${mode}'] {\n${body}\n}`];
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
    mutedFg: pick(vars, ['--text-muted'], bg),
    faintFg: pick(vars, ['--text-faint'], bg),
    live: pick(vars, ['--interactive-accent', '--text-accent', '--color-accent'], bg),
    danger: pick(vars, ['--text-error', '--color-red'], bg),
    warn: pick(vars, ['--color-orange', '--color-yellow'], bg),
  };
}

export const OBSIDIAN_VARIABLES = [
  '--background-primary', '--background-primary-alt', '--background-secondary', '--background-secondary-alt',
  '--background-modifier-form-field', '--text-normal', '--text-muted', '--text-faint', '--text-accent',
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
