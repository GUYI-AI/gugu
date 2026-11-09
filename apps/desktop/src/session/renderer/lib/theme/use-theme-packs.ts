import { useMemo, useSyncExternalStore } from 'react';
import {
  allThemePacks,
  findThemePack,
  readThemePackSlots,
  subscribeToThemePacks,
  themePackSnapshot,
  type ThemePackSlots,
} from './theme-pack-store';
import type { ThemePack } from './theme-packs';

/** 主题清单(内置在前、导入在后)与两个槽位;两个 React 根读的是同一份 localStorage 与同一条通知链。 */
export function useThemePacks(): { packs: ThemePack[]; slots: ThemePackSlots } {
  const snapshot = useSyncExternalStore(subscribeToThemePacks, themePackSnapshot, themePackSnapshot);
  return useMemo(() => {
    void snapshot;
    return { packs: allThemePacks(), slots: readThemePackSlots() };
  }, [snapshot]);
}

/** 设置里那一行:深色时、浅色时各用的是哪族(没选 = undefined,调用方写「咕咕默认」)。 */
export function useThemePackNames(): { dark?: string; light?: string } {
  const { slots } = useThemePacks();
  return { dark: findThemePack(slots.dark)?.name, light: findThemePack(slots.light)?.name };
}
