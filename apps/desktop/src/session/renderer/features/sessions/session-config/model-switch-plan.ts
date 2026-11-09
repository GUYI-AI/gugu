import type { LiveSettingCapability } from '@gugu/session-core/agents/plugins';
import { runtimeOptionForPlatformModelId } from '@/session/shared/platform-model-id';
import type { ComposerModelSelection } from './use-composer-model-options';

/**
 * 会话内换模型:**这一条能不能当场换**。
 *
 * 抽成纯函数而不是写进 JSX 的条件里,理由与 `resolveComposerModelPanel` 一样 —— 组件测在
 * worktree 里跑不动,写在 JSX 里的判断没有任何判据会红。而这条判断错了的后果是用户面的:
 * 要么把一次需要重开会话的切换当成即时切换(界面说换好了,实际还是旧模型),
 * 要么把一次本可即时的切换弄成重开会话(白白打断他正在跑的那一轮)。
 *
 * ## 判据只有一条,而且它是**运行时事实**,不是我们算出来的
 *
 * `advertised` = 这条活会话的 ACP 报上来的模型清单(`acp-chat-store.modelOptions` 的键)。
 * BYOK 会话仍以它为热切判据:适配器只接受自己在 `session/new` 报过的值(claude / codex /
 * opencode 逐家读源码 + 实测确认,不在清单里一律拒)。平台会话同样以它为判据:进程手里的
 * allowlist 是**签票那一刻**按会员档算的可切清单(`session/new` 前注入,之后学不到新的),
 * 而目录跟着账号当下的档走 —— 会话开在免费档、中途开了会员,目录里就多出进程从没收到过的模型。
 *
 * ⇒ **同一条平台计费路 + 目录里有它 + 活会话报得出它 = 当场换**;目录有、活会话没报 = 这条进程
 * 说不了它,走 `reload`(按当下的档重签票、重开进程),与跨计费路同一条路。
 * 启动注入真漏了模型也不会被这一步盖住:重开后的模型断言(`applyInitialModel`)照样响亮地报。
 *
 * ⚠️ 「在清单里」是必要条件,**不是充分条件**:还要**同一条计费路**。咕咕代付的会话里,
 * 适配器 advertise 的是「咕咕注进去的那组 **+ 它自己内置的那些**」,而进程连的是咕咕的端点、
 * 带的是咕咕的票 —— 选它内置的那些,适配器当场收下(清单里有),下一轮却被网关 403
 * (那枚票的白名单里没有)。反向同理:自备 key 的会话里选咕咕的模型要换端点换凭据。
 * ⇒ **跨计费路一律 reload**(换进程 = 换端点换凭据),❌ 不看清单里有没有。
 *
 * 不在清单里的分两种,**分开报**,因为用户的下一步不同:
 * - `reload`:这条会话换得过去,但要重开进程再续上历史(换成「你自己的模型」则是换端点换凭据)。
 *   产品要先问一句、说清代价。
 * - `unavailable`:这条会话**根本到不了**它 —— 目录里压根没有这一条(过期的界面状态)。
 *   ❌ 不把它折进 `reload`:重开一次再告诉用户「还是不行」,是拿他的一次中断换一个我们早就知道的答案。
 *
 * ⚠️ 协议不对的模型(claude 会话选不到 Responses 面的模型)不走这里 —— 它们在目录那一层就
 * 按引擎协议过滤掉了(`sessionpage-platform-catalog.ts` 的 `protocols.includes(protocol)`),
 * 根本不会出现在 `catalog` 里。这里只回答「已经摆在用户面前的这一条,怎么换」。
 *
 * ⚠️ **前缀不在这里解**。收的是已经分好路的 `ComposerModelSelection`(装配那份铸的 id,
 * 也由它解),❌ 别在这里 import `platformModelIdFromOption` 自己再解一遍 ——
 * 第二处解码 = 第二份分流,两份会各自被改,而漂的症状是错账。判据:
 * `composer-model-assembly.test.ts` ③。
 */
export type ModelSwitchPlan =
  | {
      kind: 'hot';
      /** 咕咕的规范 id —— 存进会话记录、和目录对得上的那个。 */
      modelId: string;
      /**
       * **下发给 harness 的那个值**,与 `modelId` 不一定相同:平台模型在 opencode 上寻址成
       * `gugu-platform/<id>`。取自活会话自报的清单(见 `runtimeOptionForPlatformModelId`),
       * ❌ 不在调用点自己拼前缀 —— 那是第二份前缀字面量。
       */
      wireValue: string;
    }
  | { kind: 'reload'; modelId: string; displayName: string; source: 'platform' | 'harness' }
  | { kind: 'unsupported'; modelId: string; displayName: string }
  | { kind: 'unavailable'; modelId: string };

export interface ModelSwitchInputs {
  /** 用户点中的那一条,**已经由装配分好路**(`composerModelSelection`)。 */
  selection: ComposerModelSelection;
  /** 这条活会话的 ACP 现在报出来的模型清单 —— BYOK「当场换得成」判据。 */
  advertised: readonly string[];
  /** 咕咕目录里这条会话的引擎能用的平台模型(已按协议过滤)。 */
  catalog: readonly { id: string; displayName: string }[];
  /**
   * 这条会话**此刻跑在哪条计费路上** —— `platform` = 咕咕代付,`own` = 用户自己的凭据。
   * 判据是它自己记录的模型在不在目录里(调用点算好递进来),❌ 不靠前缀猜。
   */
  runningOn: 'platform' | 'own';
  /** Provider-declared runtime contract for model changes. */
  liveSetting?: LiveSettingCapability;
}

export function planModelSwitch(input: ModelSwitchInputs): ModelSwitchPlan {
  // 比对与下发都用**裸**的那个 id —— harness 收到的就是它,带前缀发出去它会原样收下。
  const { source, modelId } = input.selection;
  if (input.liveSetting?.recovery === 'unsupported' || input.liveSetting?.channel === 'unsupported') {
    return { kind: 'unsupported', modelId, displayName: modelId };
  }
  // A provider that declares reload-session cannot be treated as hot merely because the
  // requested model is present in a catalog. The adapter owns that decision; the UI must enter
  // the explicit confirmation flow before it calls the runtime setter.
  if (input.liveSetting?.reloadRequired || input.liveSetting?.channel === 'reload-session') {
    if (source === 'platform') {
      const catalogEntry = input.catalog.find((entry) => entry.id === modelId);
      return catalogEntry
        ? { kind: 'reload', modelId, displayName: catalogEntry.displayName, source: 'platform' }
        : { kind: 'unavailable', modelId };
    }
    return { kind: 'reload', modelId, displayName: modelId, source: 'harness' };
  }
  // 没声明模型这一维 = 这一家**没有活通道**(cell 以 `LiveSettingUndeclared` 拒,与这里同一个事实)。
  // ⇒ 同一条计费路上的「当场换」不成立,❌ 不摆成能选 —— 那正是 #6182 copilot 那格:菜单里点得到,
  //   点下去才弹一句开发者的词。跨计费路不经活通道(换进程换端点换凭据),仍走下面的 reload。
  const liveDeclared = input.liveSetting !== undefined;
  // 平台同路:下发值取活会话自报的寻址形式;报不出 = 这条进程的票没覆盖它,往下走 reload(见抬头)。
  if (source === 'platform' && input.runningOn === 'platform') {
    const known = input.catalog.find((entry) => entry.id === modelId);
    if (!known) return { kind: 'unavailable', modelId };
    if (!liveDeclared) return { kind: 'unsupported', modelId, displayName: known.displayName };
    const wireValue = runtimeOptionForPlatformModelId(modelId, input.advertised);
    if (wireValue) return { kind: 'hot', modelId, wireValue };
  }

  // BYOK 同一条计费路 + 在活清单里 = 当场换得成。跨路的一律往下走 reload。
  if (source === input.runningOn && input.advertised.includes(modelId)) {
    if (!liveDeclared) return { kind: 'unsupported', modelId, displayName: modelId };
    // BYOK:清单里那条**就是**下发值,不需要平台寻址那一层翻译。
    return { kind: 'hot', modelId, wireValue: modelId };
  }

  if (source === 'platform') {
    const known = input.catalog.find((entry) => entry.id === modelId);
    // 目录里没有 = 界面状态过期(目录刷新前点的)。重开一次也换不成,直接说。
    if (!known) return { kind: 'unavailable', modelId };
    return { kind: 'reload', modelId, displayName: known.displayName, source: 'platform' };
  }

  // harness 自家的模型:不在活清单里 = 这条会话当前的进程说不了它(它是按另一套注入起来的),
  // 换过去要重开。名字用 id 本身 —— 我们对 harness 自家模型没有第二份权威名字,
  // ❌ 不去猜一个好看的显示名。
  return { kind: 'reload', modelId, displayName: modelId, source: 'harness' };
}

/** 这条会话此刻**当场换得成**的那些(用于给下拉分档)。清单就是真值,不另算。 */
export function hotSwitchableIds(advertised: readonly string[]): ReadonlySet<string> {
  return new Set(advertised);
}

// ⚠️ 这里**不**碰 option id 的拼法与解法 —— 编解码只有装配那一处
// (`use-composer-model-options.ts` 的 `composerModelSelection` / `composerSelectedOptionId`),
// 抄第二份的那天两份就会漂,而漂的症状是「选中的那一条与实际下发的不是同一个模型」。
