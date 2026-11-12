/**
 * 项目跨设备:账号上的一个项目在各台机器上各有一个本地项目(accountProjectsStore 的绑定)。这一个文件只回答
 * 「由哪一个本地项目来画这个项目」;一个本地项目属于哪个项目只读 accountProjectsStore。
 */
/** `machine` null = 这台电脑;`online` = 那台机器此刻连着(这台电脑恒在);`createdAt` = 那个本地项目建的时间(ISO)。 */
export type GroupLayoutProject = { id: string; machine: string | null; online?: boolean; createdAt?: string | null };

/**
 * 同群的几个本地项目并成一行时,由谁画这一行(桌面侧栏、手机「伙伴」与派任务那张卡同一条,每次算出来同一行):
 * 这台电脑上的 → 此刻连着的那台上的(❌ 指向一台离线的旧机器,如同一台机器重新登记后残留的设备行)→ 最早建的 → id。
 * 从前另有一个「代表」标记(机器自己记的),它不看在不在线,已去掉。
 */
export function groupRowOrder(a: GroupLayoutProject, b: GroupLayoutProject): number {
  const local = Number(a.machine !== null) - Number(b.machine !== null);
  if (local !== 0) return local;
  const online = Number(b.machine === null || b.online === true) - Number(a.machine === null || a.online === true);
  if (online !== 0) return online;
  const created = (a.createdAt || '\uffff').localeCompare(b.createdAt || '\uffff');
  if (created !== 0) return created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
