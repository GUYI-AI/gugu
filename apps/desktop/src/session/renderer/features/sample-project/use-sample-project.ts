import { comparer, reaction } from 'mobx';
import { useEffect, useSyncExternalStore } from 'react';
import type { SupportedLocale } from '@/i18n/locale';
import { dismissSampleProject, readSampleProject, subscribeSampleProject } from '@/lib/sampleProject';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { log } from '@renderer/utils/logger';
import { sampleConversionOf } from './sample-conversion';
import { groupRowShown } from './sample-group-row';
import { enUSSampleProject } from './content/en-US';
import type { SampleProjectContent } from './content/types';
import { zhCNSampleProject } from './content/zh-CN';

const CONTENT: Record<SupportedLocale, SampleProjectContent> = { 'zh-CN': zhCNSampleProject, 'en-US': enUSSampleProject };

/** 示例项目跟着界面语言换一份(它是预先写好的内容,❌ 存在账号上)。 */
export function sampleProjectContent(locale: SupportedLocale): SampleProjectContent {
  return CONTENT[locale];
}

// 这个账号看不看得到示例项目:账号上那一个键(lib/sampleProject)。侧栏那一行和那一块挂着时读同一份;
// 走完首次引导那一刻(主界面早已挂在引导下面)写上键,这里跟着重读。
// 读不到 ≠ 没有:那一行先不出现,屏上留着的那一块也不收(收了就存进布局、下次也没了),过一会儿再读。
// 再读的时候手上那一份照旧算数(❌ 先当成不知道:那一行会闪没一下)。
// `became` = #2569 示例已经变成的那个项目的群(键上记着的)。
type Reading = { userId: string; shown: boolean | null; became: string | null };
let reading: Reading | null = null;
let readers = 0;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = [5_000, 30_000, 120_000, 300_000];
const listeners = new Set<() => void>();

function publish(next: Reading | null): void {
  reading = next;
  for (const listener of listeners) listener();
  settleBecome();
}

function load(userId: string, attempt = 0): void {
  const request = ++generation;
  if (retry) clearTimeout(retry);
  retry = null;
  if (reading?.userId !== userId) publish({ userId, shown: null, became: null });
  readSampleProject(userId).then(
    (state) => {
      if (request !== generation || reading?.userId !== userId) return;
      publish({ userId, shown: state !== null && !state.dismissed, became: state?.version === 2 ? state.chatId ?? null : null });
    },
    (error: unknown) => {
      log.error('[sample-project] reading the account key failed', { error: String(error), attempt });
      if (request !== generation || reading?.userId !== userId) return;
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      retry = setTimeout(() => { if (request === generation && reading?.userId === userId) load(userId, attempt + 1); }, wait);
    },
  );
}

/**
 * #2569 示例变成的那个项目已经在项目表里了,键上却还没删(交出去那一下删失败了、交出去之前窗口重载了、别的窗口交出去的):
 * 这里补删,❌ 只靠交出去那一下。这个窗口正在变、或变到一半停下了(话还在示例的框里,等他再按):不删,让它自己走完。
 */
let settling: string | null = null;
function settleBecome(): void {
  const current = reading;
  if (!current?.shown || !current.became || settling === current.userId) return;
  if (accountProjectsStore.project(current.became) === undefined) return;
  const run = sampleConversionOf(current.userId);
  if (run.status === 'working' || run.failure !== null) return;
  const { userId } = current;
  settling = userId;
  dismissSampleProject(userId).then(
    () => { if (settling === userId) settling = null; },
    (error: unknown) => {
      if (settling === userId) settling = null;
      log.error('[sample-project] dismissing the sample that already became a project failed', { error: String(error) });
    },
  );
}

subscribeSampleProject((userId) => { if (reading?.userId === userId) load(userId); });
// 别的窗口、别的电脑上把示例变成了项目:那个项目一进项目表(多出一个群),这里重读键 —— 键上记着它,示例就让给它,❌ 两行都在。
// 只在项目表多出群、键上还没记着它变成了哪个的时候读;❌ 项目表每变一次(改名、换绑定)都去账号上读一次。
reaction(
  () => accountProjectsStore.projects.map((project) => project.chatId),
  (chatIds, before) => {
    const known = new Set(before);
    if (reading?.shown && reading.became === null && chatIds.some((chatId) => !known.has(chatId))) load(reading.userId);
    settleBecome();
  },
  { equals: comparer.structural },
);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type SampleProjectOwner = { id: string; name: string; avatarUrl: string | null };

/**
 * 示例已经让给了它变成的那个项目:那个项目的群在左侧列表里有一行了 —— 和画那一行用的是同两份数据(聊天列表、账号的项目表),
 * 所以示例那一行消失和项目那一行出现在同一次绘制里(#2589:❌ 一刻两行都在,❌ 一刻两行都不在)。这个窗口在变的,认它建好的群
 * (建好就知道,赶在账号上记好之前);它那一行出现的同一次更新里,项目也打开了(sample-conversion)。
 * 变到一半停下了(框下写着原因,话还在示例的框里):不让 —— 让了,话和原因就跟着那一块看不见了;再按发送就交出去。
 */
function givenWay(userId: string, keyBecame: string | null, listedGroups: ReadonlySet<string> | null): boolean {
  const run = sampleConversionOf(userId);
  if (run.failure !== null) return false;
  if (run.chatId !== null) return groupRowShown(run.chatId, listedGroups);
  if (run.status !== 'idle') return false;
  return keyBecame !== null && groupRowShown(keyBecame, listedGroups);
}

/**
 * `shown` = 键在、没删,也还没让给它变成的项目(#2569);`settled` = 这个账号的键读完了(读完是 hidden 的,屏上留着的那一块收掉)。
 * 主人(对话里「你」那一方)用他自己的名字和头像,壳经 assistant-shell 那条桥交过来(这棵树里没有登录态)。
 * 调用方是 observer:让没让读的有 mobx 里的项目表(另一份聊天列表经壳的通知读)。
 */
export function useSampleProject(): { shown: boolean; settled: boolean; owner: SampleProjectOwner | null } {
  const shell = useAssistantShell();
  const userId = shell?.ownerId ?? null;
  useEffect(() => {
    if (!userId) return;
    readers++;
    if (readers === 1 || reading?.userId !== userId) load(userId);
    return () => {
      if (--readers !== 0) return;
      // Sign-out unmounts the account tree. The same account signing back in
      // must read its persisted choice, and old in-flight responses lose ownership.
      generation++;
      if (retry) clearTimeout(retry);
      retry = null;
      publish(null);
    };
  }, [userId]);
  const current = useSyncExternalStore(subscribe, () => reading);
  const listedGroups = useSidebarChatSignals()?.listedGroups ?? null;
  const mine = !!userId && current?.userId === userId;
  return {
    shown: mine && current.shown === true && !givenWay(userId, current.became, listedGroups),
    settled: mine && current.shown !== null,
    owner: userId ? { id: userId, name: shell?.ownerName ?? '', avatarUrl: shell?.ownerAvatar ?? null } : null,
  };
}
