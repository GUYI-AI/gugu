import type { AccountProject } from '@gugu/core/cloud/deviceProjects';

/**
 * 账号上的项目(list_my_projects)上次读到的那份,按账号记着:开机 / 重载时先铺上,读到了再换成此刻的
 * (与设备列表的 devicesCache 同一条规矩:存的是上次已知,不是此刻的事实;换账号靠对名字,❌ 在「没登录」时清)。
 * 断网时重载窗口,项目区不至于一条不剩;那一刻读不到,各处照常画「读不到 + 重试」。
 */
const CACHE_KEY = 'gugu.account-projects.v1';

type Cached = { accountId: string; list: readonly AccountProject[] };

/** 这个账号上次那份;没有、是别的账号的(换了账号:那份随即删掉)、或形状不对 = []。可再生,❌ 迁移。 */
export function readCachedAccountProjects(accountId: string): AccountProject[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Cached>) : null;
    if (parsed && parsed.accountId !== accountId) localStorage.removeItem(CACHE_KEY);
    if (!parsed || parsed.accountId !== accountId || !Array.isArray(parsed.list)) return [];
    return (parsed.list as readonly unknown[]).flatMap((entry): AccountProject[] => {
      const project = entry as Partial<AccountProject> | null;
      if (!project || typeof project.chatId !== 'string' || !Array.isArray(project.bindings)) return [];
      // 上一版客户端存的那份没有 activeAt(它那时不读):照样铺上,时间是「还不知道」(null),下次读到即换成此刻的。
      if (project.activeAt === undefined) return [{ ...(project as AccountProject), activeAt: null }];
      return typeof project.activeAt === 'string' ? [project as AccountProject] : [];
    });
  } catch {
    return [];
  }
}

export function writeCachedAccountProjects(accountId: string, list: readonly AccountProject[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ accountId, list } satisfies Cached));
  } catch {
    /* 存不下只是回到「重载时先等一次往返」,不影响这一次读到的。 */
  }
}

/** 登出:这台电脑上不留上一个账号的项目(只一格,换账号时也随读随删,见上)。 */
export function forgetCachedAccountProjects(): void {
  localStorage.removeItem(CACHE_KEY);
}
