import { reaction } from 'mobx';
import { useEffect, useSyncExternalStore } from 'react';
import type { SupportedLocale } from '@/i18n/locale';
import { readSampleProject, subscribeSampleProject } from '@/lib/sampleProject';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { log } from '@renderer/utils/logger';
import { sampleConversion } from './sample-conversion';
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

subscribeSampleProject((userId) => { if (reading?.userId === userId) load(userId); });
// 别的窗口、别的电脑上把示例变成了项目:那个项目一进项目表(它那一行出现),这里重读键 —— 键上记着它,示例就让给它,❌ 两行都在。
reaction(() => accountProjectsStore.projects, () => { if (reading?.shown) load(reading.userId); });

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type SampleProjectOwner = { id: string; name: string; avatarUrl: string | null };

/**
 * 示例已经让给了它变成的那个项目:那个项目在项目表里了(侧栏里有它那一行)。这个窗口正在变、或变到一半停下了(框下写着原因,
 * 话还在示例的框里)的时候,只认这里自己交出去的那一刻(打开项目、交出这一句),❌ 先按键上记着的让 —— 那一块会先收掉、
 * 再打开项目,中间闪一下别的;停下了的,话就跟着那一块看不见了。
 */
function givenWay(keyBecame: string | null): boolean {
  const mine = sampleConversion.status === 'working' || sampleConversion.failure !== null;
  const became = mine ? sampleConversion.chatId : sampleConversion.chatId ?? keyBecame;
  return became !== null && accountProjectsStore.project(became) !== undefined;
}

/**
 * `shown` = 键在、没删,也还没让给它变成的项目(#2569);`settled` = 这个账号的键读完了(读完是 hidden 的,屏上留着的那一块收掉)。
 * 主人(对话里「你」那一方)用他自己的名字和头像,壳经 assistant-shell 那条桥交过来(这棵树里没有登录态)。
 * 调用方是 observer:让没让读的是 mobx 里的项目表。
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
  const mine = !!userId && current?.userId === userId;
  return {
    shown: mine && current.shown === true && !givenWay(current.became),
    settled: mine && current.shown !== null,
    owner: userId ? { id: userId, name: shell?.ownerName ?? '', avatarUrl: shell?.ownerAvatar ?? null } : null,
  };
}
