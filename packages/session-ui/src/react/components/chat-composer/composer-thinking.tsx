import React, { useId, useState } from 'react';
import { Slider } from '@base-ui/react/slider';
import { RotateCcw } from '../../../icons';
import { useMessages } from '../../localization/message-provider';
import type { ComposerEffortItem } from './composer-options';
import { ComposerFastMode, type RenderFastModeHint } from './composer-fast-mode';
import * as styles from './chat-composer.css';
import { EFFORT_THUMB_VAR } from './chat-composer.css';

export interface ComposerThinkingProps {
  effortItems: ComposerEffortItem[];
  selectedEffort?: string;
  onEffortChange?: (id: string) => void;
  defaultEffort?: string;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  renderFastModeHint?: RenderFastModeHint;
  disabled?: boolean;
  phoneActions?: boolean;
}

/** The same native thinking axis is used in the model picker and the phone Work panel. */
export function ComposerThinking({ effortItems, selectedEffort, onEffortChange, defaultEffort,
  fastMode, onFastModeChange, renderFastModeHint, disabled, phoneActions }: ComposerThinkingProps) {
  const { translate } = useMessages();
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const effortHintId = `${useId()}-effort-hint`;
  const selectedEffortItem = selectedEffort
    ? (effortItems.find((e) => e.id === selectedEffort) ?? null)
    : null;
  const defaultEffortItem = defaultEffort
    ? (effortItems.find((e) => e.id === defaultEffort) ?? null)
    : null;
  const resetEffortItem = defaultEffortItem ?? effortItems.find((e) => e.id === 'default');
  // The trigger and the Thinking row must describe the same effective level. A model default is
  // not an explicit user override, but it is still the level currently in effect when no override
  // exists; leaving it out of the radio value makes the trigger say one level while the panel says
  // that nothing is selected.
  const effectiveEffortItem = selectedEffortItem ?? defaultEffortItem;
  /**
   * 滑杆上的位置 = 这一档在目录里的**序号**。
   *
   * ⚠️ 顺序由 harness 自己给(目录是它经 ACP 报上来的那份,见 create-efforts.ts),
   * composer ❌ 不重排、也不按 id 猜深浅:全库那条规范阶梯
   * (`none < minimal < low < medium < high < xhigh < max < ultra`,见 effort-options.ts)
   * 只覆盖已知的词表,harness 自定义的档(claude 活会话报的 `Default` / `UltraCode`)不在里面。
   * 拿一条自编的顺序去画标尺,等于对用户宣称一个我们并不知道的深浅关系。
   */
  /**
   * 面板里**此刻显示**的那一档 —— 拖动中是圆钮下那一档，否则是已生效的那一档。
   *
   * 圆钮位置、读数、说明行、读屏器念的档名都只读这一个值(#6309:说明行曾读已生效那一档,
   * 拖动中圆钮走了、字没动,松手才跟上)。交给宿主仍只在松手时发生;「和当前档相同就不发」
   * 的判据比的是**已生效**那一档(`effectiveEffortItem`),❌ 别换成这个。
   */
  const shownEffortItem =
    (draggingIndex !== null ? effortItems[draggingIndex] : undefined) ?? effectiveEffortItem;
  /** 拖动中的那一档就是用户正在选的 —— 与「显式覆盖」同样不压暗。 */
  const shownIsUserPick = draggingIndex !== null || !!selectedEffortItem;
  const effortIndex = shownEffortItem
    ? effortItems.findIndex((e) => e.id === shownEffortItem.id)
    : -1;
  /**
   * 整条滑杆能不能动。
   *
   * 宿主置灰档位是**整组一起**的(会话中途读不到档位目录时,acp-chat-panel 对每一档都挂
   * `disabled` + 同一条原因)。滑杆是一条连续的轴,没有"跳过中间某一档"的表达方式 ——
   * 所以只要有一档动不了就整条动不了,并把那条原因挂上去。
   * ❌ 不做"部分可选"的假象:那会让用户拖到一档、手一松又弹回去。
   */
  const lockedEffort = effortItems.find((e) => e.disabled) ?? null;
  const effortLocked = lockedEffort !== null;
  // ⚠️ 回落到**固定文案**,❌ 不回落到 `description`:那是"这一档有多深"的说明,
  // 摆在"为什么改不了"的位置上答非所问,而且取的还是目录里第一个被禁的那条、
  // 未必是当前这一档。宿主没给原因是宿主的 bug,这里给一句诚实的通用话,别拿别的话充数。
  const effortLockedReason = lockedEffort
    ? (lockedEffort.disabledReason ?? translate('composer.effortLocked'))
    : undefined;
  /** 目录里有没有说明文字 —— 决定读数下面那一行占不占位(见 modelEffortHint 抬头)。 */
  const effortHasHints =
    effortItems.some((e) => !!e.description) || effortLocked || !shownEffortItem;
  /**
   * 读数下面那一行说什么 —— 锁住了先说为什么,其次说当前这一档是干嘛的,
   * 一档都没选时说"由引擎自己定"。`title` 与读屏器取的都是这一份,别再各写一遍。
   */
  const effortHintText = effortLocked
    ? (effortLockedReason ?? '')
    : shownEffortItem
      ? (shownEffortItem.description ?? '')
      : translate('composer.effortUnset');
  /** 复位钮只在「你改过、且改到了默认档之外」时出现 —— 见 modelEffortReset 那段。 */
  const canResetEffort =
    !effortLocked && !!onEffortChange && !!selectedEffortItem && !!resetEffortItem &&
    selectedEffort !== resetEffortItem.id;

  const hasSlider = effortItems.length > 1;
  const resetButton = canResetEffort && resetEffortItem && (
    <button
      type="button"
      className={styles.modelEffortReset}
      data-testid="composer-effort-reset"
      title={translate('composer.effortReset')}
      aria-label={translate('composer.effortReset')}
      onClick={() => onEffortChange?.(resetEffortItem.id)}
    >
      <RotateCcw size={12} aria-hidden />
    </button>
  );

  return effortItems.length > 0 ? (
            <div
              className={styles.modelEffortRow}
              data-slot="composer-effort-row"
              // 照上游那两段键盘让路(它对着 cmdk 写,这里对着 Combobox 的输入框):
              // **上下键属于模型清单**,而滑杆(与之前的 RadioGroup 一样)会把它们抢去。
              // 捕获阶段截住、把这次按键转交给输入框,焦点在滑杆上时才还能继续翻模型。
              // 左右键留给滑杆自己 —— 那是它调档位的手。
              onKeyDownCapture={(e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                const input = e.currentTarget
                  .closest('[data-slot="combobox-content"], [role="dialog"]')
                  ?.querySelector<HTMLInputElement>('input:not([type="range"])');
                // 目录一个模型都没有时搜索框不渲染 —— 那也不该让上下键掉到滑杆上去改档位
                // (实测:空目录时按一下 ArrowDown 会直接改档并关掉面板)。拦下来,不转交。
                if (!input) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                input.focus();
                input.dispatchEvent(new KeyboardEvent('keydown', e.nativeEvent));
              }}
              onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                // Home/End:滑杆自己认(跳到最小/最大档),而外面的清单会把它们抢去跳到首尾。
                // ⚠️ 只在焦点**真的落在滑杆上**时才拦。这一行里还有复位钮:在它身上按 End
                // 时既跳不了档、又被这里吃掉,那一下什么也不会发生。
                if (e.key !== 'Home' && e.key !== 'End') return;
                if (!(e.target as HTMLElement).closest?.('input[type="range"]')) return;
                e.stopPropagation();
              }}
            >
              <div className={hasSlider ? undefined : styles.modelEffortHeader} hidden={hasSlider}>
                <span className={styles.modelEffortLabel}>{translate('composer.effort')}</span>
                <span
                  className={styles.modelEffortValue}
                  data-slot="composer-effort-value"
                  // 置灰那一刻该说的是为什么,不是这一档的说明(同模型行)。
                  title={effortLocked ? effortLockedReason : shownEffortItem?.description}
                  // 没有覆盖时这是**模型自己的默认档**,压暗半档说明它不是你选的 ——
                  // 与触发器上那半档透明度是同一个说法(@@@composer-model-trigger-label)。
                  data-armed={shownEffortItem ? 'true' : 'false'}
                  style={{ opacity: shownIsUserPick || !shownEffortItem ? 1 : 0.6 }}
                >
                  {shownEffortItem?.name ?? translate('composer.default')}
                </span>
                {/* 当前这一档是干什么的 —— 跟在档名后面同一行(owner 2026-10-10:「思考那块显得特别大」,
                    原来它独占一行)。见 modelEffortHint 抬头:目录里只要有一档带说明就恒占这一格(空的也占)。
                    锁住时这里空着,原因单独起一行写全(见下)。 */}
                <span
                  className={styles.modelEffortHint}
                  data-slot={effortHasHints && !effortLocked ? 'composer-effort-hint' : undefined}
                  id={effortHasHints && !effortLocked ? effortHintId : undefined}
                  // 一行装不下时省略号会把话吃掉 —— 悬停至少还能把整句读出来。
                  title={!effortLocked && effortHintText ? effortHintText : undefined}
                >
                  {effortHasHints && !effortLocked ? effortHintText : null}
                </span>
                {!hasSlider && resetButton}
              </div>
              {/* 锁住时那句是**操作指引**(「创建任务时可以选」),挤在档名后面会被省略号吃掉后半句 ——
                  单独一行、最多两行写全。这一态整条会话不变,多一行不会让面板跳。 */}
              {effortLocked && (
                <span
                  className={styles.modelEffortLockedHint}
                  data-slot="composer-effort-hint"
                  id={effortHintId}
                  data-locked=""
                  title={effortHintText || undefined}
                >
                  {effortHintText}
                </span>
              )}
              {/* ⚠️ **恰好一档时不画滑杆**:量程会被撑成 0→1,右半条轨道拖得动却永远弹回,
                  唯一那个刻点还压在圆钮底下 —— 一条拖不动的死轨道。Smashing 与 Microsoft
                  的指南都说选项太少时滑杆不如别的控件,这里取最保守的一刀:只留读数。 */}
              {hasSlider && (
              <>
              {/* 离散滑杆:一档一格。`thumbAlignment="edge"` 让最小档时圆钮**左缘**贴住轨道左缘
                  (而不是圆心贴左缘),那正是上游那个控件的样子;刻点层跟着缩进半个圆钮,
                  于是刻点与圆心逐像素对齐(见 EFFORT_THUMB_HALF)。 */}
              <div className={styles.modelEffortAxis} data-fast-mode={fastMode !== undefined || undefined}>
              <Slider.Root
                className={styles.modelEffortSlider}
                min={0}
                max={effortItems.length - 1}
                step={1}
                largeStep={1}
                thumbAlignment="edge"
                disabled={effortLocked}
                // 一档都没生效时圆钮只能停在最左(滑杆没有"没有值"那个位置)——
                // 见 modelEffortControl 里 data-armed 那段:压暗 + 读数写「默认」把这一态
                // 与"你选了最低档"分开。
                data-armed={shownEffortItem ? 'true' : 'false'}
                value={effortIndex < 0 ? 0 : effortIndex}
                onValueChange={(next: number | number[], details: { reason: string }) => {
                  const index = Array.isArray(next) ? next[0] : next;
                  const picked = effortItems[index];
                  // 越界(不该发生,量程就是档位数 - 1)就当没发生 ——
                  // ❌ 别发一个 undefined 的档位 id 出去。
                  if (!picked) return;
                  // 拖动中:只动本地,界面立刻跟上;❌ 不每跨一格就往宿主发一次
                  // (那是上面 draggingIndex 注释里说的第一个僵硬源,顺带也少了 5 次无用往返)。
                  if (details.reason === 'drag' || details.reason === 'track-press') {
                    setDraggingIndex(index);
                    return;
                  }
                  setDraggingIndex(null);
                  if (picked.id === effectiveEffortItem?.id) return;
                  onEffortChange?.(picked.id);
                }}
                onValueCommitted={(_next: number | number[], details: { reason: string }) => {
                  // Keyboard changes are already published by onValueChange.
                  if (details.reason === 'keyboard') return;
                  // 指针那条路相反:拖动全程只动本地,松手(或点轨道)才把最终那一档交给宿主。
                  const committed = Array.isArray(_next) ? _next[0] : _next;
                  const picked = effortItems[committed];
                  setDraggingIndex(null);
                  if (picked && picked.id !== effectiveEffortItem?.id) onEffortChange?.(picked.id);
                }}
              >
                <Slider.Control
                  className={styles.modelEffortControl}
                  title={effortLockedReason}
                >
                  <Slider.Track className={styles.modelEffortTrack}>
                    <span
                      className={styles.modelEffortIndicator}
                      data-slot="composer-effort-indicator"
                      aria-hidden
                      style={{
                        // 见 modelEffortIndicator 抬头:末端 == **圆钮圆心**,所以整段躲在圆钮
                        // 底下,由圆钮那道 1px 环切出上游那条发丝缝。
                        // ⚠️ 最低档仍然是 0:那时填充会整段藏在圆钮下(圆头半径 12 内切于
                        // 圆钮半径 14),写 0 与写半个圆钮在屏幕上没有差别,而 0 更说得清
                        // 「一档都没走过」。
                        width:
                          effortIndex > 0
                            ? `calc((100% - var(${EFFORT_THUMB_VAR})) * ${
                                effortIndex / (effortItems.length - 1)
                              } + var(${EFFORT_THUMB_VAR}) / 2)`
                            : 0,
                      }}
                    />
                    <span className={styles.modelEffortTicks} aria-hidden>
                      {effortItems.map((e, index) => (
                        <span
                          key={e.id}
                          className={styles.modelEffortTick}
                          data-slot="composer-effort-tick"
                          data-testid={`composer-effort-${e.id}`}
                          // 严格小于:当前那一档的刻点正压在圆钮**底下**(刻点与圆心对齐),
                          // 写成 `<=` 等于给一个看不见的点上色。上游实测第 4/5 档时正好
                          // 三个亮点 + 一个灰点,也是这条。
                          data-filled={index < effortIndex ? '' : undefined}
                          style={{
                            // 逻辑属性:从右往左的语言里刻点要跟着滑杆一起翻面,
                            // 写死 `left` 会让刻点顺序与圆钮方向相反。
                            insetInlineStart:
                              effortItems.length > 1
                                ? `${(index / (effortItems.length - 1)) * 100}%`
                                : '0%',
                          }}
                        />
                      ))}
                    </span>
                    <Slider.Thumb
                      className={styles.modelEffortThumb}
                      aria-label={translate('composer.effort')}
                      // 读屏器念的是**档名**,不是序号 —— 「思考,3」什么也没说。
                      // ⚠️ 空串等于"不提供文字值",读屏器会退回去念 aria-valuenow,
                      // 也就是量程最小值 0 —— 看得见的人读到「默认/未指定」,
                      // 听的人听到「最低档」。两边必须说同一件事。
                      getAriaValueText={() =>
                        shownEffortItem?.name ?? translate('composer.effortUnset')
                      }
                      // 「为什么改不了」那句话挂在外层 div 的 title 上,读屏器取不到;
                      // 锁住时 input 还是 disabled,更取不到。这里显式指过去。
                      aria-describedby={effortHasHints ? effortHintId : undefined}
                    />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
              {resetButton}
              {fastMode !== undefined && (
                <ComposerFastMode enabled={fastMode} disabled={disabled} phoneActions={phoneActions}
                  onChange={onFastModeChange} renderHint={renderFastModeHint} />
              )}
              </div>
              </>
              )}
            </div>
  ) : null;
}
