/** Composer model list and its anchored model details. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Pencil, Search, Sparkles } from '../../../icons';
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
import * as styles from './chat-composer.css';
// 圆钮直径的**唯一真源** —— 填充末端要落在圆心上,这里跟着它算,❌ 别再写一遍字面量。
import { ComposerFastMode, type RenderFastModeHint } from './composer-fast-mode';
import { sideAwayFromPicker } from './detail-card-side';
import { ComposerThinking } from './composer-thinking';
import { Popover } from '@session-ui/react/primitives/popover';
import { ContextThresholdMenu, type ComposerContextThresholds } from './context-threshold';

import type {
  ComposerEffortItem,
  ComposerModelGroup,
  ComposerModelItem,
  ComposerModelUnlock,
  ComposerModelUpgrade,
} from './composer-options';

/** 底部「升级解锁」那一条在悬浮卡控制器里的 key —— 模型 id 都不会是这个串。 */
const UPGRADE_DETAIL_KEY = '\u0000upgrade';

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

// ── Model groups ──────────────────────────────────────────────────────────────

/**
 * 把模型条目按**相邻**的同组头切成若干段。
 *
 * ❌ 不照 buildAgentGroups 用 Map 按 label 收集:那会把不相邻的同名条目搬到一起,悄悄改掉
 * 调用方给的顺序。加个小标题不该有重排的副作用 —— 顺序是宿主排的,这里只切段。
 *
 * 一条都没有 groupLabel 时结果是「一段、label 为空」,渲染成原来的平铺列表(零回归)。
 */
export function buildComposerModelGroups(items: ComposerModelItem[]): ComposerModelGroup[] {
  const groups: ComposerModelGroup[] = [];
  for (const item of items) {
    const label = item.groupLabel ?? '';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
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
function ModelDetail({ item, picker, contextThresholds, efforts, effort, onEffortChange, fastControl, onDisabledAction }: {
  item: ComposerModelItem;
  picker: HTMLElement | null;
  contextThresholds?: ComposerContextThresholds;
  efforts?: ComposerEffortItem[];
  effort?: ComposerEffortItem;
  onEffortChange?: (id: string) => void;
  fastControl?: React.ReactNode;
  onDisabledAction?: () => void;
}) {
  const { translate } = useMessages();
  const f = item.modelFeatures;
  const threshold = !item.disabled ? contextThresholds?.(item.id, f?.contextWindowSize) : undefined;
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [effortMenuSide, setEffortMenuSide] = useState<'left' | 'right' | 'bottom'>('left');
  const effortTrigger = useRef<HTMLButtonElement>(null);
  const canEditEffort = !!efforts?.length && !!onEffortChange;
  const effortLabel = translate('composer.effort');
  const lockedEffortReasonId = React.useId();
  const lockedEffortReason = efforts?.length && efforts.every(level => level.disabled)
    ? efforts[0]?.disabledReason ?? translate('composer.effortLocked') : undefined;
  const facts = [
    ...(!threshold && f?.contextWindowSize !== undefined
      ? [{ label: translate('composer.modelDetailContext'), value: formatContextWindow(f.contextWindowSize) }]
      : []),
    ...(item.facts ?? []).filter(({ label }) => !canEditEffort || label !== effortLabel),
    ...(f?.speed !== undefined ? [{ label: translate('composer.modelDetailSpeed'), value: `${f.speed}/5` }] : []),
    ...(f?.intelligence !== undefined
      ? [{ label: translate('composer.modelDetailIntelligence'), value: `${f.intelligence}/5` }]
      : []),
  ];
  return (
    <div data-slot="composer-model-detail" style={{ display: 'contents' }}>
      <div className={styles.modelDetailHead}>
        {item.icon && (
          <span className={styles.modelTriggerIcon} aria-hidden="true">
            {item.icon}
          </span>
        )}
        <span className={styles.modelDetailName}>{item.name}</span>
        {item.tag && <span className={styles.modelPanelItemTag}>{item.tag}</span>}
      </div>
      {item.groupLabel && <div className={styles.modelDetailTier}>{item.groupLabel}</div>}
      {item.description && <p className={styles.modelDetailSummary}>{item.description}</p>}
      {facts.length > 0 && (
        <dl className={styles.modelDetailFacts}>
          {facts.map((fact) => (
            <React.Fragment key={fact.label}>
              <dt className={styles.modelDetailFactLabel}>{fact.label}</dt>
              <dd className={styles.modelDetailFactValue}>{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {canEditEffort && (
        <Popover.Root open={effortMenuOpen} onOpenChange={open => {
          if (open) {
            const side = sideAwayFromPicker(effortTrigger.current, picker, 192);
            if (side) setEffortMenuSide(side);
          }
          setEffortMenuOpen(open);
        }}>
          <Popover.Trigger ref={effortTrigger} openOnHover delay={100} closeDelay={300} className={styles.contextThresholdTrigger}>
            <span>{effortLabel}</span>
            <span className={styles.modelDetailControlValue}>{effort?.name}<ChevronRight size={14} aria-hidden /></span>
          </Popover.Trigger>
          <Popover.Content side={effortMenuSide} sideOffset={effortMenuSide === 'bottom' ? 4 : 16} align="start" className={styles.contextThresholdContent}>
            {efforts.map(level => (
              <button type="button" key={level.id} disabled={level.disabled} aria-pressed={effort?.id === level.id}
                className={styles.contextThresholdOption} title={level.disabledReason}
                aria-describedby={lockedEffortReason ? lockedEffortReasonId : undefined}
                onClick={() => { onEffortChange(level.id); setEffortMenuOpen(false); }}>
                {level.name}{effort?.id === level.id && <Check size={14} aria-hidden />}
              </button>
            ))}
            {lockedEffortReason && <p id={lockedEffortReasonId} className={styles.effortMenuLockedReason}>{lockedEffortReason}</p>}
          </Popover.Content>
        </Popover.Root>
      )}
      {fastControl}
      {threshold?.unsupported && (
        <div className={styles.contextThresholdTrigger}>
          <span>{translate('composer.contextWindowThreshold')}</span>
          <span className={styles.modelDetailControlValue}>{translate('composer.contextThresholdUnsupported')}</span>
        </div>
      )}
      {threshold?.set && <ContextThresholdMenu threshold={threshold} hover label={
        <><span>{translate('composer.contextWindowThreshold')}</span>
          <span className={styles.modelDetailControlValue}>{formatContextWindow(threshold.value ?? threshold.maximum)}</span></>
      } />}
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
  onModelChange?: (modelId: string) => void;
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

export function ComposerModelMenu({
  panel,
  disabled = false,
  triggerTitle,
  modelItems,
  selectedModel,
  modelUnknown = false,
  onModelChange,
  openRequest,
  settingNotice,
  menuNotice,
  onOpen,
  modelUnlock,
  onModelUnlock,
  onManageModels,
  modelUpgrade,
  onModelUpgrade,
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
  onOpenRef.current = onOpen;
  const openModelPanel = useCallback(() => {
    onOpenRef.current?.();
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
  const focusDetail = useRef(false);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const [repairTarget, setRepairTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!panelEl || !modelPanelOpen || !repairTarget) return;
    panelEl.querySelector(`[data-model-option-id="${CSS.escape(repairTarget)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [panelEl, modelPanelOpen, repairTarget]);

  if (panel.kind !== 'shown') return null;

  /**
   * 一行的悬停:记下贴哪一条,再交给控制器去延时开卡。
   * ⚠️ 卡贴的必须是**和面板一样宽**的那一条(整行)—— 末尾那两条去路也是整行宽的按钮,同样贴它自己。
   */
  const detailHoverProps = (key: string) => detailCard.getRowHoverProps(key, (element) => {
    focusDetail.current = false;
    setDetailAnchor(element);
  });
  const detailItem =
    detailCard.activeKey && detailCard.activeKey !== UPGRADE_DETAIL_KEY
      ? (modelItems.find((m) => m.id === detailCard.activeKey) ?? null)
      : null;
  const showUpgradeDetail = detailCard.activeKey === UPGRADE_DETAIL_KEY && !!modelUpgrade;

  // While what decides the model is unknown, the selected id is only a guess (the harness default before the remembered
  // choice is read): the trigger holds the name's place, ❌ draws the guess and then switches (@@@unknown-slot).
  const selectedModelItem = selectedModel && !modelUnknown
    ? (modelItems.find((m) => m.id === selectedModel) ?? null)
    : null;
  const selectedEffortItem = effortItems.find(item => item.id === selectedEffort);
  const defaultEffortItem = effortItems.find(item => item.id === defaultEffort);
  const effectiveEffortItem = selectedEffortItem ?? defaultEffortItem;

  // 选中项要**从清单里取同一个对象**递给 Combobox:它按 isItemEqualToValue 比,
  // 但触发器上的回显走的是这个值 —— 现拼一个新对象会让「当前选中」在重渲染间抖。
  const selectedModelEntry = selectedModelItem
    ? { ...selectedModelItem, id: selectedModelItem.id }
    : null;

  /**
   * 每一行都有图标(owner 11-25):认得出厂商画厂商 logo,认不出的画一枚通用的 ✦ 兜底(淡色,`data-fallback`)。
   * 以前认不出就留空位 —— 名字不错位,但那一行左边是个洞,看着像没做完。
   */

  /**
   * 一张平的清单:❌ 组头、❌ 顶上那排厂商筛选块(owner 11-25:「删掉模型选择列表头上的分组」)。
   * 每行是谁的由行尾的标签说(咕咕的不带),找某一家用搜索框 —— 它照样匹配厂商名(`providerLabel`)。
   */
  const visibleModels = modelItems.filter((item) => !item.hiddenFromPicker);
  const visibleModelGroups = [{ label: '', items: visibleModels }];

  const modelPanelEnd = (
    <>
      <Combobox.Empty>{translate('composer.noMatchingModels')}</Combobox.Empty>
      {/* 末尾两条去路(#7056):「升级解锁更多模型」只给免费档,悬停看得到开会员后多出哪几个;
          「配置模型」开设置里的「模型」页,永远是最后一行。 */}
      {(onManageModels || modelUpgrade) && (
        <div className={styles.modelPanelActions} data-slot="composer-model-footer">
          {modelUpgrade && (
            <button
              type="button"
              className={styles.modelPanelUpgrade}
              onClick={() => {
                detailCard.close();
                onModelUpgrade?.();
              }}
              data-testid="composer-model-upgrade"
              {...detailHoverProps(UPGRADE_DETAIL_KEY)}
            >
              <span className={styles.composerPanelItemIcon} aria-hidden="true" />
              {modelUpgrade.label}
            </button>
          )}
          {onManageModels && (
            <button
              type="button"
              className={styles.modelPanelActionRow}
              onClick={() => {
                detailCard.close();
                setModelPanelOpen(false);
                onManageModels();
              }}
              data-testid="composer-model-manage"
            >
              <span className={styles.composerPanelItemIcon} aria-hidden="true"><Pencil size={14} /></span>
              {translate('composer.manageModels')}
            </button>
          )}
        </div>
      )}
    </>
  );

  return (
    // `display:contents` —— 这层只为寻址存在,不参与布局(工具栏是 flex,
    // 真占一个盒子会把间距挤歪)。上游给触发器挂的是 `model-selector-trigger`,
    // 本仓 primitive 自己的 data-slot 不许被调用点顶掉(见 combobox 的
    // FixedDataSlotProps),所以那个名字落在外面这一层。
    <span data-slot="composer-model" style={{ display: 'contents' }}>
      <Combobox.Root
        // items 必须传:Combobox 的 filter 只作用于它自己持有的 items。
        // 同 agent 选择器踩过的那个坑(能打字、一行都不过滤)。
        items={visibleModelGroups}
        value={selectedModelEntry}
        onValueChange={(item: ComposerModelItem | null) => {
          if (!item) return;
          detailCard.close();
          setRepairTarget(null);
          onModelChange?.(item.id);
          setModelPanelOpen(false);
        }}
        open={modelPanelOpen}
        onOpenChange={(next: boolean, details: ComboboxRootChangeEventDetails) => {
          // 鼠标移进悬浮卡不算「离开面板」:与 ComboboxPopover 同一条判据,❌ 一碰卡面板就关。
          if (!next && isEventInsideInteractiveLayer(details.event, panelEl)) {
            details.cancel();
            return;
          }
          if (!next) { detailCard.close(); setRepairTarget(null); }
          if (next) openModelPanel();
          else setModelPanelOpen(false);
        }}
        isItemEqualToValue={(a: ComposerModelItem, b: ComposerModelItem) => a.id === b.id}
        // 上游:匹配 id、name 与 keywords(它的 demo 正是把厂商名放在 keywords 里)。
        // 本仓没有 keywords 字段,同一职责由这几格承担 —— 打「咕咕」筛得出平台那一档,打「智谱」筛得出那一家,
        // 打行尾标签上的字(「ChatGPT」「deepseek」)筛得出那一份登录 / 那条连接。
        filter={(item: ComposerModelItem, query: string) => {
          const q = query.toLowerCase();
          return (
            item.name.toLowerCase().includes(q) ||
            item.id.toLowerCase().includes(q) ||
            (item.groupLabel ?? '').toLowerCase().includes(q) ||
            (item.providerLabel ?? '').toLowerCase().includes(q) ||
            (item.tag ?? '').toLowerCase().includes(q)
          );
        }}
        autoHighlight
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
                  selectedModelItem.shortName ?? selectedModelItem.name,
                  modelItems.map((m) => m.shortName ?? m.name)
                )
              : modelUnknown
              ? <span aria-busy="true" data-unknown="" className="gg-unknown" style={UNKNOWN_MODEL_NAME} />
              : translate('composer.model')}
          </span>
          {/* 强度就地显示(如「5.6 Sol 轻度」)。armed 的用 muted;
              没 armed 时退回该模型自己的默认档,再压一档不透明度 —— 那是目录里的出厂
              默认,用户写在 ~/.codex/config.toml 里的值会盖过它,我们读不到。 */}
          {effectiveEffortItem && !modelUnknown ? (
            <span
              data-slot="composer-effort"
              className={styles.modelTriggerEffort}
              style={{ opacity: selectedEffortItem ? 1 : 0.6 }}
            >
              {effectiveEffortItem.name}
            </span>
          ) : null}
          {/* @@@composer-no-chevron — ❌ 不画下拉箭头(owner 2026-09-07:「下拉按钮这个 icon
              都删除」,底排三枚一并撤)。三枚箭头本身不携带信息:一个 hover 会变底色的药丸,
              点开就是清单,箭头只是把同一件事再说一遍,却占掉三份横向空间 ——
              而这一排正是「放不下」压力最大的地方(见 use-toolbar-disclosure)。
              ⚠️ 09-05 owner 曾就**渐进披露把箭头当一档收掉**判过「箭头收了不合适」;
              09-07 是看着去箭头的设计稿定的「都删除」,按新的来。要翻回去,这三处一起加回。 */}
        </Combobox.Trigger>
        {/* 定宽 18rem = 上游 `w-72`(288px)。
            ⚠️ 这里替掉的是 #5082 的 `width="content"` —— 那条修的是「面板跟着**触发器**宽度
            走」(`--anchor-width`,只有十几个字符宽,于是标签折两行、模型名折行被下沿裁掉)。
            288px 比触发器宽得多,同一个病照样治好;差别只在超长名字是省略号还是把面板撑宽,
            而上游那版就是省略号(`truncate`)。owner 2026-09-06 在实机上看过这一版并认可。
            ⇒ 换了机制、没丢那条修复;要回到「按内容撑宽」,改这一个 className 即可。 */}
        <Combobox.Content ref={setPanelEl} className={styles.modelPanelContent} side="top" align="end" sideOffset={8}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' || !event.altKey) return;
            const active = event.currentTarget.querySelector<HTMLElement>('[role="option"][data-highlighted], [role="option"][data-selected]');
            const key = active?.dataset.modelOptionId;
            if (!active || !key) return;
            event.preventDefault();
            focusDetail.current = true;
            setDetailAnchor(active);
            detailCard.show(key);
          }}>
          {(settingNotice || menuNotice) && (
            <div role="status" className={styles.modelSettingNotice} data-testid="composer-model-setting-notice">
              {settingNotice || menuNotice}
            </div>
          )}
          {panel.modelRow === 'list' ? (
            <>
              <Combobox.Input
                showTrigger={false}
                // 上游的 CommandInput 自带一枚放大镜,少了它这一格看着像个普通文本框。
                leftAddon={<Search />}
                aria-label={translate('composer.searchModels')}
                placeholder={translate('composer.searchModels')}
                data-testid="composer-model-search"
              />
              {/* 「去登录」排在清单**最前面**(owner 2026-08-28:放末尾时它躺在咕咕那
                  15 个模型下面,「我翻了半天才找到」)。
                  ❌ 不进 Combobox.List:它不是这份清单里的一个取值,选了它不会变成
                  「当前模型」;放在 List 外面才不会被读屏器报成一个可选项,也不会被
                  搜索过滤掉 —— 正在找模型的人更需要看见它。 */}
              {modelUnlock ? (
                <div className={styles.modelFilterRow}>
                  <span className={styles.modelEffortLabel}>{modelUnlock.groupLabel}</span>
                  <button
                    type="button"
                    className={styles.settingRowUnlock}
                    title={modelUnlock.title}
                    // 这颗钮跟着清单一起收走;登录菜单贴在常驻的模型触发器上,❌ 贴在一个马上离开页面的元素上。
                    onClick={event => { onModelUnlock?.(modelTrigger.current ?? event.currentTarget); setModelPanelOpen(false); }}
                    data-testid="composer-model-unlock"
                  >
                    {modelUnlock.label}
                    {modelUnlock.detail ? <span className={styles.modelEffortLabel}>{modelUnlock.detail}</span> : null}
                  </button>
                </div>
              ) : null}
              {/* 清单与末尾两条去路在**同一个**滚动区里(owner 11-25:「配置模型」不是钉死的一栏,
                  是列表最后一行、跟着列表滚)。去路走 `after`:在滚动区里、在 List 元素外 ——
                  它们不是取值,不该被读屏器报成可选项,也不该被搜索滤掉。 */}
              <Combobox.List className={styles.modelPanelList} after={modelPanelEnd}>
                {(group: ComposerModelGroup) => (
                  // key 用首条的模型 id,不用 label:同一个 label 可以出现在两段不相邻
                  // 的条目上(宿主的顺序说了算),用 label 当 key 就会撞。
                  <Combobox.Group key={group.items[0]?.id} items={group.items} label={group.label}>
                    <Combobox.Collection>
                      {(m: ComposerModelItem) => (
                        <Combobox.Item
                          key={m.id}
                          value={m}
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
                              {m.id === (selectedModelItem?.aliasOf ?? selectedModel) && <Check className={styles.modelSelectedCheck} size={14} />}
                            </span>
                          </span>
                        </Combobox.Item>
                      )}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
            </>
          ) : null}
          {/* 上游那段叫 **Thinking**,在 Content 最底下、清单之外,滚动列表时不跟着走。
              档位有几档、按什么顺序,都由 harness 说了算 —— codex 报 6 档、claude 活会话 7 档,
              ❌ 别按「Low/Med/High 三档」去裁:那是上游 demo 的取值,不是产品的。 */}
          <ComposerThinking effortItems={panel.modelRow === 'list' && !phoneActions ? [] : effortItems} selectedEffort={selectedEffort}
            onEffortChange={onEffortChange} defaultEffort={defaultEffort}
            fastMode={fastMode} onFastModeChange={onFastModeChange} renderFastModeHint={renderFastModeHint}
            disabled={disabled} phoneActions={phoneActions} onCommit={() => setModelPanelOpen(false)} />
        </Combobox.Content>
        {(detailItem || showUpgradeDetail) && (
          <HoverCard
            anchor={detailAnchor}
            ownPopup={panelEl}
            controller={detailCard}
            // 面板贴着底排右侧往上开,右边常常没地方 —— 卡放左边,与 Cursor 同侧;贴不下时定位器自己翻。
            side="right"
            align="start"
            sideOffset={8}
            className={styles.modelDetailCard}
            initialFocus={focusDetail.current}
          >
            {detailItem ? (
              <ModelDetail key={detailItem.id} item={detailItem} picker={panelEl} contextThresholds={contextThresholds}
                efforts={detailItem.id === selectedModel ? effortItems : undefined} effort={effectiveEffortItem}
                fastControl={detailItem.id === selectedModel && panel.modelRow === 'list' && !phoneActions && fastMode !== undefined
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
                onEffortChange={onEffortChange} />
            ) : modelUpgrade ? (
              <div data-slot="composer-model-detail" style={{ display: 'contents' }}>
                <div className={styles.modelDetailName}>{modelUpgrade.title}</div>
                <ul className={styles.modelDetailList}>
                  {modelUpgrade.models.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </HoverCard>
        )}
      </Combobox.Root>
    </span>
  );
}
