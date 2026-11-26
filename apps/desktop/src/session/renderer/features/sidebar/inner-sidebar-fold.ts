import { observable, runInAction } from 'mobx';
import { setSidebarFold, sidebarFolds } from './sidebar-folds';

// #2548 ⑤ 内层栏可以收起(刘威提议稿 v1)。收钮在这一列头一行(笔的右边);收起后这一列让开,正文左上角浮出「展开内层栏」,
// 最左那条页签条给它让出车道 —— 和左边列表整列让开时那枚「展开侧栏」同一条车道(TabStripShell reserveShellRestoreLane)。
// 收起是一个全局的开关:换到别的群、项目、示例也收着,直到再展开(提议稿「全局记住」)。重启、更新后照样收着(owner 11-14),
// 同左边那个列表:都记在侧栏那份快照里(sidebar-folds)。展开钮上 ❌ 挂数:话题里叫到你的,记在左边群那一行的红数上。

/**
 * 窗口窄到正文放不下时(useInnerSidebarCrowded),这一列也收着,但 ❌ 改用户记下的那个开关:窗口宽回来它就回来。
 * 挤着的时候按展开钮,这一列照样展开,直到窗口宽回来或再收起。
 */
const crowded = observable.box(false);
const openedWhileCrowded = observable.box(false);

/** 内层栏此刻收着:用户收起的,或窗口挤得收起的。 */
export const innerSidebarFolded = {
  get: (): boolean => sidebarFolds.has('inner') || (crowded.get() && !openedWhileCrowded.get()),
};

export function setInnerSidebarCrowded(value: boolean): void {
  runInAction(() => {
    crowded.set(value);
    if (!value) openedWhileCrowded.set(false);
  });
}

/**
 * 此刻有这一列(挂在一个群 / 项目 / 示例上),收起或展开都算:它的开关钮这时在正文左上角(owner 11-26:收起和展开同一个位置,
 * 这一列右边、消息流左上角、群 title 行左侧)。InnerSidebar 写。
 */
export const innerSidebarAttached = observable.box(false);

export function setInnerSidebarFolded(folded: boolean): void {
  if (!crowded.get()) return setSidebarFold('inner', folded);
  runInAction(() => openedWhileCrowded.set(!folded));
  if (!folded) setSidebarFold('inner', false);
}

/**
 * 正文左上角此刻浮着这一列的开关钮,那里那条页签条要给它让车道:有内层栏时,收起和展开都在(左边列表收起成一列头像,
 * 从不整列让开,所以没有「展开侧栏」那一枚)。读 mobx,调用方是 observer。
 */
export function shellRestoreLaneTaken(): boolean {
  return innerSidebarAttached.get();
}
