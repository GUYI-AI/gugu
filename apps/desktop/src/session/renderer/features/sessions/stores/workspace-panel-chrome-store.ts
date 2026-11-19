import { action, makeObservable, observable } from 'mobx';
import { readInterface, takeLegacyInterface, writeInterface } from '@/lib/viewStateTable';

/**
 * 还没建任务的页面(新建会话的草稿页、项目首页)右边那块面板的开合:整个 app 一份,重启也记得。
 *
 * 会话页没有这块面板了(#7052 一屏几块:对话是会话的第一枚页签,审阅、终端、浏览器、文件与它排在同一条页签条上),
 * 所以也没有全屏 —— 想让一格占满就把别的格关掉或拖开。
 *
 * 第一次装好默认收起(先把注意力留给输入框),之后以用户上一次的操作为准。
 */
const STORAGE_KEY = 'gugu.workspace-panel-chrome.v1';
// View state of the device (lib/viewStateTable). Kept in localStorage before as `{ collapsed }` (older ones also stored a
// maximized state the session page no longer has: not carried).
takeLegacyInterface(STORAGE_KEY, STORAGE_KEY, (raw) => {
  const collapsed = (JSON.parse(raw) as { collapsed?: unknown }).collapsed;
  return typeof collapsed === 'boolean' ? collapsed : undefined;
});

class WorkspacePanelChromeStore {
  collapsed = true;

  constructor() {
    makeObservable(this, {
      collapsed: observable,
      setCollapsed: action,
    });
    this.load();
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.save();
  }

  private load(): void {
    const stored = readInterface<boolean>(STORAGE_KEY);
    if (typeof stored === 'boolean') this.collapsed = stored;
  }

  private save(): void {
    writeInterface(STORAGE_KEY, this.collapsed);
  }
}

/** 只给判据用:每个用例一份新的,读同一个视图状态条目。 */
export function createWorkspacePanelChromeStoreForTests(): WorkspacePanelChromeStore {
  return new WorkspacePanelChromeStore();
}

export const workspacePanelChromeStore = new WorkspacePanelChromeStore();

/**
 * 禅模式的「右半边」= 草稿页那块面板(#6754),收放的是上面这份 app 级开合本身 —— 进禅模式记下原值、出来原样写回。
 * 会话页上没有这块面板,禅模式在那里只收左边。
 */
export function zenFilePanel(): { isCollapsed: boolean; setCollapsed: (collapsed: boolean) => void } {
  return {
    isCollapsed: workspacePanelChromeStore.collapsed,
    setCollapsed: (collapsed) => workspacePanelChromeStore.setCollapsed(collapsed),
  };
}
