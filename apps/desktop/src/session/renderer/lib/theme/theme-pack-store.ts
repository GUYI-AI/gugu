/**
 * @@@theme-pack-slots — 主题选择的唯一真值,照 VS Code 的 preferredDark/LightColorTheme:两个槽位,
 * 「深色时用哪族」「浅色时用哪族」。明暗本身仍归 host-theme.ts(浅 / 深 / 跟随系统),两层互不吞并:
 *   - 选双模式主题:两个槽位一起填,明暗偏好不动(跟随系统照常跟);
 *   - 选单模式主题:只填它那一格;当下生效的是另一种明暗时顺手把偏好切过去 —— 点一下就要看得见(owner 11-07 拍板);
 *   - 槽位空 = 那种明暗用咕咕默认。
 *
 * 落地是一段样式表(`<style id="gugu-theme-pack">`),由槽位 + 主题清单推出来(shared/theme/theme-packs.ts 的 slotsStylesheet),
 * 只算不存。一个壳一份存储(lib/devicePreferences.ts 同一个选择):
 *   - 桌面:槽位 = app 设置 `themePackSlots`;导入的主题 = 主进程 userData 下的文件;首帧的样式表由主进程算好,经 preload
 *     交给 index.html 的引导脚本;之后在页里按槽位 + 清单现算(同一个纯函数)。
 *   - web / 手机:槽位与导入的主题在 localStorage;样式表在页里算,顺手缓存一份给引导脚本首帧前插(它没有主进程可问)。
 * 只作用于这台电脑上的咕咕 —— 资源库别的格是分机器的,这一格不是。
 */
import { replica, useReplica, type Reading } from '@/lib/replica';
import { useMemo } from 'react';
import { createSelectStore, useSelect } from '@/lib/selectStore';
import { devicePreferences, documentStorage, useDevicePreference } from '@/lib/devicePreferences';
import { rendererLogger } from '@/lib/log';
import { events, rpc } from '@renderer/lib/ipc';
import { importedThemePacksChangedChannel } from '@shared/events/appEvents';
import {
  BUILTIN_THEME_PACKS,
  isThemePack,
  packModes,
  slotsStylesheet,
  validThemePackSlots,
  type ThemeMode,
  type ThemePack,
} from '@shared/theme/theme-packs';
import { PREFERENCE_STORAGE_KEYS, parseImportedThemePacks, type ThemePackSlots } from '../../../../../shared/device-preferences';
import { notifyHostTheme, readEffectiveHostTheme, readThemePreference, writeThemePreference, type ThemePreference } from './host-theme';
import { THEME_PACK_STYLE_ID } from './theme-pack-ids';

export { THEME_PACK_STYLE_ID };
export type { ThemePackSlots };

const log = rendererLogger('theme/packs');

/** One per shell. */
type PackStore = {
  imported(): Reading<ThemePack[]>;
  useImported(): Reading<ThemePack[]>;
  save(pack: ThemePack): Promise<void>;
  remove(id: string): Promise<void>;
  slotsChanged(): void;
  subscribe(listener: () => void): () => void;
};

export const importedThemePacksModel = replica({
  name: 'importedThemePacks',
  scope: 'device',
  read: async () => (await rpc.themePacks.imported()) as ThemePack[],
  fresh: Infinity,
});

/** What the boot script inserted before the first frame (preload's handover). */
const handedOverCss = typeof window === 'undefined' ? undefined : window.guguDeviceSettings?.handover?.themePackCss;

function changeFeed() {
  const changes = createSelectStore(0);
  return { changes, changed: () => { changes.publish(changes.get() + 1); changes.notify(); } };
}

function mainPackStore(): PackStore {
  const { changes, changed } = changeFeed();
  // Derived here like main did for the handover, so a choice lands in the frame of its light / dark switch. While the
  // slots name an imported pack not read yet, what is shown stays.
  let applied = handedOverCss;
  const derive = () => {
    const slots = devicePreferences.read('themePackSlots');
    const imported = importedThemePacksModel.peek();
    if (slots.state !== 'value') return;
    const named = [slots.value.light, slots.value.dark].filter((id): id is string => !!id);
    const builtinOnly = named.every((id) => BUILTIN_THEME_PACKS.some((pack) => pack.id === id));
    if (!builtinOnly && imported.state !== 'value') { void importedThemePacksModel.prefetch(); return; }
    const packs = imported.state === 'value' ? [...BUILTIN_THEME_PACKS, ...imported.value] : BUILTIN_THEME_PACKS;
    const css = slotsStylesheet(validThemePackSlots(slots.value, packs), packs);
    if (css === applied) return;
    applied = css;
    applyStylesheet(css);
    changed();
  };
  devicePreferences.subscribe(derive);
  importedThemePacksModel.subscribe([], derive);
  events.on(importedThemePacksChangedChannel, () => { void importedThemePacksModel.refresh(); });
  return {
    imported: () => importedThemePacksModel.peek(),
    useImported: () => useReplica(importedThemePacksModel, []),
    save: async (pack) => {
      importedThemePacksModel.at().set(await rpc.themePacks.saveImported(pack) as ThemePack[]);
      changed();
    },
    remove: async (id) => {
      importedThemePacksModel.at().set(await rpc.themePacks.removeImported(id) as ThemePack[]);
      changed();
    },
    slotsChanged: derive,
    subscribe: changes.subscribe,
  };
}

function localPackStore(storage: Storage | null): PackStore {
  const { changes, changed } = changeFeed();
  // Kept while what is stored stays the same: readers compare by identity.
  let imported: { raw: string | null; packs: ThemePack[]; reading: Reading<ThemePack[]> } | null = null;
  const stored = (): ThemePack[] => {
    const raw = storage?.getItem(PREFERENCE_STORAGE_KEYS.importedThemePacks) ?? null;
    if (!imported || imported.raw !== raw) {
      const packs = parseImportedThemePacks(raw, isThemePack) ?? [];
      imported = { raw, packs, reading: { state: 'value', value: packs, stale: false, error: null } };
    }
    return imported.packs;
  };
  const read = (): Reading<ThemePack[]> => {
    stored();
    return imported!.reading;
  };
  const write = (packs: ThemePack[]) => {
    storage?.setItem(PREFERENCE_STORAGE_KEYS.importedThemePacks, JSON.stringify(packs));
  };
  // Kept for the boot script's first paint (it has no main process to ask).
  const derive = () => {
    const slots = devicePreferences.read('themePackSlots');
    if (slots.state !== 'value') return;
    const packs = [...BUILTIN_THEME_PACKS, ...stored()];
    const css = slotsStylesheet(validThemePackSlots(slots.value, packs), packs);
    try {
      if (css) storage?.setItem(PREFERENCE_STORAGE_KEYS.themePackCss, css);
      else storage?.removeItem(PREFERENCE_STORAGE_KEYS.themePackCss);
    } catch (error) {
      log.error({ error: String(error) }, 'the theme stylesheet could not be kept for the next start');
    }
    applyStylesheet(css);
    changed();
  };
  derive();
  return {
    imported: read,
    useImported: () => useSelect(changes, () => read()),
    save: async (pack) => {
      write([...stored().filter((p) => p.id !== pack.id), pack]);
      derive();
    },
    remove: async (id) => {
      write(stored().filter((pack) => pack.id !== id));
      const slots = readThemePackSlots();
      if (slots.light === id || slots.dark === id) {
        const next = { ...slots };
        if (next.light === id) delete next.light;
        if (next.dark === id) delete next.dark;
        devicePreferences.write('themePackSlots', next);
      }
      derive();
    },
    slotsChanged: derive,
    subscribe: changes.subscribe,
  };
}

/** 把样式表插进(或更新)head 里那一个 style;空 = 咕咕默认。 */
function applyStylesheet(css: string): void {
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

const packStore: PackStore = devicePreferences.backend === 'appSettings'
  ? mainPackStore()
  : localPackStore(documentStorage());

export function findThemePack(id: string | undefined): ThemePack | undefined {
  if (!id) return undefined;
  const builtin = BUILTIN_THEME_PACKS.find((pack) => pack.id === id);
  if (builtin) return builtin;
  const imported = packStore.imported();
  if (imported.state !== 'value') throw new Error(`theme ${id}: the imported themes were not read yet`);
  return imported.value.find((pack) => pack.id === id);
}

export function readThemePackSlots(): ThemePackSlots {
  const reading = devicePreferences.read('themePackSlots');
  if (reading.state !== 'value') throw new Error('theme pack slots: not read yet');
  return reading.value;
}

function writeSlots(slots: ThemePackSlots): void {
  devicePreferences.write('themePackSlots', slots);
  packStore.slotsChanged();
}

/** `preference` null = it was not known when chosen: undoing leaves the preference alone. */
export type ThemePackChoice = { slots: ThemePackSlots; preference: ThemePreference | null };

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
  if (choice.preference !== null && readThemePreference() !== choice.preference) writeThemePreference(choice.preference);
}

/** 两种明暗都回到咕咕默认。 */
export function resetThemePacks(): void {
  writeSlots({});
}

export const saveImportedThemePack = (pack: ThemePack): Promise<void> => packStore.save(pack);
export const removeImportedThemePack = (id: string): Promise<void> => packStore.remove(id);

/** The terminal re-reads its colours then. */
export function subscribeToThemePacks(onChange: () => void): () => void {
  const offPacks = packStore.subscribe(onChange);
  const offSlots = devicePreferences.subscribe(onChange);
  return () => { offPacks(); offSlots(); };
}

export function useThemePackReading(): Reading<{ packs: ThemePack[]; slots: ThemePackSlots }> {
  const imported = packStore.useImported();
  const slots = useDevicePreference('themePackSlots');
  return useMemo(() => {
    if (imported.state !== 'value') return imported;
    if (slots.state !== 'value') return slots;
    const packs = [...BUILTIN_THEME_PACKS, ...imported.value];
    return { ...slots, value: { packs, slots: validThemePackSlots(slots.value, packs) as Partial<Record<ThemeMode, string>> } };
  }, [imported, slots]);
}
