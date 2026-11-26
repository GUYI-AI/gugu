/**
 * ⌘W / 菜单「关闭」该交给谁。主窗的渲染层(会话页的 AppMenuEvents)认领了「关闭」才交给它 —— 由它按快捷键登记
 * 决定先关 sheet、页签还是窗口;没人认领(登录页、渲染进程崩了或正在重载、还在启动)就照原样直接关窗,
 * ❌ 让 ⌘W 落空。认领按 webContents 记:那一页换掉文档、进程退出或被销毁时由 main.ts 撤掉。
 */
export function createMenuCloseRouting() {
  const claimed = new Set<number>();
  return {
    claim(contentsId: number, handles: boolean): void {
      if (handles) claimed.add(contentsId);
      else claimed.delete(contentsId);
    },
    release(contentsId: number): void {
      claimed.delete(contentsId);
    },
    /** `send` asks the claiming renderer to resolve ⌘W; `close` closes the window itself. */
    route(window: object | undefined, main: { webContents: { id: number } } | null, send: () => void, close: () => void): 'renderer' | 'closed' {
      if (window && main && window === main && claimed.has(main.webContents.id)) {
        send();
        return 'renderer';
      }
      close();
      return 'closed';
    },
  };
}
