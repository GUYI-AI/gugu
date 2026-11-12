import { observable, runInAction } from 'mobx';

// #2548 ⑤ 内层栏可以收起(刘威提议稿 v1)。收钮在这一列头一行(笔的右边);收起后这一列让开,正文左上角浮出「展开内层栏」,
// 最左那条页签条给它让出车道 —— 和左边列表整列让开时那枚「展开侧栏」同一条车道(TabStripShell reserveShellRestoreLane)。
// 收起是一个全局的开关:换到别的群、项目、示例也收着,直到再展开(提议稿「全局记住」)。只记这一次运行:每次启动都是展开的,
// 同左边那个列表(layout-provider「默认展开」),所以 ❌ 进任何存储。展开钮上 ❌ 挂数:话题里叫到你的,记在左边群那一行的红数上。

/** 用户把内层栏收起来了。 */
export const innerSidebarFolded = observable.box(false);

/** 收起着,而此刻本该有这一列(挂在一个群 / 项目 / 示例上):展开钮这时才在。InnerSidebar 写。 */
export const innerSidebarFoldedAway = observable.box(false);

export function setInnerSidebarFolded(folded: boolean): void {
  runInAction(() => innerSidebarFolded.set(folded));
}

/**
 * 正文左上角此刻浮着一枚展开钮,那里那条页签条要给它让车道:左边列表整列让开(没有收起宽)时的「展开侧栏」,
 * 或内层栏收起时的「展开内层栏」。读 mobx,调用方是 observer。
 */
export function shellRestoreLaneTaken(isLeftOpen: boolean, leftRail: number): boolean {
  return (!isLeftOpen && leftRail === 0) || innerSidebarFoldedAway.get();
}
