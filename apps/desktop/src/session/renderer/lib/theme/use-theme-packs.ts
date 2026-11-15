import type { Reading } from '@/lib/replica';
import { useThemePackReading, type ThemePackSlots } from './theme-pack-store';
import type { ThemePack } from '@shared/theme/theme-packs';

/** 主题清单(内置在前、导入在后)与两个槽位;两个 React 根读的是同一份(这台设备的偏好 + 导入清单)。 */
export function useThemePacks(): Reading<{ packs: ThemePack[]; slots: ThemePackSlots }> {
  return useThemePackReading();
}

/** 设置里那一行:深色时、浅色时各用的是哪族(没选 = undefined,调用方写「咕咕默认」)。 */
export function useThemePackNames(): Reading<{ dark?: string; light?: string }> {
  const reading = useThemePacks();
  if (reading.state !== 'value') return reading;
  const name = (id: string | undefined) => reading.value.packs.find((pack) => pack.id === id)?.name;
  return { ...reading, value: { dark: name(reading.value.slots.dark), light: name(reading.value.slots.light) } };
}
