/**
 * 模型 + 推理强度 —— 底排右组那颗触发器，以及它点开的**一层**面板。
 *
 * 从 `index.tsx` 拆出来（#4981 A1，理由见 `composer-options.ts` 顶部）。渲染出来的 DOM、
 * `data-slot` / `data-testid` / 类名 / 结构层级与 dev 上 #5110 那版逐字节相同 —— 它们是对外契约
 * （见 `index.tsx` 顶部的 slot 词汇表），`composer-model-menu-3249.test.tsx`、
 * `composer-settings-row-layout.test.tsx`、`composer-surface-3334.test.tsx` 正按它们选元素。
 *
 * ## 解剖（照 assistant-ui「With search, provider filters + groups」那一版）
 *
 * owner 2026-09-05 令严格套用;上游 demo 源码见
 * apps/docs/components/pages/docs/samples/model-selector.tsx。
 * 上游那版是**一层**面板:搜索框 → 厂商药丸 → 分组清单 → 底部 Thinking 行。
 * 原来「设置菜单 → 模型子菜单 / 强度子菜单」两级拍平成一层 —— 模型和强度本来就是同一次
 * 决定的两半,分两级要多点两下才看得见档位。
 *
 * ⚠️ **推翻了旧注释**「❌ 不再给模型列表配搜索框:声明了模型的 5 家最多 6 个」——
 * 那句话写在平台模型进这个下拉**之前**;现在一份清单里是 harness 自己那几个 + 咕咕十几个,
 * owner 2026-08-28 已经报过「我翻了半天才找到」。前提变了,结论跟着变。
 *
 * ⚠️ 底座是 Base UI(与旁边 agent 选择器同一套),❌ 不装 @assistant-ui/react(仓规:那会带进
 * Radix 与第二份 runtime)。上游那版的过滤条本身用的就是 Base UI 的 ToggleGroup/Toggle,
 * 这一段是逐件对应,不是另起炉灶。
 *
 * ## 两级分类(owner 2026-09-06 定)
 *
 * 一级 = **这条是谁的**(组头);二级 = **厂商**(顶部筛选药丸 + 行内 logo,❌ 不分组)。
 * 理由在产品上:用户先要决定的是这次调用记在谁账上,厂商是在那之后才挑的。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from '../../../icons';
import { Combobox } from '@session-ui/react/primitives/combobox/combobox';
// 上游那版的过滤条用的就是 Base UI 的这两件(见 model-selector.tsx 的
// `import { ToggleGroup } from "@base-ui/react/toggle-group"`)—— 逐件对应,不是另起炉灶。
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Toggle } from '@base-ui/react/toggle';
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
import type { RenderFastModeHint } from './composer-fast-mode';
import { ComposerThinking } from './composer-thinking';

import type {
  ComposerEffortItem,
  ComposerModelGroup,
  ComposerModelItem,
  ComposerModelUnlock,
  ComposerModelUpgrade,
} from './composer-options';

/** 底部「升级解锁」那一条在悬浮卡控制器里的 key —— 模型 id 都不会是这个串。 */
const UPGRADE_DETAIL_KEY = '\u0000upgrade';

/** 厂商过滤条一行最多几格 —— 264px 里第五格就放不下 `Anthropic` 了。 */
const PROVIDER_FILTER_MAX_COLUMNS = 4;

/**
 * 厂商过滤条每行几格:先算要几行,再按行均分 —— 5 家排成 3 + 2,而不是 4 + 1 留一格孤零零挂在第二行。
 */
export function providerFilterColumns(count: number): number {
  const rows = Math.ceil(count / PROVIDER_FILTER_MAX_COLUMNS);
  return Math.ceil(count / rows);
}

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
function ModelDetail({ item }: { item: ComposerModelItem }) {
  const { translate } = useMessages();
  const f = item.modelFeatures;
  const facts = [
    ...(f?.contextWindowSize !== undefined
      ? [{ label: translate('composer.modelDetailContext'), value: formatContextWindow(f.contextWindowSize) }]
      : []),
    ...(item.facts ?? []),
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
      {item.disabled && item.disabledReason && (
        <p className={styles.modelDetailSummary}>{item.disabledReason}</p>
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

export function ComposerModelMenu({
  panel,
  disabled = false,
  triggerTitle,
  modelItems,
  selectedModel,
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
  effortItems,
  selectedEffort,
  onEffortChange,
  defaultEffort,
  fastMode,
  onFastModeChange,
  renderFastModeHint,
  phoneActions,
}: ComposerModelMenuProps) {
  const { translate, locale } = useMessages();

  /**
   * 厂商过滤条选了哪几家。**空集 = 不过滤**(上游原话:An empty filter means no
   * filtering — all providers are shown)。❌ 别把「一个都没选」实现成「一条都不显示」:
   * 那会让用户一进面板就看见空清单。
   */
  const [modelProviderFilter, setModelProviderFilter] = useState<ReadonlySet<string>>(new Set());
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
  const detailCard = useHoverCard();
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);

  if (panel.kind !== 'shown') return null;

  /**
   * 一行(或底部那条)的悬停:记下贴哪一条,再交给控制器去延时开卡。
   * ⚠️ 卡贴的必须是**和面板一样宽**的那一条(整行 / 整条底栏)—— 贴在右端那枚按钮上,卡会往左压回面板里
   * (实机截图里盖住了半张清单)。
   */
  const detailHoverProps = (key: string) => {
    const row = detailCard.getRowHoverProps(key);
    return {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        setDetailAnchor(
          event.currentTarget.closest<HTMLElement>('[data-slot="composer-model-footer"]') ?? event.currentTarget
        );
        row.onMouseEnter(event);
      },
      onMouseLeave: row.onMouseLeave,
    };
  };
  const detailItem =
    detailCard.activeKey && detailCard.activeKey !== UPGRADE_DETAIL_KEY
      ? (modelItems.find((m) => m.id === detailCard.activeKey) ?? null)
      : null;
  const showUpgradeDetail = detailCard.activeKey === UPGRADE_DETAIL_KEY && !!modelUpgrade;

  const selectedModelItem = selectedModel
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
   * 这一列要不要留出图标位。
   *
   * ⚠️ 判据是「**有没有条目认得出厂商**」,不是「这一条认不认得出」。实机撞到的:claude 的
   * 「Default (recommended)」不带任何厂商词根 ⇒ 认不出 ⇒ 那一行不画图标位 ⇒ 名字比其余 18 行
   * **左移 22px**,而它恰好是列表第一条。缺一枚 logo 只是信息少一点,整行错位看着就是坏了。
   * ⇒ 只要这一列有人有图标,所有行都留位;整列都没有(某些 harness)才不留 —— 那时不存在错位。
   */
  const anyModelIcon = modelItems.some((m) => m.icon);

  /**
   * 药丸 = **厂商**(二级),按它们在清单里的先后(= 屏幕上的先后)。
   *
   * ❌ 不排序:顺序是宿主定的产品决定(用户自己那档在前)。
   * ⚠️ 同一家厂商在两档里各出现一次时**只出一枚药丸** —— 药丸问的是「哪家厂商」,
   * 一家出两枚会让人以为是两家。
   */
  const modelProviderLabels = [
    ...new Set(modelItems.map((m) => m.providerLabel).filter((l): l is string => Boolean(l))),
  ];

  /**
   * 厂商过滤**作用在条目上,不是整段上** —— 厂商横切在两档之上,筛 OpenAI 要把两档里的
   * OpenAI 条目都留下。先筛条目再切段,于是空掉的那一档自然消失,留下的组头照旧。
   */
  const visibleModelGroups = buildComposerModelGroups(
    modelProviderFilter.size === 0
      ? modelItems
      : modelItems.filter((m) => m.providerLabel && modelProviderFilter.has(m.providerLabel))
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
          if (!next) detailCard.close();
          if (next) openModelPanel();
          else setModelPanelOpen(false);
        }}
        isItemEqualToValue={(a: ComposerModelItem, b: ComposerModelItem) => a.id === b.id}
        // 上游:匹配 id、name 与 keywords(它的 demo 正是把厂商名放在 keywords 里)。
        // 本仓没有 keywords 字段,两级分类承担同一职责 —— 打「咕咕」筛得出平台那一档
        // (一级),打「智谱」筛得出那一家(二级)。
        filter={(item: ComposerModelItem, query: string) => {
          const q = query.toLowerCase();
          return (
            item.name.toLowerCase().includes(q) ||
            item.id.toLowerCase().includes(q) ||
            (item.groupLabel ?? '').toLowerCase().includes(q) ||
            (item.providerLabel ?? '').toLowerCase().includes(q)
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
              : translate('composer.model')}
          </span>
          {/* 强度就地显示(如「5.6 Sol 轻度」)。armed 的用 muted;
              没 armed 时退回该模型自己的默认档,再压一档不透明度 —— 那是目录里的出厂
              默认,用户写在 ~/.codex/config.toml 里的值会盖过它,我们读不到。 */}
          {effectiveEffortItem ? (
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
        <Combobox.Content ref={setPanelEl} className={styles.modelPanelContent}>
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
              {/* 厂商过滤条 —— 上游那排药丸就是厂商(OpenAI / Google / xAI / DeepSeek
                  / Groq),本仓照抄这根轴。
                  ⚠️ 只有一家时不渲染:一枚药丸筛不出任何东西,是纯噪音。
                  ⚠️ 空选 = 不过滤(上游同款语义:An empty filter means no filtering)。
                  ⚠️ ❌ 别把「你的 / 咕咕提供的」摆回这排 —— 那是一级分类,组头说。 */}
              {modelProviderLabels.length > 1 && (
                <div className={styles.modelFilterRow}>
                <ToggleGroup
                  multiple
                  value={[...modelProviderFilter]}
                  onValueChange={(next: unknown) =>
                    setModelProviderFilter(new Set((next as string[]) ?? []))
                  }
                  aria-label={translate('composer.filterByProvider')}
                  className={styles.modelProviderFilter}
                  // 等分(owner 2026-10-10:「按钮块的大小能保持一致,智谱那块太小了不好点」)。
                  // 一行最多四格 —— 264px 里放第五格,`Anthropic` 就放不下了;多出来的按行均分(7 家 = 4 + 3)。
                  style={{ gridTemplateColumns: `repeat(${providerFilterColumns(modelProviderLabels.length)}, minmax(0, 1fr))` }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                    // 照上游那三条键盘让路(它对着 cmdk 写,这里对着 Combobox 的输入框):
                    // Enter/Home/End 不许被列表抢走 —— 否则焦点在药丸上按回车,选中的
                    // 是高亮那条模型而不是切换这枚药丸。
                    if (e.key === 'Enter' || e.key === 'Home' || e.key === 'End') {
                      e.stopPropagation();
                    }
                    // 上下键把焦点交还给清单,与上游「matching the packaged Thinking row」同。
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      const input = e.currentTarget
                        .closest('[data-slot="combobox-content"], [role="dialog"]')
                        ?.querySelector<HTMLInputElement>('input');
                      input?.focus();
                    }
                  }}
                >
                  {modelProviderLabels.map((label) => (
                    <Toggle
                      key={label}
                      value={label}
                      className={styles.modelFilterChip}
                      // 等分之后长名字可能被截成省略号,悬停读得到全名。
                      title={label}
                      data-testid={`composer-model-provider-${label}`}
                    >
                      {label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                </div>
              )}
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
              <Combobox.List className={styles.settingSubContent}>
                {(group: ComposerModelGroup) => (
                  // key 用首条的模型 id,不用 label:同一个 label 可以出现在两段不相邻
                  // 的条目上(宿主的顺序说了算),用 label 当 key 就会撞。
                  <Combobox.Group key={group.items[0]?.id} items={group.items}>
                    {/* 组头 = 一级分类(这条是谁的)。与上游一样是一行纯文字。
                        厂商不在这里 —— 它在顶部那排筛选药丸和每行左边那枚 logo 上。 */}
                    {group.label && <Combobox.Label>{group.label}</Combobox.Label>}
                    <Combobox.Collection>
                      {(m: ComposerModelItem) => (
                        <Combobox.Item
                          key={m.id}
                          value={m}
                          // 置灰时 title 挂**原因** —— 那一刻用户要问的是「为什么不能选」
                          // (owner 2026-08-21:选不了的那一头要说明原因)。能选的行不挂 title:
                          // 规格在悬浮详情卡里,原生提示再弹一遍就是同一件事说两次。
                          title={m.disabled ? (m.disabledReason ?? modelTitle(m, locale)) : undefined}
                          disabled={m.disabled}
                          className={`${styles.composerPanelItem} ${styles.modelPanelItemCompact}`}
                          {...detailHoverProps(m.id)}
                        >
                          {/* 上游每一行左边是**厂商 logo**(`ModelIcon`,14px 见方,
                              与首行基线对齐)。宿主给成品节点 —— 这个包够不到 app 的
                              图片资源。
                              ⚠️ 认不出厂商时**位子照留、内容为空**(见 `anyModelIcon`):
                              ❌ 不画一个通用占位图形(那是假装认得),❌ 也不收掉这一格
                              (那会让这一行的名字比别行左移 22px,实机上第一行正是如此)。 */}
                          {anyModelIcon && (
                            <span
                              className={styles.composerPanelItemIcon}
                              data-slot="composer-model-icon"
                              aria-hidden="true"
                            >
                              {m.icon}
                            </span>
                          )}
                          {/* 单行(#7056,owner 2026-10-10 看着 Cursor:「表达密度可以更丰富、更紧凑一点」):
                              只有名字。说明、倍率、上下文、推理档都在悬浮详情卡里 —— 行尾曾经写过倍率,
                              owner 同日:「卡片里已经展示过了,右侧就不要再展示了」。
                              ⚠️ 这里替掉的是 09-05 照 assistant-ui 做的两段式:那一版一屏只放得下五六条,
                              第二行又被 288px 截成省略号。要翻回去,连悬浮卡一起想。 */}
                          <span data-slot="composer-model-name" className={styles.modelPanelItemName}>
                            {m.name}
                          </span>
                        </Combobox.Item>
                      )}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
              <Combobox.Empty>{translate('composer.noMatchingModels')}</Combobox.Empty>
              {/* 底部两条去路(#7056):「管理模型」开设置里的「模型」页 —— 哪些出现在这张清单里由那一页的开关定;
                  「升级解锁更多模型」只给免费档,悬停看得到开会员后多出哪几个。
                  ❌ 不进 Combobox.List:它们不是取值,不该被读屏器报成可选项,也不该被搜索滤掉。 */}
              {(onManageModels || modelUpgrade) && (
                <div className={styles.modelPanelFooter} data-slot="composer-model-footer">
                  {onManageModels ? (
                    <button
                      type="button"
                      className={styles.modelPanelFooterAction}
                      onClick={() => {
                        detailCard.close();
                        setModelPanelOpen(false);
                        onManageModels();
                      }}
                      data-testid="composer-model-manage"
                    >
                      {translate('composer.manageModels')}
                    </button>
                  ) : (
                    <span />
                  )}
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
                      {modelUpgrade.label}
                    </button>
                  )}
                </div>
              )}
            </>
          ) : null}
          {/* 上游那段叫 **Thinking**,在 Content 最底下、清单之外,滚动列表时不跟着走。
              档位有几档、按什么顺序,都由 harness 说了算 —— codex 报 6 档、claude 活会话 7 档,
              ❌ 别按「Low/Med/High 三档」去裁:那是上游 demo 的取值,不是产品的。 */}
          <ComposerThinking effortItems={effortItems} selectedEffort={selectedEffort}
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
            side="left"
            align="center"
            sideOffset={8}
            className={styles.modelDetailCard}
          >
            {detailItem ? (
              <ModelDetail item={detailItem} />
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
