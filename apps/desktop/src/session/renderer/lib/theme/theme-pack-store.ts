/**
 * @@@theme-pack-slots — 主题选择的唯一真值,照 VS Code 的 preferredDark/LightColorTheme:两个槽位,
 * 「深色时用哪族」「浅色时用哪族」。明暗本身仍归 host-theme.ts(浅 / 深 / 跟随系统),两层互不吞并:
 *   - 选双模式主题:两个槽位一起填,明暗偏好不动(跟随系统照常跟);
 *   - 选单模式主题:只填它那一格;当下生效的是另一种明暗时顺手把偏好切过去 —— 点一下就要看得见(owner 11-07 拍板);
 *   - 槽位空 = 那种明暗用咕咕默认。
 *
 * 落地是一段样式表(`<style id="gugu-theme-pack">`),同一段字符串存进 localStorage,index.html 的引导脚本首帧前就插上,
 * 不闪色。内置与导入走同一条路(themePackStylesheet),只是导入的配色存在本机。
 * 只作用于这台电脑上的咕咕 —— 资源库别的格是分机器的,这一格不是。
 */
import builtinThemePacks from './builtin-theme-packs.json';
import { notifyHostTheme, readEffectiveHostTheme, readThemePreference, writeThemePreference, type ThemePreference } from './host-theme';
import { THEME_PACK_CSS_KEY, THEME_PACK_SLOTS_KEY, THEME_PACK_STYLE_ID } from './theme-pack-ids';
import { packModes, themePackStylesheet, type ThemeMode, type ThemePack } from './theme-packs';

export { THEME_PACK_CSS_KEY, THEME_PACK_SLOTS_KEY, THEME_PACK_STYLE_ID };
const IMPORTED_KEY = 'app-theme-packs-imported';

/** 内置七族的上游配色:数据文件,由 scripts/theme-packs/generate-builtin-theme-packs.ts 从上游 .vsix 生成,❌ 手改。 */
export const BUILTIN_THEME_PACKS = builtinThemePacks as readonly ThemePack[];

export type ThemePackSlots = Partial<Record<ThemeMode, string>>;

const listeners = new Set<() => void>();

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // 存坏了(被手改、旧版本)按没有处理;下一次写入会把它覆盖成好的。
    return fallback;
  }
}

function isPack(value: unknown): value is ThemePack {
  const pack = value as ThemePack | null;
  return !!pack && typeof pack.id === 'string' && typeof pack.name === 'string' && !!pack.modes && !!pack.source
    && packModes(pack).every((mode) => typeof pack.modes[mode]?.bg === 'string' && typeof pack.modes[mode]?.fg === 'string');
}

export function readImportedThemePacks(): ThemePack[] {
  const list = readJson<unknown>(IMPORTED_KEY, []);
  return Array.isArray(list) ? list.filter(isPack) : [];
}

export function allThemePacks(): ThemePack[] {
  return [...BUILTIN_THEME_PACKS, ...readImportedThemePacks()];
}

export function findThemePack(id: string | undefined): ThemePack | undefined {
  return id ? allThemePacks().find((pack) => pack.id === id) : undefined;
}

export function readThemePackSlots(): ThemePackSlots {
  const slots = readJson<ThemePackSlots>(THEME_PACK_SLOTS_KEY, {});
  const out: ThemePackSlots = {};
  // 指向已经不存在的主题(导入的被删了)= 那一格回到默认。
  for (const mode of ['dark', 'light'] as const) if (findThemePack(slots?.[mode])?.modes[mode]) out[mode] = slots[mode];
  return out;
}

/** 把槽位落成样式表,插进(或更新)head 里那一个 style。 */
export function applyThemePackSlots(slots: ThemePackSlots = readThemePackSlots()): void {
  const css = themePackStylesheet({ dark: findThemePack(slots.dark), light: findThemePack(slots.light) });
  if (typeof localStorage !== 'undefined') {
    if (css) localStorage.setItem(THEME_PACK_CSS_KEY, css);
    else localStorage.removeItem(THEME_PACK_CSS_KEY);
  }
  if (typeof document === 'undefined') return;
  let style = document.getElementById(THEME_PACK_STYLE_ID);
  if (!css) {
    style?.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.id = THEME_PACK_STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
  // App 页面在自己的 webview 里,要被告知。
  notifyHostTheme();
}

function writeSlots(slots: ThemePackSlots): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_PACK_SLOTS_KEY, JSON.stringify(slots));
  applyThemePackSlots(slots);
  for (const listener of listeners) listener();
}

export type ThemePackChoice = { slots: ThemePackSlots; preference: ThemePreference };

/** 选一族主题。返回选之前的槽位与明暗偏好,给「撤销」用。 */
export function chooseThemePack(id: string): ThemePackChoice {
  const pack = findThemePack(id);
  if (!pack) throw new Error(`没有这个主题:${id}`);
  const before = { slots: readThemePackSlots(), preference: readThemePreference() };
  const modes = packModes(pack);
  const next = { ...before.slots };
  for (const mode of modes) next[mode] = id;
  writeSlots(next);
  // 单模式主题:当下是另一种明暗时把偏好切过去,❌ 选了却看不见变化。
  if (modes.length === 1 && readEffectiveHostTheme() !== modes[0]) writeThemePreference(modes[0]);
  return before;
}

export function restoreThemePackChoice(choice: ThemePackChoice): void {
  writeSlots(choice.slots);
  if (readThemePreference() !== choice.preference) writeThemePreference(choice.preference);
}

/** 两种明暗都回到咕咕默认。 */
export function resetThemePacks(): void {
  writeSlots({});
}

export function saveImportedThemePack(pack: ThemePack): void {
  const rest = readImportedThemePacks().filter((p) => p.id !== pack.id);
  if (typeof localStorage !== 'undefined') localStorage.setItem(IMPORTED_KEY, JSON.stringify([...rest, pack]));
  for (const listener of listeners) listener();
}

export function removeImportedThemePack(id: string): void {
  const slots = readThemePackSlots();
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify(readImportedThemePacks().filter((p) => p.id !== id)));
  }
  const next = { ...slots };
  for (const mode of ['dark', 'light'] as const) if (next[mode] === id) delete next[mode];
  writeSlots(next);
}

export function subscribeToThemePacks(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * useSyncExternalStore 要一个**稳定**的快照:内容没变就返回同一个字符串。
 * 槽位 + 导入清单的原文拼起来就是。
 */
export function themePackSnapshot(): string {
  if (typeof localStorage === 'undefined') return '';
  return `${localStorage.getItem(THEME_PACK_SLOTS_KEY) ?? ''}\n${localStorage.getItem(IMPORTED_KEY) ?? ''}`;
}
