// Caches every desktop once kept of its own projects per machine, now read from the account: removed at start.
/**
 * #113 之前每台桌面各记一份的那几样(各台机器的项目清单、主目录、群绑定、文件夹),换成账号上的那份之后不再读写:
 * 开机清掉,❌ 留着别的机器上的路径在这台电脑上。
 */
const RETIRED_PROJECT_CACHE_KEYS = [
  'gugu:machine-projects:v1',
  'gugu:machine-home-dirs:v1',
  'gugu.projectGroups.v1',
  'gugu.projectFolders.v1',
  // 项目与机器解耦:新建框不再按机器列「最近用过的文件夹」,项目页不再有多选的设备范围(「上次在哪台」记在账号上)。
  'gugu:remote-recent-folders:v1',
  'gugu.projectDeviceScope.v1',
] as const;

export function forgetRetiredProjectCaches(storage: Pick<Storage, 'removeItem'> | null): void {
  for (const key of RETIRED_PROJECT_CACHE_KEYS) {
    try {
      storage?.removeItem(key);
    } catch {
      /* 清不掉只是留着一份没人读的旧数据 */
    }
  }
}
