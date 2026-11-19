import { readSidebarChatSignals, subscribeSidebarChatSignals } from '@/lib/sidebarChatsBridge';

/**
 * #2569 示例变成的那个群在左侧列表里有没有一行:聊天列表(壳发过来的 listedGroups)里有它。示例那一行、那一块让不让位,
 * 只看这个(use-sample-project),❌ 看变成群走到了哪一步。聊天列表还没读到 = 没有。
 */
export function groupRowShown(chatId: string, listedGroups: ReadonlySet<string> | null): boolean {
  return listedGroups !== null && listedGroups.has(chatId);
}

/**
 * 这个群的那一行一画出来就调 `open`(打开群、交出这一句),和画它的是同一次更新:壳换了一份聊天列表(同步通知),在两棵树按新数据
 * 重画之前 —— 示例让位、群那一行出现、群打开,落在同一次绘制里(#2589)。
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
    const timer = setTimeout(() => finish(() => resolve(false)), waitMs);
    stops.push(() => clearTimeout(timer));
    check();
  });
}
