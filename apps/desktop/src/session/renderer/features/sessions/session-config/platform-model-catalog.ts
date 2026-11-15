import { useEffect, useMemo } from 'react';
import { replica, useReplica } from '@/lib/replica';
import { platformModels } from '@/lib/agentModelReplicas';
import type { PlatformCatalogModel } from '@/lib/agentModelSelection';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { agentsMetadata } from '@renderer/lib/stores/agent-replicas';
import { platformWireProtocol } from '@gugu/session-plugins/agents/platform-protocols';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  offeredInModelPicker,
  parsePlatformReasoningEfforts,
  PLATFORM_MODELS_CHANGED_EVENT,
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  type PlatformModelOption,
  type PlatformModelProtocol,
} from '@shared/core/agents/platform-model';
// 深路径,理由同 platform-model.ts 抬头:总入口会把 node 依赖拖进浏览器包。
import { MODEL_ACCESS_PROTOCOL_IDS } from '@gugu/core/shared/agentModelSelection';
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';
import { guguCatalogReasonCode, guguCatalogReasonKind } from '@gugu/session-core/session-record/contract';
import { guguReasonCopy } from '@renderer/features/sessions/gugu-reason';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { platformModelIdFromRuntimeOption } from '@/session/shared/platform-model-id';

export type PlatformModelCatalog = {
  models: PlatformModelOption[];
  agentDefault: { modelId: string } | null;
  /** The explicit per-conversation composer decision, if this is a persisted conversation. */
  sessionSelection: { modelId: string } | null | undefined;
  /** 「为什么没有目录」的原因码(宿主报的,见 `GuguCatalogReason`);显示前过 `guguCatalogNotice`,❌ 原样上屏。 */
  catalogError: string | null;
};

export type PlatformModelCatalogState = PlatformModelCatalog & {
  /**
   * The catalog and what it rests on (the account's catalog, the engine's sessionpage integration on its machine, a
   * session's preselection) are read. While false, `models` is empty and means nothing: the model trigger holds its
   * place (`modelUnknown`), ❌ the harness route drawn and replaced.
   */
  known: boolean;
  /** Read in this run (not the last run's snapshot) without a failure: an empty list here proves no retirement. */
  settled: boolean;
  retry: () => void;
  /**
   * 重取一次,**不先清空**:会话记录刚被改过(热切后记录跟上,#6182)时用它 ——
   * 清空那一刻 `sessionSelection` 变回 undefined,菜单会把平台组撤掉、计费路退成 unknown/own。
   */
  refresh: () => void;
};

/**
 * 「不该取」的那份目录:宿主送来的回包形状不对(解析时)。「咕咕提供的模型」分组是**加法**:取不到只让这一组
 * 缺席,harness 自家模型照常可选。❌ 拿它当「还没读到」—— 那是 `known: false`。
 */
export const NO_PLATFORM_CATALOG: PlatformModelCatalog = {
  models: [],
  agentDefault: null,
  sessionSelection: undefined,
  catalogError: null,
};

/**
 * 目录经控制面取,一次网络往返。留足慢网的余量,又不让一个吊死的 handler 把分组永远卡在
 * 「还没到」——超时按取不到处理。
 */
const CATALOG_TIMEOUT_MS = 8_000;
/** 回到前台时重取目录的最短间隔:focus 与 visibilitychange 常常一前一后同时到,别为一次切窗取两遍。 */
const FOREGROUND_REFRESH_MIN_MS = 5_000;
/** A session's catalog entry (its preselection) is dropped this long after its last reader leaves. */
export const SESSION_CATALOG_GC_MS = 5 * 60_000;
/** 这一侧问宿主没问到(IPC 失败 / 超时)。 */
export const PLATFORM_CATALOG_RETRY_ERROR = guguCatalogReasonCode('host-not-ready');

/**
 * `catalogError` → 界面上那一句(按界面语言)+ 旁边给不给「重试」。
 * 认不出的串(老版本宿主送来的服务端英文原文)一律说「暂时用不了」,❌ 原样显示(#6264 真机:
 * `model access server is not configured` 铺进了新建任务的工具栏)。
 */
export function guguCatalogNotice(
  raw: string | null | undefined,
  translate: (key: SessionMessageKey) => string,
): { text: string; retryable: boolean } | null {
  const kind = guguCatalogReasonKind(raw);
  if (!kind) return null;
  const { copy, action } = guguReasonCopy(kind);
  return { text: translate(copy), retryable: action === 'retry' };
}

/**
 * 让列着的模型下拉一起重取目录(与设置「模型」页开关一条同一个信号)。
 * #7092「我开好了」:会员可能是在手机或别的窗口开的,回到这里未必有一次「回到前台」 ——
 * 不重取的话会话按会员模型起来了,下拉和输入框仍按免费档挡着。
 */
export function refreshPlatformModelCatalogs(): void {
  window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT));
}

// 运行时白名单**从协议表导出**,❌ 不再手抄一份。手抄那份漏一个新协议时不会报错,
// 只会让那个协议的模型被下面的 parseModel 静默丢掉 —— composer 里少几行、没有任何信号。
const PROTOCOLS: readonly PlatformModelProtocol[] = MODEL_ACCESS_PROTOCOL_IDS;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(translateSessionMessage('composer.platformCatalogTimeout'))), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function parseModel(value: unknown): PlatformModelOption | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { id, protocol } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol as PlatformModelProtocol)) {
    return null;
  }
  return {
    id,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
    protocol: protocol as PlatformModelProtocol,
    // 倍率是 display-only,坏值与缺失同义:省掉数字,不猜、也不拖累整条目录。
    creditMultiplier:
      typeof raw.creditMultiplier === 'number' && Number.isFinite(raw.creditMultiplier)
        ? raw.creditMultiplier
        : null,
    // 与倍率同一条纪律:**坏值与缺失同义**,省掉这一格而不是猜一个 —— 0 会被格式化成
    // `Context 0 tokens`,那是假信息,比没有更坏。
    contextWindow:
      typeof raw.contextWindow === 'number' && Number.isInteger(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : null,
    // 同一条纪律,但「坏值」与「空」要分开:`[]` 是目录的答案(没有这根轴),坏值是「不知道」⇒ null。
    reasoningEfforts: parsePlatformReasoningEfforts(raw.reasoningEfforts),
    // 只认 true:缺省(旧主进程)与坏值都按「不用会员」—— 门槛在网关,这一格判错只会标错、不会放行(#7056)。
    requiresMembership: raw.requiresMembership === true,
    // 同上:只认 true,旧主进程不带 ⇒ 没关。
    hidden: raw.hidden === true,
  };
}

/** 跨进程边界的响应按不可信处理:形状不对的条目丢掉,而不是让 composer 崩在一个空字段上。 */
export function parsePlatformModelCatalog(response: unknown): PlatformModelCatalog {
  if (typeof response !== 'object' || response === null) return NO_PLATFORM_CATALOG;
  const raw = response as Record<string, unknown>;
  const models = Array.isArray(raw.models)
    ? raw.models.map(parseModel).filter((model): model is PlatformModelOption => model !== null)
    : [];
  const agentDefault = raw.agentDefault;
  const defaultModelId =
    typeof agentDefault === 'object' &&
    agentDefault !== null &&
    typeof (agentDefault as Record<string, unknown>).modelId === 'string'
      ? ((agentDefault as Record<string, unknown>).modelId as string)
      : null;
  const knownModelIds = models.map((model) => model.id);
  const canonicalize = (modelId: string) =>
    platformModelIdFromRuntimeOption(modelId, knownModelIds) ?? modelId.trim();
  return {
    models,
    agentDefault: defaultModelId ? { modelId: canonicalize(defaultModelId) } : null,
    sessionSelection:
      Object.prototype.hasOwnProperty.call(raw, 'sessionSelection')
        ? (() => {
            const value = raw.sessionSelection;
            if (value === null) return null;
            if (typeof value !== 'object' || value === null) return undefined;
            const modelId = (value as Record<string, unknown>).modelId;
            return typeof modelId === 'string' && modelId.trim()
              ? { modelId: canonicalize(modelId) }
              : undefined;
          })()
        : undefined,
    catalogError:
      typeof raw.catalogError === 'string' && raw.catalogError.trim() ? raw.catalogError : null,
  };
}

export async function fetchPlatformModelCatalog(
  providerId: string,
  surface: SessionpageSessionSurface,
  /** 已存在的会话;新建时没有,agentDefault 便为空。 */
  sessionId?: string | null,
  /** #6264 新建框选的机器(会话已存在时按会话所在机器);null = 本机。 */
  machine: string | null = sessionId ? machineRegistry.machineOf(sessionId) : null
): Promise<PlatformModelCatalog> {
  const response = await withTimeout(
    invokeOnMachine(machine, SESSIONPAGE_PLATFORM_CATALOG_CHANNEL, { providerId, surface, sessionId }),
    CATALOG_TIMEOUT_MS
  );
  return parsePlatformModelCatalog(response);
}

/**
 * A session's platform preselection, as the machine it runs on answers: the agent's default and the explicit composer
 * decision recorded for this conversation (#6182). Only these two of the host's answer are read: the models themselves
 * are the account's catalog (`platformModels`), derived per engine below — ❌ a second catalog per surface and machine.
 */
export const sessionPlatformSelection = replica({
  name: 'sessionPlatformSelection',
  scope: 'account',
  read: async (_owner, sessionId: string, providerId: string, surface: SessionpageSessionSurface, machine: string | null) => {
    const { agentDefault, sessionSelection } = await fetchPlatformModelCatalog(providerId, surface, sessionId, machine);
    return { agentDefault, sessionSelection };
  },
  // Changes by a hot switch on this composer (`refresh`), or a models-changed signal.
  fresh: Infinity,
  // Viewing sessions does not grow the cache forever: an entry nobody shows leaves after a while.
  keep: SESSION_CATALOG_GC_MS,
});

/**
 * Why the Gugu group is absent for this engine and leg, by the engine's own declarations (the same facts the host's gate
 * reads, sessionpage-platform-catalog.ts): no wire protocol = it cannot be pointed at the relay; no addressable identity
 * with a message transport on this leg = a platform token cannot be issued for it.
 */
function gateReason(providerId: string, surface: SessionpageSessionSurface, agent: AgentPayload | undefined): string | null {
  if (!platformWireProtocol(providerId)) return guguCatalogReasonCode('not-routable');
  const integration = agent?.capabilities.sessionpage?.[surface];
  if (!integration || integration.identity !== 'addressable' || integration.messageTransport === 'none') {
    return guguCatalogReasonCode(surface === 'acp' ? 'no-identity-chat' : 'no-identity-terminal');
  }
  return null;
}

/** The account's catalog as one engine sees it: enabled models of its protocol, its multiplier and levels. */
export function platformModelsFor(providerId: string, catalog: readonly PlatformCatalogModel[]): PlatformModelOption[] {
  const protocol = platformWireProtocol(providerId) as PlatformModelProtocol | null;
  if (!protocol || !PROTOCOLS.includes(protocol)) return [];
  return catalog
    .filter((model) => model.enabled && model.protocols.includes(protocol))
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      protocol,
      creditMultiplier: model.creditMultipliers[protocol] ?? null,
      contextWindow: model.contextWindow ?? null,
      reasoningEfforts: model.reasoningEfforts,
      requiresMembership: model.requiresMembership,
      hidden: model.hidden,
    }));
}

// The catalog's pushes, one subscription however many composers show it: a models-changed signal (settings → Model,
// "I joined" #7092) and the window coming back (#7056: membership is bought on the web; no push reaches here).
let watchers = 0;
let stopWatching: (() => void) | null = null;
function watchCatalog(): () => void {
  if (watchers++ === 0) {
    const refreshAll = () => {
      void platformModels.refresh();
      void sessionPlatformSelection.refresh();
    };
    let lastAt = Date.now();
    const onForeground = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastAt < FOREGROUND_REFRESH_MIN_MS) return;
      lastAt = now;
      refreshAll();
    };
    window.addEventListener(PLATFORM_MODELS_CHANGED_EVENT, refreshAll);
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    stopWatching = () => {
      window.removeEventListener(PLATFORM_MODELS_CHANGED_EVENT, refreshAll);
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }
  return () => {
    if (--watchers > 0) return;
    stopWatching?.();
    stopWatching = null;
  };
}

/**
 * 当前 provider 的平台模型目录。providerId 为 null(未选 agent,或调用方关掉了平台分组)时什么都不读。
 *
 * Derived, not read per surface: the account's catalog (`platformModels`, kept across restarts, so a New task draws the
 * Gugu group in its first frame), filtered to the engine's protocol and gated by its sessionpage integration on the
 * machine; a session adds its preselection (`sessionPlatformSelection`). A machine that is not connected is not asked
 * (its last answers stay); when it connects, what is stale is asked again.
 */
export function usePlatformModelCatalog(
  providerId: string | null,
  surface: SessionpageSessionSurface,
  sessionId?: string | null
): PlatformModelCatalogState {
  // #6264 会话 / 新建框在别的机器上:那台机器上这家的会话腿(身份、消息通道)由那台机器的名单说。
  const host = useLibraryHost().remote;
  const hostMachine = host?.deviceId ?? null;
  const machine = sessionId ? machineRegistry.machineOf(sessionId) : hostMachine;
  const online = machine === null || machine !== hostMachine || host?.online !== false;
  const catalog = useReplica(platformModels, providerId ? [] : null);
  const agents = useReplica(agentsMetadata, providerId ? [machine] : null, { read: online });
  const selection = useReplica(sessionPlatformSelection, providerId && sessionId ? [sessionId, providerId, surface, machine] : null, { read: online });
  useEffect(watchCatalog, []);

  const agent = agents.state === 'value' ? agents.value.find((entry) => entry.id === providerId) : undefined;
  const gate = providerId && agents.state === 'value' ? gateReason(providerId, surface, agent) : null;
  const models = useMemo(
    () => (providerId && catalog.state === 'value' && !gate ? platformModelsFor(providerId, catalog.value) : []),
    [providerId, catalog, gate]
  );
  const refresh = () => {
    void platformModels.refresh();
    if (providerId && sessionId) void sessionPlatformSelection.refresh(sessionId, providerId, surface, machine);
  };
  const known = !providerId || (catalog.state !== 'unknown' && agents.state !== 'unknown' && (!sessionId || selection.state !== 'unknown'));
  // The catalog or the session's preselection could not be read: said with a retry (the group stays absent meanwhile).
  const failed = catalog.state === 'error' || (catalog.state === 'value' && catalog.error !== null) || selection.state === 'error';
  const catalogError = gate ?? (failed ? PLATFORM_CATALOG_RETRY_ERROR : null);
  // An offered default must be a row the picker lists (as the host's gate requires).
  const agentDefault = selection.state === 'value' && selection.value.agentDefault
    && models.some((model) => model.id === selection.value.agentDefault!.modelId && offeredInModelPicker(model))
    ? selection.value.agentDefault : null;
  return {
    // @@@reading-default - while `known` is false the list means nothing: every surface drawing it gates on `known`
    models: known ? models : [],
    agentDefault,
    sessionSelection: selection.state === 'value' ? selection.value.sessionSelection : undefined,
    catalogError,
    known,
    settled: known && online && catalog.state === 'value' && !catalog.stale && !failed,
    retry: refresh,
    refresh,
  };
}
