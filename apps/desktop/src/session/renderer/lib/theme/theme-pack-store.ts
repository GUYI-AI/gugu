/**
 * @@@theme-pack-slots — 主题选择的唯一真值,照 VS Code 的 preferredDark/LightColorTheme:两个槽位,
 * 「深色时用哪族」「浅色时用哪族」。明暗本身仍归 host-theme.ts(浅 / 深 / 跟随系统),两层互不吞并:
 *   - 选双模式主题:两个槽位一起填,明暗偏好不动(跟随系统照常跟);
 *   - 选单模式主题:只填它那一格;当下生效的是另一种明暗时顺手把偏好切过去 —— 点一下就要看得见(owner 11-07 拍板);
 *   - 槽位空 = 那种明暗用咕咕默认。
 *
 * 落地是一段样式表(`<style id="gugu-theme-pack">`),由槽位 + 主题清单推出来(shared/theme/theme-packs.ts 的 slotsStylesheet),
 * 只算不存。一个壳一份存储(lib/devicePreferences.ts 同一个选择):
 *   - 桌面:槽位 = app 设置 `themePackSlots`;导入的主题 = 主进程 userData 下的文件;样式表由主进程算好,首帧前经 preload
 *     交给 index.html 的引导脚本,之后跟着槽位 / 导入清单的变化再问主进程(下面两个 replica)。
 *   - web / 手机:槽位与导入的主题在 localStorage;样式表在页里算,顺手缓存一份给引导脚本首帧前插(它没有主进程可问)。
 * 只作用于这台电脑上的咕咕 —— 资源库别的格是分机器的,这一格不是。
 */
import { replica, useReplica, type Reading } from '@/lib/replica';
import { useMemo } from 'react';
import { createSelectStore, useSelect } from '@/lib/selectStore';
import { devicePreferences, documentStorage, useDevicePreference } from '@/lib/devicePreferences';
import { rendererLogger } from '@/lib/log';
import { events, rpc } from '@renderer/lib/ipc';
import { appSettingsChangedChannel, importedThemePacksChangedChannel } from '@shared/events/appEvents';
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

/** Where imported packs live and where the stylesheet comes from: one per shell. */
type PackStore = {
  imported(): Reading<ThemePack[]>;
  useImported(): Reading<ThemePack[]>;
  /** Import (or replace, same id) one pack. */
  save(pack: ThemePack): Promise<void>;
  /** Remove one; the store also empties a slot that named it. */
  remove(id: string): Promise<void>;
  /** The slots changed (this window or another): bring the stylesheet up to date. */
  slotsChanged(): void;
  subscribe(listener: () => void): () => void;
};

// ── desktop: main keeps the packs and derives the stylesheet ─────────────────────────────────────────────────────

/** This device's imported theme packs (main's file). Read when the library shows them or a choice needs them. */
export const importedThemePacksModel = replica({
  name: 'importedThemePacks',
  scope: 'device',
  read: async () => (await rpc.themePacks.imported()) as ThemePack[],
  fresh: Infinity,
});

const handedOverCss = typeof window === 'undefined' ? undefined : window.guguDeviceSettings?.handover?.themePackCss;

/** The stylesheet main derives from the stored slots; its first value is preload's handover (what the boot script inserted). */
export const themePackStylesheetModel = replica({
  name: 'themePackStylesheet',
  scope: 'device',
  read: async () => (await rpc.themePacks.stylesheet()) as string,
  fresh: Infinity,
  local: () => handedOverCss,
});

function mainPackStore(): PackStore {
  const changes = createSelectStore(0);
  const changed = () => { changes.publish(changes.get() + 1); changes.notify(); };
  // A slot or the imported list changed anywhere (this window's write comes back the same way): ask main again.
  events.on(appSettingsChangedChannel, ({ key }) => { if (key === 'themePackSlots') void themePackStylesheetModel.refresh(); });
  events.on(importedThemePacksChangedChannel, () => {
    void importedThemePacksModel.refresh();
    void themePackStylesheetModel.refresh();
  });
  // The stylesheet is applied whenever its value moves (DOM, a flow of a value in hand).
  let applied: string | undefined;
  const follow = () => {
    const reading = themePackStylesheetModel.peek();
    if (reading.state !== 'value' || reading.value === applied) return;
    applied = reading.value;
    applyStylesheet(reading.value);
    changed();
  };
  themePackStylesheetModel.subscribe([], follow);
  // Seeds from the handover at once (`local`) and asks main once more in the background.
  void themePackStylesheetModel.prefetch();
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
    // A choice in this window: the stylesheet is derived here at once (the same pure derivation main runs) and laid over
    // the stored one (I4), so it lands in the same frame as the light / dark switch — ❌ "new mode, old colours" until main
    // answers. Main's answer (asked again on its broadcast, above) confirms it. Only when the slots name an imported pack
    // this window has not read yet does it wait for main.
    slotsChanged: () => {
      const slots = devicePreferences.read('themePackSlots');
      const imported = importedThemePacksModel.peek();
      if (slots.state !== 'value') return;
      const named = [slots.value.light, slots.value.dark].filter((id): id is string => !!id);
      const builtinOnly = named.every((id) => BUILTIN_THEME_PACKS.some((pack) => pack.id === id));
      if (!builtinOnly && imported.state !== 'value') return;
      // Imported packs not read yet: the choice names built-in packs only (checked above), which is all it needs.
      const packs = imported.state === 'value' ? [...BUILTIN_THEME_PACKS, ...imported.value] : BUILTIN_THEME_PACKS;
      themePackStylesheetModel.set([], slotsStylesheet(validThemePackSlots(slots.value, packs), packs));
    },
    subscribe: changes.subscribe,
  };
}

// ── web / phone: localStorage ────────────────────────────────────────────────────────────────────────────────────

function localPackStore(storage: Storage | null): PackStore {
  const changes = createSelectStore(0);
  const changed = () => { changes.publish(changes.get() + 1); changes.notify(); };
  // Kept while what is stored stays the same: readers compare by identity.
  let imported: { raw: string | null; packs: ThemePack[]; reading: Reading<ThemePack[]> } | null = null;
  const stored = (): ThemePack[] => {
    const raw = storage?.getItem(PREFERENCE_STORAGE_KEYS.importedThemePacks) ?? null;
    if (!imported || imported.raw !== raw) {
      // Nothing stored (or not understood) = no imported packs on this device.
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
  /** Derive, apply, and keep the result for the boot script's first paint (it has no main process to ask). */
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

// ── this shell's store ───────────────────────────────────────────────────────────────────────────────────────────

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

/** The pack a choice names (a one-moment decision; the page that offers it has the list read). */
export function findThemePack(id: string | undefined): ThemePack | undefined {
  if (!id) return undefined;
  const builtin = BUILTIN_THEME_PACKS.find((pack) => pack.id === id);
  if (builtin) return builtin;
  const imported = packStore.imported();
  if (imported.state !== 'value') throw new Error(`theme ${id}: the imported themes were not read yet`);
  return imported.value.find((pack) => pack.id === id);
}

/** The slots now (a one-moment decision: a choice, an undo). Throws when they were never read. */
export function readThemePackSlots(): ThemePackSlots {
  const reading = devicePreferences.read('themePackSlots');
  if (reading.state !== 'value') throw new Error('theme pack slots: not read yet');
  return reading.value;
}

function writeSlots(slots: ThemePackSlots): void {
  devicePreferences.write('themePackSlots', slots);
  packStore.slotsChanged();
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

export async function saveImportedThemePack(pack: ThemePack): Promise<void> {
  await packStore.save(pack);
}

export async function removeImportedThemePack(id: string): Promise<void> {
  await packStore.remove(id);
}

/** The packs or the slots changed, or the stylesheet was applied anew (the terminal re-reads its colours then). */
export function subscribeToThemePacks(onChange: () => void): () => void {
  const offPacks = packStore.subscribe(onChange);
  const offSlots = devicePreferences.subscribe(onChange);
  return () => { offPacks(); offSlots(); };
}

/** 主题清单(内置在前、导入在后)与两个槽位,as a surface draws them. */
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
