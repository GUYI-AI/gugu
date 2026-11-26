/** Composer model list and its anchored model details. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Pencil, Sparkles } from '../../../icons';
import { Combobox } from '@session-ui/react/primitives/combobox/combobox';
// 「思考」那一段是**一条有序标尺**,所以是 Slider 而不是一组单选药丸 ——
// 见 chat-composer.css.ts 的 modelEffortRow 抬头(owner 2026-09-17 指定)。
// ❌ 别退回 RadioGroup:并列选项这个语义本身就说不出"深浅"。
import type { ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
// 悬浮详情卡与 agent 选择器那张(ComboboxPopover)是同一个原语:同样的开关延时、同样不吃掉父面板的关闭。
import {
  HoverCard,
  isEventInsideInteractiveLayer,
  useHoverCard,
} from '@session-ui/react/primitives/hover-card';
import { useMessages } from '../../localization/message-provider';
import { modelContextLengths } from '@gugu/session-core/models/context-threshold';
import * as styles from './chat-composer.css';
// 圆钮直径的**唯一真源** —— 填充末端要落在圆心上,这里跟着它算,❌ 别再写一遍字面量。
import { ComposerFastMode, type RenderFastModeHint } from './composer-fast-mode';
import { ComposerThinking } from './composer-thinking';
import { ContextThresholdChoices, formatModelContextLength, type ComposerContextThresholds } from './context-threshold';

import type {
  ComposerEffortItem,
  ComposerEffortOption,
  ComposerModelItem,
  ComposerModelUnlock,
  ComposerModelUpgrade,
} from './composer-options';

/**
 * @@@composer-model-trigger-label — 常驻触发器上剥掉括号,清单里保留全名。
 *
 * owner 2026-09-07:「一般括号里的信息确实是可以忽略的,或者渐进披露的」。
 * 括号内容(`Opus (1M context)` 的那半)是**规格**不是身份:底排那颗按钮的职责是回答
 * 「我现在用的是谁」,一眼扫过去要短;规格是打开清单挑的时候才需要分辨的。
 *
 * ⚠️ 所以这条**只作用于触发器**。清单里必须留全名 —— Claude Code 的目录里
 * `Opus` 与 `Opus (1M context)` 同时存在,剥了就变成两条一模一样的、选不出来。
 * 判据钉在 `composer-model-menu-3249.test.tsx`:剥后触发器短、清单两条仍可分辨。
 *
 * 剥不干净就原样返回(全名就是一对括号时,剥完是空串)—— 宁可长,不可空。
 */
const MODEL_PARENTHETICAL = /\s*[（(][^()（）]*[)）]/g;

function stripModelParenthetical(label: string): string {
  return label.replace(MODEL_PARENTHETICAL, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * ⚠️ 括号也可能**就是身份**(#6335):Antigravity 的目录是 `Gemini 3.8 Flash (High)` /
 * `(Medium)` / `(Low)` 三条,没有一条叫光秃秃的 `Gemini 3.8 Flash` —— 剥掉以后三档长得
 * 一模一样,底排那颗按钮就答不出「我现在用的是谁」。判据:剥后的名字被**两条以上**共享、
 * 且清单里**没有**一条本来就叫这个名字 ⇒ 括号是变体身份,留全名。
 * Claude 那对(`Opus` 与 `Opus (1M context)`)不受影响:`Opus` 本身在清单里,括号仍是规格。
 * `siblings` 是同一张清单里各条触发器会用的名字(不传 = 旧行为,一律剥)。
 */
export function composerModelTriggerLabel(label: string, siblings: readonly string[] = []): string {
  const stripped = stripModelParenthetical(label);
  if (!stripped) return label;
  if (stripped !== label && !siblings.includes(stripped)) {
    const sharing = siblings.filter((name) => stripModelParenthetical(name) === stripped).length;
    if (sharing >= 2) return label;
  }
  return stripped;
}

// ── Model panel shape ─────────────────────────────────────────────────────────

/** 模型面板长什么样:开不开,以及「模型」那一行由谁占。 */
export type ComposerModelPanel =
  | { kind: 'hidden' }
  | { kind: 'shown'; modelRow: 'list' | 'none' };

/**
 * 面板的取舍抽成纯函数,是为了**能被判假**。
 *
 * 这段判断原本直接写在 JSX 的条件里,而 JSX 在本仓的可测范围之外(组件测在
 * `tests/unit/desktop/`,worktree 里跑不了)。⇒ 它坏掉时没有任何判据会红,
 * owner 2026-08-26 那次就是这么漏出去的:没登录 ⇒ 模型清单空 ⇒ 「模型」那一行
 * **整个不渲染**,面板上只剩「推理强度」。他的原话是「只有推理强度,反而没有模型」。
 *
 * 两条不变量,`model-groups.test.ts` 里逐条撞:
 *  · 有话可说就得开面板 —— 哪怕一个模型都没有,只要有「去登录」这条路(unlock)。
 *    ❌ 别退回「没模型就整颗触发器消失」:那样用户连「为什么没有模型」都无处可问。
 *  · 「模型」那一行不许静默消失 —— 有清单、或有登录入口,这一行就得在。
 *    只有两者皆无(既没模型也没登录入口,例如这家压根不声明模型轴)才空着。
 *
 * ⚠️ **2026-08-28 改了语义,别照旧版推理**:登录入口从前是「一个模型都没有时**顶掉**
 * 模型那一行」,于是它几乎永远不出现 —— 咕咕自家的模型一直在,清单从来不空。
 * 现在它是**清单里的一条**(渐进披露,owner 定):用户点开模型列表、正在挑模型的那一刻,
 * 才第一次看到「添加个人 X 连接」。所以这里只判「这一行要不要在」,
 * 「登录那条摆在哪」由 `ComposerModelUnlock` 在清单内部决定。
 */
export function resolveComposerModelPanel(input: {
  modelCount: number;
  effortCount: number;
  unlock: boolean;
  /** An actual preparation or setting notice keeps an empty menu reachable. */
  notice?: boolean;
}): ComposerModelPanel {
  const modelRow = input.modelCount > 0 || input.unlock ? 'list' : 'none';
  if (modelRow === 'none' && input.effortCount === 0 && !input.notice) return { kind: 'hidden' };
  return { kind: 'shown', modelRow };
}

// ── Model tooltip ─────────────────────────────────────────────────────────────

import { formatTokenCount, metadataSeparator } from '@gugu/session-shared/format';

export function formatContextWindow(tokens: number): string {
  // 进位判据与别处同一份(session-shared);这里只换成「N tokens」的写法。
  const count = formatTokenCount(tokens);
  if (count.endsWith('M')) return `${(tokens / 1_000_000).toFixed(0)}M tokens`;
  if (count.endsWith('k')) return `${Math.round(tokens / 1_000)}K tokens`;
  return `${tokens} tokens`;
}

/**
 * 模型条目的悬浮说明。原来这些信息在一张 hover 详情卡里,Codex 的设置面板没有那一层,
 * 卡片随弹层重构一起去掉了 —— 但 modelFeatures 是插件真声明过的数据,不能跟着卡片一起
 * 消失,所以折进条目的 title,信息还在,只是不再占一块面板。
 */
export function modelTitle(item: ComposerModelItem, locale = 'en-US'): string | undefined {
  const parts: string[] = [];
  if (item.description) parts.push(item.description);
  const f = item.modelFeatures;
  if (f?.contextWindowSize !== undefined) parts.push(`Context ${formatContextWindow(f.contextWindowSize)}`);
  if (f?.speed !== undefined) parts.push(`Speed ${f.speed}/5`);
  if (f?.intelligence !== undefined) parts.push(`Intelligence ${f.intelligence}/5`);
  return parts.length > 0 ? parts.join(metadataSeparator(locale)) : undefined;
}

/**
 * 悬浮详情卡里的一条模型(#7056,对齐 Cursor 那张):名字 → 这条是谁的 → 一句话说明 → 事实两列 → 选不了的原因。
 * 事实里上下文、速度、智能来自 `modelFeatures`(插件 / 目录真声明过的),其余由宿主翻好递进来(`facts`)。
 * 什么都没有的那几格就不画 —— ❌ 写「未知」占位。
 */
function ModelDetail({ item, contextThresholds, efforts, effort, onEffortChange, onContextCommit,
  contextEffort, keyboardEntry, onReturn, fastControl, onDisabledAction }: {
  item: ComposerModelItem;
  contextThresholds?: ComposerContextThresholds;
  efforts?: ComposerEffortItem[];
  effort?: ComposerEffortItem;
  onEffortChange?: (id: string) => void;
  onContextCommit: () => void;
  contextEffort?: string;
  keyboardEntry: number;
  onReturn: () => void;
  fastControl?: React.ReactNode;
  onDisabledAction?: () => void;
}) {
  const { translate } = useMessages();
  const f = item.modelFeatures;
  const detail = useRef<HTMLDivElement>(null);
  const effortTrigger = useRef<HTMLButtonElement>(null);
  const [submenuAnchor, setSubmenuAnchor] = useState<HTMLElement | null>(null);
  const submenu = useHoverCard({ openDelay: 100, closeDelay: 300, safeTriangle: true, delaySwitch: true });
  const submenuId = React.useId();
  const focusSubmenu = useRef(false);
  const showSubmenu = submenu.show;
  const canEditEffort = (efforts?.length ?? 0) > 1 && !!onEffortChange;
  const canChooseEffort = canEditEffort && !!efforts?.some(level => !level.disabled);
  const context = modelContextLengths(f?.contextLengths, f?.defaultContextLength, f?.contextWindowSize);
  const threshold = !item.disabled ? contextThresholds?.(item.id, f?.contextWindowSize) : undefined;
  const canSetThreshold = !!threshold?.selectWindow && !!context && context.contextLengths.length > 1 &&
    context.contextLengths.every(value => value > threshold.minimum);
  const effortLabel = translate('composer.thinkingStrength');
  const lockedEffortReasonId = React.useId();
  const lockedEffortReason = efforts?.length && efforts.every(level => level.disabled)
    ? efforts[0]?.disabledReason ?? translate('composer.effortLocked') : undefined;

  useEffect(() => {
    if (!keyboardEntry) return;
    if (effortTrigger.current && canChooseEffort) {
      focusSubmenu.current = true;
      setSubmenuAnchor(effortTrigger.current);
      showSubmenu('effort');
    } else {
      const current = detail.current;
      (current?.querySelector<HTMLElement>('button:enabled') ?? current)?.focus({ preventScroll: true });
    }
  }, [keyboardEntry, canChooseEffort, showSubmenu]);

  const submenuTrigger = (key: 'effort' | 'context') => {
    const open = submenu.open && submenu.activeKey === key;
    const show = (button: HTMLButtonElement, keyboard: boolean) => {
      focusSubmenu.current = keyboard;
      setSubmenuAnchor(button);
      showSubmenu(key);
    };
    return {
      'aria-haspopup': 'dialog' as const, 'aria-expanded': open, 'aria-controls': open ? submenuId : undefined,
      ...submenu.getRowHoverProps(key, element => {
        focusSubmenu.current = false;
        setSubmenuAnchor(element);
      }),
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => show(event.currentTarget, event.detail === 0),
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        show(event.currentTarget, true);
      },
    };
  };
  return (
    <div ref={detail} data-slot="composer-model-detail" className={styles.modelDetailBody} tabIndex={-1}
      onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          if (event.key === 'ArrowLeft' && event.target instanceof HTMLInputElement && event.target.selectionStart !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          submenu.close();
          onReturn();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const scope = event.target.closest('[data-slot="popover-content"]');
        const controls = [...(scope?.querySelectorAll<HTMLElement>('button:enabled, input:enabled') ?? [])];
        if (!controls.length) return;
        const index = controls.indexOf(event.target);
        const next = event.key === 'ArrowDown' ? (index + 1) % controls.length : index <= 0 ? controls.length - 1 : index - 1;
        event.preventDefault();
        event.stopPropagation();
        controls[next]?.focus({ preventScroll: true });
      }}>
      <div className={styles.modelDetailHead}>
        <span className={styles.modelDetailName}>{item.name}</span>
        {item.description && !item.creditRate && <div className={styles.modelDetailTier}>{item.description}</div>}
      </div>
      {item.creditRate && <div className={styles.modelDetailRow}>
        <span>{translate('composer.modelDetailRate')}</span>
        <span className={styles.modelDetailRateValue} data-slot="composer-model-detail-rate">
          {translate('composer.modelDetailRateValue', { rate: item.creditRate })}
        </span>
      </div>}
      {canEditEffort && (
        <button ref={effortTrigger} type="button" data-slot="popover-trigger" className={styles.contextThresholdTrigger}
          {...submenuTrigger('effort')}>
          <span>{effortLabel}</span>
          <span className={styles.modelDetailControlValue}>{effort?.name}<ChevronRight size={14} aria-hidden /></span>
        </button>
      )}
      {fastControl}
      {canSetThreshold && <button type="button" data-slot="popover-trigger" className={styles.contextThresholdTrigger}
        {...submenuTrigger('context')}>
        <span>{translate('composer.contextWindowThreshold')}</span>
        <span className={styles.modelDetailControlValue}>
          {formatModelContextLength(threshold.selectedWindow ?? context.defaultContextLength)}<ChevronRight size={14} aria-hidden />
        </span>
      </button>}
      <HoverCard id={submenuId} anchor={submenuAnchor} ownPopup={submenuAnchor?.closest<HTMLElement>('[data-hover-card]')}
        controller={submenu} side="left" align="start" sideOffset={({ side }) => {
          const row = submenuAnchor?.getBoundingClientRect();
          const card = submenuAnchor?.closest('[data-hover-card]')?.getBoundingClientRect();
          if (!row || !card) return 0;
          return side === 'left' ? row.left - card.left : card.right - row.right;
        }}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
        className={styles.modelDetailSubmenu}
        initialFocus={() => {
          if (!focusSubmenu.current) return false;
          const popup = detail.current?.ownerDocument.getElementById(submenuId);
          return popup?.querySelector<HTMLElement>('button[aria-pressed="true"]:enabled')
            ?? popup?.querySelector<HTMLElement>('button:enabled, input:enabled') ?? true;
        }}>
        {submenu.open && (submenu.activeKey === 'context' ? (
          canSetThreshold && <ContextThresholdChoices threshold={threshold} onCommit={onContextCommit}
            lengths={context.contextLengths} defaultLength={context.defaultContextLength} effort={contextEffort} />
        ) : (
          <>
            <div className={styles.contextThresholdHeading}>{effortLabel}</div>
            {efforts?.map(level => (
              <button type="button" key={level.id} disabled={level.disabled} aria-pressed={effort?.id === level.id}
                className={styles.contextThresholdOption} title={level.disabledReason}
                aria-describedby={lockedEffortReason ? lockedEffortReasonId : undefined}
                onClick={() => onEffortChange?.(level.id)}>
                {level.name}{effort?.id === level.id && <Check className={styles.modelSelectedCheck} size={14} aria-hidden />}
              </button>
            ))}
            {lockedEffortReason && <p id={lockedEffortReasonId} className={styles.effortMenuLockedReason}>{lockedEffortReason}</p>}
          </>
        ))}
      </HoverCard>
      {item.disabled && item.disabledReason && (
        <p className={styles.modelDetailSummary}>{item.disabledReason}</p>
      )}
      {item.disabled && item.disabledAction && onDisabledAction && (
        <button type="button" className={styles.modelPanelFooterAction} onClick={onDisabledAction}>
          {item.disabledAction.label}
        </button>
      )}
    </div>
  );
}

// ── The menu ──────────────────────────────────────────────────────────────────

export interface ComposerModelMenuProps {
  /** `resolveComposerModelPanel` 的结果。`hidden` 时整颗触发器不渲染。 */
  panel: ComposerModelPanel;
  disabled?: boolean;
  /**
   * 触发器的 `title`。⚠️ 传进来的是**当前 agent** 的说明而不是模型的 —— 这是既有行为，
   * 搬家时原样保留；要改得单独立判据，别在一次纯搬运里顺手改掉。
   */
  triggerTitle?: string;
  modelItems: ComposerModelItem[];
  selectedModel?: string;
  /**
   * The model options, or what decides which one is selected, are not read yet: the trigger holds the name's place
   * (@@@unknown-slot), ❌ the literal "Model", ❌ `selectedModel` (a guess until then).
   */
  modelUnknown?: boolean;
  onModelChange?: (modelId: string, effortId?: string) => void;
  effortOptionsForModel?: (modelId: string) => Record<string, ComposerEffortOption> | null;
  /**
   * 宿主要把模型面板打开(例如「这个模型要会员」那一行上的「换模型」,#7056)。每变一次开一次;0 / 缺省 = 不开。
   * ❌ 宿主去 DOM 里找触发器 click —— 那是拿测试锚点当产品接口。
   */
  openRequest?: number;
  settingNotice?: string | null;
  /** See `modelMenuNotice` on the composer. */
  menuNotice?: string;
  onOpen?: () => void;
  modelUnlock?: ComposerModelUnlock | null;
  onModelUnlock?: (anchor?: HTMLElement) => void;
  /** 底部「管理模型」:宿主打开设置里的「模型」那一页(#7056)。不给 = 不画。 */
  onManageModels?: () => void;
  /** 底部「升级解锁更多模型」(免费档才有,见 `ComposerModelUpgrade`)。 */
  modelUpgrade?: ComposerModelUpgrade | null;
  onModelUpgrade?: () => void;
  contextThresholds?: ComposerContextThresholds;
  effortItems: ComposerEffortItem[];
  selectedEffort?: string;
  onEffortChange?: (effortId: string) => void;
  defaultEffort?: string;
  /** Undefined means the current model/route does not offer Fast. */
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  renderFastModeHint?: RenderFastModeHint;
  phoneActions?: boolean;
}

/** The model name's place while the options are unknown: one line tall, a short name wide (@@@unknown-slot). */
const UNKNOWN_MODEL_NAME = {
  display: 'inline-block', width: '5em', height: '1lh', verticalAlign: 'top',
  borderRadius: 'var(--radius-control)', background: 'var(--muted)',
} as const;

const modelOptions = (panel: HTMLElement | null) =>
  [...(panel?.querySelectorAll<HTMLElement>('[data-model-option-id]:not([data-disabled])') ?? [])];

export function ComposerModelMenu({
  panel,
  disabled = false,
  triggerTitle,
  modelItems,
  selectedModel,
  modelUnknown = false,
  onModelChange,
  effortOptionsForModel,
  openRequest,
  settingNotice,
  menuNotice,
  onOpen,
  onManageModels,
  contextThresholds,
  effortItems: allEffortItems,
  selectedEffort,
  onEffortChange,
  defaultEffort,
  fastMode,
  onFastModeChange,
  renderFastModeHint,
  phoneActions,
}: ComposerModelMenuProps) {
  const { translate, locale } = useMessages();
  const effortItems = allEffortItems.filter(({ id }) => id.toLowerCase() !== 'default');

  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const onOpenRef = useRef(onOpen);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const focusListOnOpen = useRef(false);
  onOpenRef.current = onOpen;
  const openModelPanel = useCallback(() => {
    onOpenRef.current?.();
    focusListOnOpen.current = true;
    setModelPanelOpen(true);
  }, []);
  useEffect(() => {
    if (openRequest) openModelPanel();
  }, [openRequest, openModelPanel]);
  /**
   * 悬浮详情卡(#7056,对齐 Cursor):指到哪一行,卡就贴着那一行出现在面板旁边。
   * ⚠️ 这三个 hook 同样必须排在早退之前。
   */
  const detailCard = useHoverCard({ openDelay: 100, closeDelay: 300, safeTriangle: true });
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  const [keyboardEntry, setKeyboardEntry] = useState(0);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const [repairTarget, setRepairTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!panelEl || !modelPanelOpen || !repairTarget) return;
    panelEl.querySelector(`[data-model-option-id="${CSS.escape(repairTarget)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [panelEl, modelPanelOpen, repairTarget]);


  /**
   * 一行的悬停:记下贴哪一条,再交给控制器去延时开卡。
   * ⚠️ 卡贴的必须是**和面板一样宽**的那一条(整行)—— 末尾那两条去路也是整行宽的按钮,同样贴它自己。
   */
  const detailHoverProps = (key: string) => detailCard.getRowHoverProps(key, (element) => {
    setKeyboardEntry(0);
    setDetailAnchor(element);
  });
  const detailItem = modelItems.find(item => item.id === detailCard.activeKey) ?? null;

  // While what decides the model is unknown, the selected id is only a guess (the harness default before the remembered
  // choice is read): the trigger holds the name's place, ❌ draws the guess and then switches (@@@unknown-slot).
  const selectedModelItem = selectedModel && !modelUnknown
    ? (modelItems.find((m) => m.id === selectedModel) ?? null)
    : null;
  const detailIsSelected = !!detailItem && detailItem.id === (selectedModelItem?.aliasOf ?? selectedModelItem?.id);
  const targetOptions = detailItem && !detailItem.disabled && !detailIsSelected && onModelChange
    ? effortOptionsForModel?.(detailItem.id) : null;
  const detailEfforts = detailIsSelected ? effortItems : targetOptions ? Object.entries(targetOptions)
    .filter(([id]) => id.toLowerCase() !== 'default')
    .map(([id, option]) => ({ id, ...option })) : undefined;
  const selectedEffortItem = effortItems.find(item => item.id === selectedEffort);
  const defaultEffortItem = effortItems.find(item => item.id === defaultEffort);
  const effectiveEffortItem = selectedEffortItem ?? defaultEffortItem;

  const effortForModelSwitch = (item: ComposerModelItem) => {
    if (item.id === (selectedModelItem?.aliasOf ?? selectedModelItem?.id)) return undefined;
    const options = effortOptionsForModel?.(item.id);
    if (!options) return undefined;
    const current = effectiveEffortItem?.id;
    if (current && options[current] && !options[current].disabled) return current;
    const fallback = item.modelFeatures?.defaultEffortId;
    return fallback && options[fallback] && !options[fallback].disabled ? fallback : undefined;
  };
  const selectModel = (item: ComposerModelItem) => {
    const effort = effortForModelSwitch(item);
    if (effort === undefined) onModelChange?.(item.id);
    else onModelChange?.(item.id, effort);
  };

  const visibleModels = modelItems.filter(item => !item.hiddenFromPicker);
  const selectedRowId = selectedModelItem?.aliasOf ?? selectedModel;
  const selectedModelEntry = visibleModels.find(item => item.id === selectedRowId) ?? null;

  /**
   * 每一行都有图标(owner 11-25):认得出厂商画厂商 logo,认不出的画一枚通用的 ✦ 兜底(淡色,`data-fallback`)。
   * 以前认不出就留空位 —— 名字不错位,但那一行左边是个洞,看着像没做完。
   */

  useEffect(() => {
    if (!modelPanelOpen || !panelEl || !focusListOnOpen.current) return;
    const options = modelOptions(panelEl);
    const initial = options.find(option => option.dataset.modelOptionId === selectedRowId) ?? options[0];
    const target = initial ?? panelEl.querySelector<HTMLElement>('[data-testid="composer-model-manage"]');
    if (!target) return;
    focusListOnOpen.current = false;
    target.focus();
  }, [modelPanelOpen, panelEl, selectedRowId, modelItems.length]);

  if (panel.kind !== 'shown') return null;

  const closeAfterSelection = () => {
    modelTrigger.current?.focus({ preventScroll: true });
    detailCard.close();
    setRepairTarget(null);
    setKeyboardEntry(0);
    setModelPanelOpen(false);
  };

  const modelPanelEnd = onManageModels && (
    <div className={styles.modelPanelActions} data-slot="composer-model-footer">
      <button
        type="button"
        className={styles.modelPanelActionRow}
        onClick={() => {
          closeAfterSelection();
          onManageModels();
        }}
        data-testid="composer-model-manage"
      >
        <span className={styles.composerPanelItemIcon} aria-hidden="true"><Pencil size={14} /></span>
        {translate('composer.manageModels')}
      </button>
    </div>
  );

  const handleListKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || !(event.target instanceof HTMLElement)) return;
    const option = event.target.closest<HTMLElement>('[data-model-option-id]');
    if (!option || !event.currentTarget.contains(option)) return;
    const options = modelOptions(event.currentTarget);
    const index = options.indexOf(option);
    if (index < 0) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        options[(index + step + options.length) % options.length]?.focus();
        break;
      }
      case 'Home':
        options[0]?.focus();
        break;
      case 'End':
        options.at(-1)?.focus();
        break;
      case 'Enter':
      case ' ':
        option.click();
        break;
      case 'ArrowRight':
        if (phoneActions) return;
        setKeyboardEntry(previous => previous + 1);
        setDetailAnchor(option);
        detailCard.show(option.dataset.modelOptionId!);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    // `display:contents` —— 这层只为寻址存在,不参与布局(工具栏是 flex,
    // 真占一个盒子会把间距挤歪)。上游给触发器挂的是 `model-selector-trigger`,
    // 本仓 primitive 自己的 data-slot 不许被调用点顶掉(见 combobox 的
    // FixedDataSlotProps),所以那个名字落在外面这一层。
    <span data-slot="composer-model" style={{ display: 'contents' }}>
      <Combobox.Root
        items={visibleModels}
        value={selectedModelEntry}
        filter={null}
        itemToStringLabel={item => item.name}
        onValueChange={(item: ComposerModelItem | null) => {
          if (!item) return;
          selectModel(item);
          closeAfterSelection();
        }}
        open={modelPanelOpen}
        onOpenChange={(next: boolean, details: ComboboxRootChangeEventDetails) => {
          // 鼠标移进悬浮卡不算「离开面板」:与 ComboboxPopover 同一条判据,❌ 一碰卡面板就关。
          if (!next && isEventInsideInteractiveLayer(details.event, panelEl)) {
            details.cancel();
            return;
          }
          if (!next) {
            detailCard.close();
            setRepairTarget(null);
            setKeyboardEntry(0);
            if (details.reason === 'escape-key' || details.reason === 'item-press') {
              modelTrigger.current?.focus({ preventScroll: true });
            }
          }
          if (next) openModelPanel();
          else setModelPanelOpen(false);
        }}
        isItemEqualToValue={(a: ComposerModelItem, b: ComposerModelItem) => a.id === b.id}
      >
        <Combobox.Trigger
          ref={modelTrigger}
          className={styles.agentTrigger}
          disabled={disabled}
          title={settingNotice ?? triggerTitle}
          // 这颗触发器的可访问名是「当前模型名」——会随选择变化,拿它定位等于拿一个
          // 动态值当锚点。旁边还有别的弹层按钮(用户菜单),按序数取第一个会抓到那个
          // (实测抓到了「设置/会员与额度/退出登录」)。给它一个稳定锚点。
          data-testid="composer-model-trigger"
        >
          {/* 上游的触发器同样先画一枚厂商 logo(`ModelSelectorValue` 里
              `{selectedModel.icon && <ModelIcon>}`)—— 收起状态下也一眼看出这条会话
              跑的是谁家的模型。 */}
          {selectedModelItem?.icon && (
            <span className={styles.modelTriggerIcon} aria-hidden="true">
              {selectedModelItem.icon}
            </span>
          )}
          {/* 触发器的名字是解剖里独立的一格(旁边还有厂商图形与强度档),给它自己的 slot ——
              判据要能只读这一格:整颗触发器的 textContent 会把强度档("中")粘在名字后面。 */}
          <span data-slot="composer-model-trigger-label" className={styles.modelTriggerLabel}>
            {/* 括号在这里剥掉,清单里不剥 —— 见 @@@composer-model-trigger-label。 */}
            {settingNotice
              ? `${settingNotice}: ${translate('composer.changeModel')}`
              : selectedModelItem
              ? composerModelTriggerLabel(
                  selectedModelItem.name,
                  modelItems.map(model => model.name)
                )
              : modelUnknown
              ? <span aria-busy="true" data-unknown="" className="gg-unknown" style={UNKNOWN_MODEL_NAME} />
              : translate('composer.model')}
          </span>
          <ChevronDown size={11} className={styles.modelTriggerChevron} aria-hidden />
        </Combobox.Trigger>
        <Combobox.Content ref={setPanelEl} className={styles.modelPanelContent} side="top" align="end" sideOffset={8}
          initialFocus={false} onKeyDownCapture={handleListKey}>
          {(settingNotice || menuNotice) && (
            <div role="status" className={styles.modelSettingNotice} data-testid="composer-model-setting-notice">
              {settingNotice || menuNotice}
            </div>
          )}
          {panel.modelRow === 'list' && (
            <>
              <Combobox.List className={styles.modelPanelList} after={modelPanelEnd}>
                {(m: ComposerModelItem) => (
                  <Combobox.Item
                    key={m.id}
                    value={m}
                    tabIndex={-1}
                    showCheck={false}
                    data-model-option-id={m.id}
                    data-route-repair-target={m.id === repairTarget || undefined}
                    // 置灰时 title 挂**原因** —— 那一刻用户要问的是「为什么不能选」
                    // (owner 2026-08-21:选不了的那一头要说明原因)。能选的行不挂 title:
                    // 规格在悬浮详情卡里,原生提示再弹一遍就是同一件事说两次。
                    title={m.disabled ? (m.disabledReason ?? modelTitle(m, locale)) : undefined}
                    disabled={m.disabled}
                    className={`${styles.composerPanelItem} ${styles.modelPanelItemCompact}`}
                    {...detailHoverProps(m.id)}
                  >
                    {/* 上游每一行左边是**厂商 logo**(`ModelIcon`,14px 见方)。宿主给成品节点 —— 这个包够不到
                        app 的图片资源。认不出厂商的行画通用兜底(见上面 owner 11-25),❌ 留空位。 */}
                    <span
                      className={m.icon ? styles.composerPanelItemIcon : `${styles.composerPanelItemIcon} ${styles.modelPanelItemIconFallback}`}
                      data-slot="composer-model-icon"
                      data-fallback={m.icon ? undefined : ''}
                      aria-hidden="true"
                    >
                      {m.icon ?? <Sparkles size={14} />}
                    </span>
                    <span data-slot="composer-model-name" className={styles.modelPanelItemName}>
                      {m.name}
                    </span>
                    {m.tag && (
                      <span data-slot="composer-model-tag" className={styles.modelPanelItemTag}>
                        {m.tag}
                      </span>
                    )}
                    <span className={styles.modelPanelItemTrailing}>
                      {m.creditRate && <span className={styles.modelPanelItemRate} data-slot="composer-model-rate">{m.creditRate}</span>}
                      <span className={styles.modelPanelItemCheck} data-slot="composer-model-check" aria-hidden="true">
                        {m.id === selectedRowId && <Check className={styles.modelSelectedCheck} size={14} />}
                      </span>
                    </span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </>
          )}
          {/* 上游那段叫 **Thinking**,在 Content 最底下、清单之外,滚动列表时不跟着走。
              档位有几档、按什么顺序,都由 harness 说了算 —— codex 报 6 档、claude 活会话 7 档,
              ❌ 别按「Low/Med/High 三档」去裁:那是上游 demo 的取值,不是产品的。 */}
          <ComposerThinking effortItems={panel.modelRow === 'list' && !phoneActions ? [] : effortItems} selectedEffort={selectedEffort}
            onEffortChange={onEffortChange} defaultEffort={defaultEffort}
            fastMode={fastMode} onFastModeChange={onFastModeChange} renderFastModeHint={renderFastModeHint}
            disabled={disabled} phoneActions={phoneActions} onCommit={() => setModelPanelOpen(false)} />
        </Combobox.Content>
        {detailItem && (
          <HoverCard
            anchor={detailAnchor}
            ownPopup={panelEl}
            controller={detailCard}
            side="right"
            align="start"
            sideOffset={0}
            className={styles.modelDetailCard}
          >
            <ModelDetail key={detailItem.id} item={detailItem} contextThresholds={contextThresholds}
                efforts={detailEfforts} effort={detailIsSelected ? effectiveEffortItem
                  : detailEfforts?.find(level => level.id === detailItem.modelFeatures?.defaultEffortId)} keyboardEntry={keyboardEntry}
                onReturn={() => {
                  detailAnchor?.focus({ preventScroll: true });
                  detailCard.close();
                  setKeyboardEntry(0);
                }}
                onContextCommit={closeAfterSelection}
                contextEffort={detailIsSelected ? undefined : effortForModelSwitch(detailItem)}
                fastControl={detailIsSelected && panel.modelRow === 'list' && !phoneActions && fastMode !== undefined
                  ? <ComposerFastMode detailRow picker={panelEl} enabled={fastMode} disabled={disabled} onChange={onFastModeChange} renderHint={renderFastModeHint} />
                  : undefined}
                onDisabledAction={() => {
                  detailCard.close();
                  setModelPanelOpen(false);
                  detailItem.disabledAction?.open(() => {
                    setRepairTarget(detailItem.id);
                    openModelPanel();
                  });
                }}
                onEffortChange={detailIsSelected && !onEffortChange ? undefined : effortId => {
                  closeAfterSelection();
                  if (detailIsSelected) onEffortChange?.(effortId);
                  else onModelChange?.(detailItem.id, effortId);
                }} />
          </HoverCard>
        )}
      </Combobox.Root>
    </span>
  );
}
