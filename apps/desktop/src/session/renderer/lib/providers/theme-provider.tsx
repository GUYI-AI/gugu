import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { applyThemeToAll } from '@renderer/lib/pty/pty';
import {
  nextHostTheme,
  readHostTheme,
  readThemePreference,
  startHostThemeSystemSync,
  subscribeToHostTheme,
  subscribeToThemePreference,
  writeHostTheme,
  writeThemePreference,
  type EffectiveTheme,
  type ThemePreference,
} from '@renderer/lib/theme/host-theme';
import type { Theme } from '@shared/core/app-settings';
import { ThemeContext } from './theme-context';

/**
 * 会话页自身的 CSS(session-ui 的 theme registry、chat-ui 的 theme.css.ts、代码高亮器)按
 * `.emlight` / `.emdark` 取色阶 —— 这个类是咕咕主题的投影,不是另一份独立状态。真值与理由见
 * `lib/theme/host-theme.ts`。
 * 嵌在咕咕里时,类在会话页自己的挂载元素上(EmdashSessionFrame 随咕咕主题同步),❌ 打到 `<html>`:
 * 那样会话页的 `--border` 等同名变量会落到整个咕咕,谁赢只看样式表先后。只有独立打开时才挂在根上。
 */
function applyTheme(effective: EffectiveTheme) {
  if (typeof document === 'undefined' || window.__EMDASH_MOUNT__) return;
  const root = document.documentElement;
  root.classList.remove('emlight', 'emdark');
  root.classList.add(effective);
}



export function ThemeProvider({ children }: { children: ReactNode }) {
  const effectiveTheme = useSyncExternalStore(subscribeToHostTheme, readHostTheme, readHostTheme);
  const preference = useSyncExternalStore(
    subscribeToThemePreference,
    readThemePreference,
    readThemePreference,
  );

  useLayoutEffect(() => {
    applyTheme(effectiveTheme);
  }, [effectiveTheme]);

  // Re-apply xterm theme after CSS classes have been updated by the layout effect above.
  useEffect(() => {
    applyThemeToAll();
  }, [effectiveTheme]);

  // @@@5293 会话页可以自己开着(独立 React 根),所以它也要认领一份「跟随系统」的同步;
  // host-theme 里按引用计数做成幂等,与咕咕那份不会重复挂监听。
  useEffect(() => startHostThemeSystemSync(), []);

  // 真值仍是二态 —— 第三态在**偏好**那一层,不在这里。
  const setTheme = (next: Theme) => {
    if (next) writeHostTheme(next);
  };

  const setPreference = (next: ThemePreference) => {
    writeThemePreference(next);
  };

  const toggleTheme = () => {
    writeHostTheme(nextHostTheme(effectiveTheme));
  };

  return (
    <ThemeContext.Provider
      value={{ theme: effectiveTheme, setTheme, toggleTheme, effectiveTheme, preference, setPreference }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
