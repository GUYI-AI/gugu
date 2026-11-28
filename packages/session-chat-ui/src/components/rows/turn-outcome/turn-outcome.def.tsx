/** @jsxImportSource solid-js */
/**
 * turn-outcome —— 一个 turn 结束后的收尾行（对照表 #12 error-state / #18 stopped-run）。
 *
 * # ⚠️ 普通 provider 的三颗按钮：retry ❌ / continue ✅ / discard ✅
 * Native phone interruption (#2812) is a separate recorded capability: its
 * explicit Retry creates an idempotent new attempt and retains the old ledger.
 * It does not claim that an ordinary provider supports rewind.
 *
 * 上游 `elements-error-state` 有 retry、`elements-stopped-run` 有 continue/discard。
 *
 * ⚠️ **这一段此前把 retry 与 continue 并列判成「都做不到」，那是错的**，而且是在同一条证据链里
 * 错的：⑤ 自己写着「`cancel` 之后会话是活的」，却接着断言 continue 做不到 —— 它把
 * **rewind**（原样续写被切断的那半句，协议里确实没有）与 **continue**（在那个还活着的会话里
 * 再发一条「接着往下」的指令，一直都有）当成了同一件事。上游自己也没做 rewind：官方文档写明
 * `reload()` “Restarts generation; it does not resume the cut-off text.” ⇒ 上游的 continue
 * 就是「在这一轮上重新起跑」，而这件事本仓做得到、现在也做了（`onContinueTurn`）。
 *
 * discard 也画了 —— 见 ⑤。只有 retry 依旧不画，理由在下面 ①–④，是查出来的证据链，
 * 不是「handler 的名字看着不像」：
 *
 * ① **协议层没有**（标准 ACP 至今没有，SDK 2.7.0 亦然；咕咕的 `_session/revert` 与各家扩展见下面 #3529 那段）。ACP 客户端接口的方法全集是
 *    `initialize / newSession / loadSession / prompt / cancel / setSessionConfigOption /
 *    setSessionMode / closeSession`（`session-core/src/agents/plugins/capabilities/acp.ts:52-67`）。
 *    没有 retry、没有 rewind、没有 truncate、没有 resume-turn。
 * ② **命令层没有。** `session-core/src/acp/api/contract.ts` 的 18 条命令里同样没有。
 *    阳性对照：同一把尺子在 `acp/` + `acp-agents/` + renderer `lib/acp/` 里查 `cancel`
 *    命中 73 处，查 `retry|resend|continue` 只命中循环里的 `continue` 语句 ⇒
 *    读到 0 是真阴性，不是仪器坏了。
 * ③ **能到达用户眼前的 error 就那几种。** `settleTurn` 全仓的调用点读完:live runtime 产出
 *    `done` / `cancelled` / `error`。
 *    ⚠️ 2026-09-20(#5858 / #4875)更正这一条的后半句:当年写的是「只有 `error:prompt_failed`
 *    一种,`interrupted` 那一支没有任何生产者」。前半句**是缺陷不是事实** —— 引擎死了与上游拒了
 *    共用同一个哨兵值,用户分不出;现在进程退出落 `error:process_closed`,并带着退出码/信号/
 *    stderr 尾巴。后半句当年属实,而那支死枚举已经删掉(见 `session-core` 的 `turn.ts` 抬头)。
 * ④ ⇒ 于是「重试」的唯一候选实现是把同一条 prompt 再发一次。而 `prompt_failed` 是
 *    `agent.prompt()` 整个调用抛出来的（`cell.ts:559-573`）——**它包住的是一整轮**，
 *    抛出来之前 agent 可能已经写过文件、调过工具。加上 ① 的「没有 rewind」，
 *    再发一次就是在一段**已经含着那次失败与它的副作用**的上下文后面追加第二条指令。
 *    **重发不是重试。** 不等价还接上去，就是一个会骗人的按钮 —— 比没有按钮更糟。
 * ⑤ **discard 画了，但它的语义比上游窄一格，而这一格必须说出来。** 上游那颗接
 *    `aui.message.delete()`，删的是**它自己 runtime 里的那条消息**，而那份 thread state 就是
 *    喂给模型的上下文 ⇒ 在上游，删掉即等于模型也忘了。本仓不是这个形状：上下文在 agent 进程里，
 *    transcript 只是它的一份投影，协议全集（见 ①）里没有删除 turn 的动词。
 *    ⇒ 这里的「丢弃」拿掉的是**这一次看到的列表**：那一轮的助手输出与这一行一起从对话里消失，
 *    只留用户自己那条指令；重开会话会从 provider 重放，它会回来。
 *    这正是上游**独立用法**给出的语义（官方文档原话：discard 就是「whatever removes the draft
 *    from your own list」）⇒ 不是降级，是这个动作在本仓的真实落点。
 *    ⚠️ 差的那一格写在按钮的无障碍名字里（「agent 那边仍然记得」），❌ 不许让用户以为自己撤销了什么。
 *
 * ⇒ 缺的是 turn 级的 rewind（#3529）。它后来有了，但**只在 agent 自己支持的地方**有：插件的 `acp.revert`
 * 钩子（咕咕自己的桥走 `_session/revert`，厂商走自己的 ACP 扩展）把 agent 那边的上下文截到这一轮之前；
 * 没有这个钩子的那一家，消息上就没有退回点。⇒ 失败行上，这一轮的用户消息
 * 能退回时（`canRevertMessage`），动作换成「退回重新编辑」：打开那条消息的编辑框，发送时先退回、
 * 再发改过的话 —— 那才是真的重试，因为模型已经看不到失败的那一轮。不能退回时仍是「取回指令」。
 * ①–④ 说的是不能退回的那些 agent，对它们依旧成立。
 *
 * # 那么这一行**能**真做的是什么
 *
 * 这张票说的死路是具体的：一轮出错或被停之后，**用户只能自己重打一遍指令**。
 * 那条指令还在 transcript 里 —— 缺的不是能力，只是把它拿回来的路。
 *
 * 所以这一行接的是 `onRestorePrompt`：**把这一轮的原始指令放回输入框，不发送**。
 * 它做的事与它说的话逐字相同，可当场证伪（输入框里有没有那段字）。
 * 要不要真的再跑一次由用户按发送决定 —— ④ 那个不可判定的副作用风险，
 * 交给唯一判断得了它的那个人，而不是由一个按钮替他假设。
 *
 * 而**被停止**的那一支还多一颗「继续」（`onContinueTurn`）：它向那个还活着的会话再发一条
 * 指令，agent 的上下文里带着刚才那半截输出 ⇒ 它读到的是「你写到一半被打断了，接着做」。
 * 它同样不假装能原样续写那半句。两颗按钮的分工与「为什么这颗能接、`onRestorePrompt` 那颗
 * 明令不许接成发送」逐句写在 `commands.ts` 的 `onContinueTurn` 上。
 *
 * Failure previews and their raw details share one disclosure and one measured row.
 */
import type { MeasureCtx } from '@session-chat/core/define';
import { measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import { readableLabel, rowTranslator, wrappedRowHeight } from '../readable-label';
import { CreditExhaustionRow, creditExhaustionLayout, isCreditExhaustion } from './credit-exhaustion';
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import {
  IconContinueTurn,
  IconRestorePrompt,
  IconStop,
} from '@session-chat/components/primitives/icons';
import { defineUnit } from '@session-chat/core/units';
import { turnDiscardedId, turnOutcomeDetailId } from '@session-chat/state/flatten';
import type { ChatCommands } from '@session-chat/commands';
import type { TranscriptTurnOutcome, TurnOutcomeItem } from '@session-chat/model';
import { vars } from '@session-chat/styles/theme.css';
import { Show, createMemo, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { useChatTranslator, type ChatTranslationKey, type ChatTranslator } from '@session-chat/localization';
import {
  outcomeAction,
  outcomeActionPrimary,
  outcomeBadge,
  failureBadge,
  failurePreview,
  failureRule,
  FAILURE_INSET,
  FAILURE_SEPARATOR,
  DETAIL_LINE_H,
  DETAIL_PAD_Y,
  DETAIL_PAD_X,
  outcomeDetail as outcomeDetailBand,
  outcomeShell,
  outcomeBadgeGlyph,
  outcomeBadgeLabel,
  outcomeBadgeSeparator,
  OUTCOME_BADGE_GAP_PX,
  outcomeReason,
  outcomeRow,
  outcomeRuleTrail,
  outcomeSpacer,
} from './turn-outcome.css';

type OutcomeOf<K extends TranscriptTurnOutcome['kind']> = Extract<TranscriptTurnOutcome, { kind: K }>;
type ErrorReason = NonNullable<OutcomeOf<'error'>['reason']>;
type CancelledReason = NonNullable<OutcomeOf<'cancelled'>['reason']>;

/**
 * 内部枚举 → 人话文案键。**类型上穷尽**：少一个键编译不过，
 * 所以 ACP 新增枚举值时这里会红，而不是把标识符漏给用户。
 */
const ERROR_REASON_KEY: Record<ErrorReason, ChatTranslationKey> = {
  send_failed: 'transcript.reasonSendFailed',
  prompt_failed: 'transcript.reasonPromptFailed',
  process_closed: 'transcript.reasonProcessClosed',
  spawn_failed: 'transcript.reasonSpawnFailed',
  initialize_failed: 'transcript.reasonInitializeFailed',
  new_session_failed: 'transcript.reasonNewSessionFailed',
  load_session_failed: 'transcript.reasonLoadSessionFailed',
  cancel_failed: 'transcript.reasonCancelFailed',
  set_config_failed: 'transcript.reasonSetConfigFailed',
  set_mode_failed: 'transcript.reasonSetModeFailed',
};

/** `interrupted_for_message` has no words: `flatten` draws no row for a turn stopped to take a new message. */
const CANCELLED_REASON_KEY: Record<Exclude<CancelledReason, 'interrupted_for_message'>, ChatTranslationKey> = {
  cancelled: 'transcript.reasonCancelledByUser',
};

/** 原因的人话说明；没有 reason 时返回 null（文案自己已经说清了发生什么）。 */
function reasonText(outcome: TranscriptTurnOutcome, translate: ChatTranslator): string | null {
  switch (outcome.kind) {
    case 'error':
      if (outcome.phoneInterruption) return null;
      // #6264 因为这家的登录不能用了才失败的那一轮:原因直说「需要登录」(失效与从没登录过都是它,下面那一行再分),
      // ❌ 笼统的「回合未能完成」。
      // 「重新登录」那段字在消息列表末尾的条件行里(登上之后那一行自己消失),不挤进这条 32px 的 lane。
      if (outcome.signInRequired) return translate('transcript.reasonSignInRequired');
      // #7103 上游自己说了的(网关回给 codex 的那一句):直接说它,❌ 笼统的「回合未能完成」。原文照旧在详情里。
      if (outcome.said) return outcome.said;
      return outcome.reason ? translate(ERROR_REASON_KEY[outcome.reason]) : null;
    case 'cancelled':
      return outcome.reason && outcome.reason !== 'interrupted_for_message' ? translate(CANCELLED_REASON_KEY[outcome.reason]) : null;
    default:
      return null;
  }
}

function outcomeLabel(outcome: TranscriptTurnOutcome, translate: ChatTranslator): string {
  switch (outcome.kind) {
    case 'cancelled':
      return translate('transcript.turnCancelled', { reason: '' });
    case 'error':
      if (outcome.phoneInterruption) return translate('transcript.interrupted');
      return translate('transcript.turnFailed', { reason: '' });
    case 'done':
      return outcome.reason === 'refusal' ? translate('transcript.turnRefused') : translate('transcript.turnCompleted', { reason: '' });
    default:
      return translate('transcript.turnFinished', { reason: '' });
  }
}

function outcomeDetail(outcome: TranscriptTurnOutcome): string | null {
  if (outcome.kind !== 'error') return null;
  const detail = outcome.detail?.trim();
  return detail || null;
}

/** Raw details scroll after six visual lines, including soft wraps. */
function detailBandHeight(text: string, width: number, ctx: MeasureCtx): number {
  let lines = 0;
  for (const line of text.split('\n')) {
    lines += measureSoftWrap(line, Math.max(1, width - 2 * DETAIL_PAD_X), ctx.theme.fonts.code.font).visualLineCount;
    if (lines >= 6) break;
  }
  return Math.min(6, lines) * DETAIL_LINE_H + 2 * DETAIL_PAD_Y;
}

/**
 * 徽章里的两截话。
 *
 * ⚠️ **`cancelled` 这一支只说一遍。** 它原本渲染的是「回合已取消」+「你停止了这一轮」——
 * 同一件事说了两遍，而这正是这一行读起来像一条日志而不像一个控件的一半原因（另一半是它没有
 * 任何 chrome，由 `outcomeBadge` 负责）。停止这一支的原因文案**自己就把两件事都点了名**：
 * 范围（这一轮）与原因（你停的）⇒ 它就是这一行的全部说辞，通用标签在它旁边不增加任何信息。
 *
 * send_failed 同样只有一截：「发送失败」自己说明了消息的范围和结果，条件行另说原因与重试。
 * ⚠️ 其它错误**不能照此收掉标签**：`product spec…/task-chat-ui/spec.md` 立的判据是「收尾行不画字形，
 * 因为它的文案自己点了名——说的是**这一轮**怎么了」。而「配置未能应用」「未能载入已有会话」
 * 这些原因说的是**哪件事**失败，没说这一轮到此为止 ⇒ 收掉「回合失败」就会把那条判据的前提抽走。
 * 于是它们是「说辞 · 原因」两截，只有 cancelled 和 send_failed 是一截。
 */
function badgeParts(
  outcome: TranscriptTurnOutcome,
  translate: ChatTranslator
): { label: string; reason: string | null } {
  const reason = reasonText(outcome, translate);
  if ((outcome.kind === 'cancelled' || (outcome.kind === 'error' && outcome.reason === 'send_failed')) && reason) return { label: reason, reason: null };
  return { label: outcomeLabel(outcome, translate), reason };
}

/** A failed or refused turn: the ones that leave a person stuck, and the only ones this row offers to step back from. */
function isStuckOutcome(outcome: TranscriptTurnOutcome): boolean {
  return outcome.kind === 'error' || (outcome.kind === 'done' && outcome.reason === 'refusal');
}

/** The failed turn's own message, when the agent can step back to before it. Shared by DOM and measurement. */
function rewindItemId(data: TurnOutcomeItem, commands: ChatCommands | undefined): string | null {
  const itemId = data.promptItemId;
  return isStuckOutcome(data.outcome) && itemId && commands?.onEditMessage && commands.canRevertMessage?.(itemId) ? itemId : null;
}

/** The host still owns an unsent input: restoring it would create a second send. Shared by DOM and measurement. */
function hasRestorablePrompt(data: TurnOutcomeItem): boolean {
  return Boolean(data.prompt) && data.outcome.kind !== 'cancelled'
    && !(data.outcome.kind === 'error' && data.outcome.phoneInterruption)
    && !(data.outcome.kind === 'error' && data.outcome.reason === 'send_failed');
}

function outcomeLaneLayout(data: TurnOutcomeItem, ctx: MeasureCtx) {
  const t = rowTranslator(ctx), outcome = data.outcome, commands = ctx.commands;
  const refused = outcome.kind === 'error' && outcome.guguReason ? commands?.describeRefusal?.(outcome.guguReason) : null;
  const parts = badgeParts(outcome, t);
  const reason = refused?.text ?? parts.reason;
  const actions: number[] = [];
  const actionWidth = (text: string, icon = false) => readableLabel(text, ctx, ctx.width, 14, 20, 500).width + 20 + (icon ? 18 : 0);
  if (refused?.action) actions.push(actionWidth(refused.action.label));
  if (outcome.kind === 'error' && outcome.phoneInterruption?.retryable && commands?.onRetryPhoneTask
    && commands.canRetryPhoneTask?.(outcome.phoneInterruption.jobId) !== false) actions.push(actionWidth(t('transcript.retryPhoneTask')));
  if (outcome.kind === 'cancelled' && outcome.reason !== 'interrupted_for_message') {
    if (commands?.onContinueTurn) actions.push(actionWidth(t('transcript.continueTurn'), true));
    actions.push(actionWidth(t('transcript.discardTurn')));
  } else if (rewindItemId(data, commands)) actions.push(actionWidth(t('transcript.rewindTurn')));
  else if (hasRestorablePrompt(data) && !refused?.action && commands?.onRestorePrompt) actions.push(actionWidth(t('transcript.restorePrompt'), true));
  if (isStuckOutcome(outcome)) {
    const available = Math.max(1, ctx.width - FAILURE_INSET);
    const actionSpace = actions.reduce((sum, width) => sum + Math.ceil(width) + 8, 0);
    const wrapActions = actionSpace > 0 && available - actionSpace < readableLabel(parts.label, ctx, available, 14, 20).width;
    const badgeWidth = wrapActions ? available : Math.max(1, available - actionSpace);
    const preview = reason ? parts.label + FAILURE_SEPARATOR + reason : parts.label;
    const measured = readableLabel(preview, ctx, badgeWidth, 14, 20);
    const detail = outcomeDetail(outcome) ?? (measured.height > 40 ? reason ?? parts.label : null);
    const badgeHeight = detail && ctx.expanded(turnOutcomeDetailId(data.turnId))
      ? detailBandHeight(detail, badgeWidth, ctx)
      : Math.min(40, measured.height);
    const height = wrappedRowHeight([{ width: badgeWidth, height: badgeHeight }, ...actions.map(width => ({ width: Math.ceil(width), height: 28 }))], available, 8, 4);
    return { label: parts.label, reason, badgeWidth, badgeHeight, wrapped: wrapActions, height: Math.max(ROW_H, height + 4), detail };
  }
  const glyph = outcome.kind === 'cancelled' ? 16 : 0;
  const label = readableLabel(parts.label, ctx, ctx.width - 20 - glyph, 12, 18);
  const separator = reason ? 2 * OUTCOME_BADGE_GAP_PX : 0;
  const natural = label.width + (reason ? readableLabel(reason, ctx).width + separator : 0) + 20 + glyph;
  const badgeWidth = Math.min(ctx.width, natural);
  const description = reason ? readableLabel(reason, ctx, badgeWidth - 20 - glyph - label.width - separator) : null;
  const badgeHeight = Math.max(24, label.height + 6, (description?.height ?? 0) + 6);
  const rule = outcome.kind !== 'cancelled' ? [{ width: 8, height: 1 }] : [];
  const wrapped = badgeWidth + actions.reduce((sum, value) => sum + value + 8, 0) + (rule.length ? 16 : 0) > ctx.width;
  const height = wrappedRowHeight([{ width: badgeWidth, height: badgeHeight }, ...rule, ...actions.map(width => ({ width, height: 28 }))], ctx.width, 8, 4);
  return { label: label.text, reason: description?.text, detail: null, badgeWidth, badgeHeight, wrapped, height: Math.max(32, height + 4) };
}

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  // 上游把这条 lane 与上面那段字之间留了 `gap-3`（12px）—— 那正是它看起来「有呼吸」的来源，
  // 而 lane 本身反倒是紧的。本仓这一份呼吸只能落在 margin 上（行高是常量、内部塞不下）：
  // 8 + 行内 (32-28)/2 = 10px，取到 12 的同时不动 measure()。
  margin: { top: 8, bottom: 4 },
  vars: { rowH: ROW_H },

  measure(data, ctx) {
    if (isCreditExhaustion(data.outcome)) return creditExhaustionLayout(ctx, ctx.commands, data.outcome).height;
    return outcomeLaneLayout(data, ctx).height;
  },

  Render(props) {
    const translate = useChatTranslator();
    const lane = createMemo(() => outcomeLaneLayout(props.data, props.ctx.measureCtx!()));
    const commands = useCommands();
    const isError = () => isStuckOutcome(props.data.outcome);
    const isCancelled = () => props.data.outcome.kind === 'cancelled';
    // 为插话停下的一轮:下一轮就是接着干(那条消息),所以❌ 没有「继续 / 丢弃」可言。
    const isUserStopped = () =>
      props.data.outcome.kind === 'cancelled' && props.data.outcome.reason !== 'interrupted_for_message'
      && commands().isLatestTurn?.(props.data.turnId) !== false;
    // #7103 咕咕拒了这一轮的票:原因那一截与那颗按钮都由宿主按原因表给。
    const refusal = () => {
      const outcome = props.data.outcome;
      const describe = commands().describeRefusal;
      return outcome.kind === 'error' && outcome.guguReason && describe ? describe(outcome.guguReason) : null;
    };
    const parts = () => badgeParts(props.data.outcome, translate);
    const detail = () => lane().detail;
    const [retryingJob, setRetryingJob] = createSignal<string | null>(null);
    const retryablePhone = () => {
      const outcome = props.data.outcome, go = commands().onRetryPhoneTask;
      const target = outcome.kind === 'error' ? outcome.phoneInterruption : null;
      return target?.retryable && go && commands().canRetryPhoneTask?.(target.jobId) !== false ? { jobId: target.jobId, go } : null;
    };

    /**
     * 两个门都得开：宿主接了回调 **且** 这一轮真有一条可还的用户指令。
     * 缺任何一个都不渲染 —— 本仓铁律「控件要么真生效，要么不渲染」在这里是结构约束，
     * 不是靠人记得别渲染。
     */
    /**
     * 「继续」的两个门：宿主接了回调 **且** 这一轮是**被停止**的。
     * 失败 / 中断没有「接着往下」这回事 —— 那两支不是话说到一半，是这一轮没能进行下去。
     */
    const continuable = () => {
      if (!isUserStopped()) return null;
      const go = commands().onContinueTurn;
      if (!go) return null;
      return { go };
    };

    const rewindable = () => rewindItemId(props.data, commands());

    const restorable = () => {
      if (rewindable()) return null;
      // ⚠️ 被停止那一支**不出这颗**。上游 stopped-run 的 lane 上只有 Continue 与 Discard，
      // 而「取回指令」是本仓给 error-state 那一族做的东西 —— 把它塞进 stopped-run 的位置，
      // 就是拿自家控件顶掉上游的设计。owner 连下四次「严格遵循人家的设计」，指的正是这里。
      if (!hasRestorablePrompt(props.data) || refusal()?.action) return null;
      const text = props.data.prompt;
      if (!text) return null;
      const restore = commands().onRestorePrompt;
      if (!restore) return null;
      return { text, restore };
    };

    const detailId = () => turnOutcomeDetailId(props.data.turnId);
    // 反转语义:存下来的 "collapsed" 就是「展开了」—— 与 `ctx.expanded(id)` 同一个开关。
    const detailOpen = () => Boolean(detail()) && props.ctx.viewState.isCollapsed(detailId());
    return <Show when={isCreditExhaustion(props.data.outcome)} fallback={(
      <div
        data-slot="turn-outcome"
        data-outcome={props.data.outcome.kind}
        data-detail-open={detailOpen() ? 'true' : undefined}
        class={outcomeShell}
        style={{ height: `${lane().height}px` }}
      >
        <div
          data-slot="turn-outcome-lane"
          // error 用 alert（打断读屏，因为它要求用户注意）；其余用 status（礼貌播报）。
          role={isError() ? 'alert' : 'status'}
          class={outcomeRow}
          style={{
            height: `${lane().height}px`,
            position: 'relative',
            'padding-left': isError() ? FAILURE_INSET + 'px' : undefined,
            'flex-wrap': 'wrap', 'row-gap': '4px',
            color: isError() ? vars.fgError : vars.fgMuted,
          }}
        >
          {/* 徽章：上游 `elements-stopped-run` 下半条的那颗 pill。行里的一切读的都是 accessor
              （`parts()` / `isCancelled()`），❌ 不在 Show 回调外把它们捕获成常量 —— 行组件按下标
              复用，捕获过的值换单元时不会重算（对照钉在 turn-process-fold.contract.test.tsx）。 */}
          <Dynamic
            style={{ width: `${lane().badgeWidth}px`, height: `${lane().badgeHeight}px` }}
            component={detail() ? 'button' : 'span'}
            type={detail() ? 'button' : undefined}
            data-slot="turn-outcome-badge"
            data-detail-toggle={detail() ? 'true' : undefined}
            data-collapse-id={detail() ? detailId() : undefined}
            // 开关的 id 带命名空间后缀,`unitIndexOf` 查不到 ⇒ 这里报出自己所在的那一行,
            // 让滚动锚点钉得住(否则点开视口上方那一行时,transcript 会在读者眼皮底下跳)。
            data-collapse-anchor={detail() ? props.data.id : undefined}
            aria-expanded={detail() ? (detailOpen() ? 'true' : 'false') : undefined}
            class={isError() ? failureBadge : outcomeBadge}
            // aria-label 会**整条顶掉**可见文案的无障碍名 ⇒ 两截话都得带上，否则读屏用户听到的是
            // 「回合失败: <原文>」,丢了「这一轮怎么了」那半句。❌ 别写成 `{...(detail() ? {…} : {})}`:
            // spread 里的 `detail()` 只在创建那一刻求值一次,而行组件按下标复用 ⇒ 换单元时不重算。
            aria-label={
              detail()
                ? `${[parts().label, refusal()?.text ?? parts().reason].filter(Boolean).join(translate('metadata.separator'))}: ${detail()}`
                : undefined
            }
            title={detail() ?? undefined}
          >
            <Show when={detailOpen()} fallback={
              <span class={isError() ? failurePreview : undefined} style={{ display: isError() ? undefined : 'contents' }}>
                <Show when={isCancelled()}>
                  <span data-slot="turn-outcome-badge-glyph" aria-hidden="true" class={outcomeBadgeGlyph}>
                    <IconStop />
                  </span>
                </Show>
                <span data-slot="turn-outcome-label" class={isError() ? undefined : outcomeBadgeLabel}>{lane().label}</span>
                <Show when={lane().reason}>{reason => <>
                  <Show when={isError()} fallback={<span aria-hidden="true" class={outcomeBadgeSeparator} />}>{FAILURE_SEPARATOR}</Show>
                  <span data-slot="turn-outcome-reason" class={isError() ? undefined : outcomeReason} style={{ color: vars.fgMuted }}>
                    {reason()}
                  </span>
                </>}</Show>
              </span>
            }>
              <pre data-slot="turn-outcome-detail" class={outcomeDetailBand} style={{ height: lane().badgeHeight + 'px' }}>{detail()}</pre>
            </Show>
          </Dynamic>
          <Show when={!isCancelled()} fallback={
            <span data-slot="turn-outcome-spacer" aria-hidden="true" class={outcomeSpacer} style={{ display: lane().wrapped ? 'none' : undefined }} />
          }>
            <span data-slot="turn-outcome-rule" data-rule={isError() ? 'leading' : 'trail'} aria-hidden="true"
              class={isError() ? failureRule : outcomeRuleTrail} />
          </Show>
          <Show when={refusal()?.action}>
            {(action) => (
              <button
                type="button"
                data-slot="turn-outcome-refusal-action"
                class={outcomeActionPrimary}
                onClick={() => action().run()}
              >
                {action().label}
              </button>
            )}
          </Show>
          <Show when={retryablePhone()}>
            {(target) => <button type="button" data-slot="turn-outcome-phone-retry" class={outcomeActionPrimary}
              disabled={retryingJob() === target().jobId}
              onClick={async () => {
                const action = target();
                if (retryingJob() === action.jobId) return;
                setRetryingJob(action.jobId);
                try { await action.go({ itemId: props.data.id, jobId: action.jobId }); }
                finally { setRetryingJob(null); }
              }}>{translate('transcript.retryPhoneTask')}</button>}
          </Show>
          <Show when={continuable()}>
            {(target) => (
              <button
                type="button"
                data-slot="turn-outcome-continue"
                class={outcomeActionPrimary}
                // 可见文案只有「继续」；它**会发出一条新指令**这件事写进无障碍名字，
                // 免得一颗 12px 的胶囊悄悄替用户按下发送。
                aria-label={translate('transcript.continueTurnHint')}
                title={translate('transcript.continueTurnHint')}
                onClick={() => target().go({ itemId: props.data.id, source: 'turn-outcome' })}
              >
                {translate('transcript.continueTurn')}
                <IconContinueTurn />
              </button>
            )}
          </Show>
          {/* 「丢弃」——上游 stopped-run 的第二颗。它把这一轮 agent 写到一半的输出从对话里拿掉，
              只留用户自己那条指令（上游删的也正是那条被取消的助手消息）。
              身上挂 `data-collapse-id` ⇒ 走 ChatRoot 里既有的那条点击委派，不经宿主回调。
              ⚠️ 它拿掉的是**这一次看**：重开会话会从 provider 重放，那一轮会回来。ACP 里没有删除
              turn 的动词（agent 面九个方法读过，`forkSession` 也只按会话整条分叉），所以任何本地
              实现都到不了「模型也忘了」。上游独立用法给的正是这个语义：把它从你自己的列表里拿掉。 */}
          <Show when={isUserStopped() && commands().canDiscardTurn?.(props.data.turnId) !== false}>
            <button
              type="button"
              // Native: the transcript's click delegate toggles this row away before a delegated handler would run.
              on:click={() => commands().onDiscardTurn?.({ turnId: props.data.turnId })}
              data-slot="turn-outcome-discard"
              data-collapse-id={turnDiscardedId(props.data.turnId)}
              class={outcomeAction}
              aria-label={translate('transcript.discardTurnHint')}
              title={translate('transcript.discardTurnHint')}
            >
              {translate('transcript.discardTurn')}
            </button>
          </Show>
          <Show when={rewindable()}>
            {(itemId) => (
              <button
                type="button"
                data-slot="turn-outcome-rewind"
                class={outcomeActionPrimary}
                aria-label={translate('transcript.rewindTurnHint')}
                title={translate('transcript.rewindTurnHint')}
                onClick={() => commands().onEditMessage?.({ itemId: itemId() })}
              >
                {translate('transcript.rewindTurn')}
              </button>
            )}
          </Show>
          <Show when={restorable()}>
            {(target) => (
              <button
                type="button"
                data-slot="turn-outcome-action"
                class={outcomeAction}
                // 可见文案只说「取回指令」；完整承诺（**不会自动重发**）写在无障碍名字里，
                // 免得一个 12px 的胶囊替产品许下它兑现不了的话。
                aria-label={translate('transcript.restorePromptHint')}
                title={translate('transcript.restorePromptHint')}
                onClick={() =>
                  target().restore({
                    itemId: props.data.id,
                    text: target().text,
                    source: 'turn-outcome',
                  })
                }
              >
                <IconRestorePrompt />
                {translate('transcript.restorePrompt')}
              </button>
            )}
          </Show>
        </div>
      </div>
    )}><CreditExhaustionRow outcome={props.data.outcome} ctx={() => props.ctx.measureCtx!()} /></Show>;
  },
});
