import { reaction } from 'mobx';
import { readSidebarChatSignals, subscribeSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { groupHasRow } from '@/lib/sidebarOneList';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';

/**
 * #2569 示例变成的那个项目的群在左侧列表里有没有一行:和 SidebarOneList 画行用的是同两份 —— 聊天列表(壳发过来的 listedGroups),
 * 和账号上还没进聊天列表的项目(没归档的)。示例那一行、那一块让不让位,只看这个(use-sample-project),❌ 看变成项目走到了哪一步。
 */
export function groupRowShown(chatId: string, listedGroups: ReadonlySet<string> | null): boolean {
  return groupHasRow(chatId, accountProjectsStore.projects.filter((project) => !project.archived), listedGroups);
}

/**
 * 这个群的那一行一画出来就调 `open`(打开项目、交出这一句),和画它的是同一次更新:壳换了一份聊天列表(同步通知),或账号的项目表变了
 * (mobx reaction),都在两棵树按新数据重画之前 —— 示例让位、项目那一行出现、项目打开,落在同一次绘制里(#2589)。
 * 已经画出来了就当场调。等不到(`waitMs` 内没出现)= false;`open` 抛的原样抛出。
 */
export function whenGroupRowShown(chatId: string, open: () => void, waitMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const shown = () => groupRowShown(chatId, readSidebarChatSignals()?.listedGroups ?? null);
    let done = false;
    const stops: (() => void)[] = [];
    const finish = (then: () => void) => {
      if (done) return;
      done = true;
      for (const stop of stops) stop();
      then();
    };
    const check = () => {
      if (done || !shown()) return;
      finish(() => {
        try {
          open();
          resolve(true);
        } catch (error) {
          reject(error);
        }
      });
    };
    stops.push(subscribeSidebarChatSignals(check));
    stops.push(reaction(shown, (now) => { if (now) check(); }));
    const timer = setTimeout(() => finish(() => resolve(false)), waitMs);
    stops.push(() => clearTimeout(timer));
    check();
  });
}
