import { useReplica } from '@/lib/replica';
import { rpcOn } from '@renderer/lib/ipc';
import { rendererLogger } from '@/lib/log';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type { HarnessCatalogState } from '@main/core/agents/harness-model-catalog';
import type { AgentModelCatalogAnswer } from '@main/core/agents/platform-model-catalog-hook';

/**
 * 四态**就是**主进程那份 —— 这里只做类型转出,❌ 不再手抄一份。
 *
 * 原来两侧各写各的:主进程 `harness-model-catalog.ts` 一份、这里一份,注释里写着「改一处必须
 * 同步另一处」。那句叮嘱没有任何执行力 —— 2026-08-26 给 `auth-required` 加 `efforts` /
 * `selectedEffort` 时就漏了这边,渲染层照旧当它没有这两格,`state.efforts is not iterable`
 * 直接把整个 composer 摔在渲染里(单测抓到,靠的还是测试自己把 state 标成 `unknown` 绕过类型)。
 *
 * ⚠️ **只**能是 `export type`:它在编译期就被抹掉,会话页 bundle 不会因此把宿主模块复制一份进来
 * (`extension-bridge-relay` 那个坑的成因)。同样的做法 `lib/ipc.ts` 已经在用(`RpcRouter`)。
 */
export type {
  HarnessCatalogLookup,
  HarnessCatalogState,
  HarnessModelChoice,
} from '@main/core/agents/harness-model-catalog';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { isAuthExpired, withAuthExpiry } from './harness-auth-expiry';
import { useAgentAuthStatus } from './use-agent-auth-status';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import { harnessModelCatalog } from './agent-replicas';

/**
 * 这家 harness 现在能跑哪些模型 —— 问 harness 自己(the `harnessModelCatalog` replica, agent-replicas.ts).
 *
 * 作废归主进程管(#7081);打开模型菜单时主动问一次(`refresh`),由宿主决定是否重探;要立刻重探走
 * `forceRefreshHarnessModelCatalog`(带 force)。
 */
function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || translateSessionMessage('composer.unknownError');
}

/**
 * 强制重读这一家的模型目录 —— **不订阅**它。
 *
 * 抽屉的「账号」行(#6100)只需要「登完之后让它作废」这一下:挂 `useHarnessModelCatalog`
 * 就会顺带**起一个 harness 进程**去探(2–3s),而打开任意一家的详情抽屉都会触发那一趟 ——
 * 一个纯粹为了拿到 `refresh` 而付的代价。⇒ 动作抽成函数,订阅留给真要显示模型的那些面。
 *
 * 带 force:主进程那边的 TTL 对「用户刚刚登完」这件事一无所知。主进程不等 harness,随即带 `refreshing: true`
 * 回来,真结果由订阅方那条轮询接走。问不到时这一条重读一次,读数自己说出为什么(❌ 编一个「不可用」的值塞进去)。
 */
export async function forceRefreshHarnessModelCatalog(
  providerId: string,
  /** 带 force 探哪条腿(#6246 目录按腿取);其余腿随后重问。 */
  leg: SessionpageLeg = 'acp',
  machine: string | null = null
): Promise<void> {
  const entry = harnessModelCatalog.at(providerId, leg, machine);
  try {
    entry.set((await rpcOn(machine).agents.modelCatalog(providerId, leg, true)) as AgentModelCatalogAnswer);
  } catch (error) {
    rendererLogger('agents/model-catalog').warn({ error, providerId, leg, machine }, 'forced model catalog refresh failed');
    await harnessModelCatalog.refresh(providerId, leg, machine);
    return;
  }
  // 另一条腿的那份也要重问(#6246):主进程对大多数家两条腿共用一份目录,这次 force 探的结果也属于它;
  // 渲染层不知道哪家共用,所以这一家在这台机器上的其余腿一律重问。
  const otherLegs = (['acp', 'tui'] as const).filter((other) => other !== leg);
  await Promise.all(otherLegs.map((other) => harnessModelCatalog.refresh(providerId, other, machine)));
}

export function useHarnessModelCatalog(
  providerId: string | null | undefined,
  /** 这份目录替哪条腿读(#6246):两条腿的配置根可能不同,清单也就可能不同。 */
  leg: SessionpageLeg
) {
  // #6264 会话 / 新建框在别的机器上:问那台机器的同一个控制器(一套工作台)。
  const host = useLibraryHost().remote;
  const machine = host?.deviceId ?? null;
  // 那台机器没连上就不问:问不到只会落一个「读取失败」,而那不是这家 agent 的问题;连上时自己重取。
  const args: [string, SessionpageLeg, typeof machine] | null = providerId && host?.online !== false ? [providerId, leg, machine] : null;
  const reading = useReplica(harnessModelCatalog, providerId ? [providerId, leg, machine] : null, { read: host?.online !== false });
  const probed: HarnessCatalogState = reading.state === 'value'
    ? reading.value.state
    : reading.state === 'error' ? { kind: 'unavailable', reason: errorReason(reading.error) } : { kind: 'unknown' };
  // #6264 目录探针判不出「登录已失效」,叠上那台机器的 worker 发布的那一格(只订阅,不探)。
  const { auth } = useAgentAuthStatus(providerId, undefined, { probe: false, machine });
  const state = withAuthExpiry(probed, isAuthExpired(auth));

  return {
    /** 还没探完时是 `unknown` —— 界面据此显示「读取中」，❌ 不显示「没有模型」。 */
    state,
    /** `state` is the catalog read before and its re-read failed: a surface says so beside it (❌ the old catalog as current). */
    refreshFailed: reading.state === 'value' ? reading.error : null,
    /** Opening the model menu asks the host once more (it decides whether to probe again); a read on its way is joined. */
    preparation: reading.state === 'value' && reading.value.refreshing ? reading.value.preparation : undefined,
    refresh: () => { if (args) void harnessModelCatalog.refresh(...args); },
    /** The person asked again after a failed read: past the main process's cache, on this list's machine and leg. */
    retry: () => { if (args) void forceRefreshHarnessModelCatalog(...args); },
    // 后台还在探也算「在读」—— 手上这份可能是陈的,调用方有权知道它还会变。
    isLoading: reading.state === 'unknown' || (reading.state === 'value' && reading.value.refreshing),
  };
}
