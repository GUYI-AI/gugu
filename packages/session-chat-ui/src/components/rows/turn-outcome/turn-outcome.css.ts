import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** 悬停时才点亮动作按钮的作用域标记；只在自己这一行内生效，不跨行泄漏。 */
export const outcomeRowGroup = style({});

export const outcomeShell = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  // 与 lane 同一层 surface:虚拟化重排时,收尾单元整块都不该让底下的流式正文透出来。
  // 那层 surface 就是 transcript 自己的底(`vars.bg`),不是卡片那一档 `bg1`:宿主的这两档不一定相等
  // (手机深色页面 #181818、卡片档 #212121),取 bg1 就会在页面上画出一块比底亮的框。
  background: vars.bg,
});

export const outcomeRow = style([
  outcomeRowGroup,
  {
    display: 'flex',
    alignItems: 'center',
    // 上游那条 lane 是 `flex items-center gap-2` —— 8px，不是 6。
    gap: '8px',
    // @@@type-chrome (Refs #6104) — chrome 正文那一档(#7333:紧凑界面 14/20)。
    fontSize: vars.typeChromeFontSize,
    lineHeight: '20px',
    // Keep a settled outcome on its own transcript surface if a virtualized
    // row is briefly painted over the streaming message during reconciliation.
    background: vars.bg,
  },
]);

/**
 * 被停止那一支的**空白间隔** —— 上游两颗动作按钮身上那个 `ms-auto`。
 *
 * 失败 / 中断走的是 `outcomeRuleTrail`（同样的 `flex: 1 1 0`，但画一条发丝线）。
 * 两者形状相同、只差画不画那条线，理由：**那条线是失败作用域的记号**（#3568 —— 它要回答的是
 * 「这一段到此为止且出了事」），而「你把它停了」不是失败，上游那条 lane 在这个位置也是纯空白。
 * ⇒ 同一处宽度，失败行拿它当记号，被停止行拿它当上游的 `ms-auto`。
 *
 * ⚠️ **上游上半条那枚光标这里没有画。** 它在上游是 `<p>{words}<span cursor/></p>` ——
 * 跟在那段字的**末尾**、同一行。本仓那段字是 transcript 自己的行（正文行 / 工具行），
 * 有自己的一套行盒排版与 `measure()`；把光标钉到字尾要动那台引擎，是另一件事。
 * 曾经把它摆在这条 lane 的行首（「下一个字本该出现的位置」），实机看下来是一枚**孤立的竖线**
 * ——上游从没有那个东西 ⇒ 撤掉。要它就得由正文行自己出，且那时还得处理「这一轮最后一件东西
 * 不是文字而是一个工具行 / diff」的情形。
 */
export const outcomeSpacer = style({
  flex: '1 1 0',
  minWidth: 0,
});

export const OUTCOME_BADGE_GAP_PX = 6;

export const outcomeBadge = style({
  display: 'inline-flex',
  alignItems: 'center',
  // 间距与尺寸仍逐条照抄上游：`gap-1.5` `px-2.5` `py-1`。⚠️ 上一版把它们整体缩了一档
  // （gap 6→我写 6 但字号 12、高 20），于是同一副骨架画出来比上游小一圈、挤成一条 ——
  // owner 实机对照后认为尺寸偏差明显。尺寸不是可以顺手收紧的东西。
  //
  // ⚠️ 2026-09-22 按 design.md 统一,**形与字脸不再照抄上游**,原裁决:「逐条照抄上游
  // `rounded-full` `mono`」。两条都踩在 settled law 上:
  //   · mono —— 徽章里是「回合失败 · 未能载入已有会话」这种**说辞**,而 design.md 说
  //     「**Mono is never prose and never emphasis.**」⇒ 退回 fontSans,负字距一并撤掉
  //     (它是等宽字的补偿,sans 在这么小的字上收紧只会更难读)。
  //   · rounded-full —— shape 表里 `--radius-capsule` 只发给「switch, avatar, status dot」,
  //     而这是一枚**带文字的标记**,走控件那一档 `radiusMd`(8px)。
  // 层级仍然成立:它有 `bg2` 的底 + 标注档的字号,不靠一张字脸和一个药丸形状。
  gap: `${OUTCOME_BADGE_GAP_PX}px`,
  height: '24px',
  paddingInline: '10px',
  borderRadius: vars.radiusMd,
  fontFamily: vars.fontSans,
  // @@@type-chrome (Refs #6104) — 标记那一档(#7333:标注 12/18),走名字不走字面量;外框仍是 24。
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  background: vars.bg2,
  // ⚠️ `nowrap` 单独用会在窄宽下把徽章**顶出行外**：实测 240px 下「回合失败 · 未能载入已有会话」
  // 横向溢出 29.9px（改前那一版在同一宽度是 0 —— 它靠换行让路，代价是被常量行高裁掉半行）。
  // ⇒ 让徽章可收缩（`0 1 auto` + `minWidth: 0`）并把溢出裁在自己身上，配合 `outcomeReason`
  // 的省略号，窄宽下丢的是原因的尾巴而不是版面。读数在 240/300/360/420/560/760 六档上对拍过。
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
});

/** 说辞那一截：先于原因保住。它短（「回合失败」「你停止了这一轮」），不参与收缩。 */
export const outcomeBadgeLabel = style({
  whiteSpace: 'pre-wrap',
  flex: 'none',
});

/**
 * 徽章里那枚停止字形（上游的 `<SquareIcon className="size-2.5 fill-current" />`）。
 *
 * ⚠️ **只画在 `cancelled` 这一支**，出错行一枚字形都不画 —— #3568 判的是「同一枚字形同时替
 * 两种范围说话」，而收尾行**不需要**一枚字形替它说「这里出错了」（`product spec…/task-chat-ui/spec.md`
 * 写明：它的文案自己点了名）。这枚方块说的不是「出错了」而是「你按了停止」：它与用户消息卡上那颗
 * 停止按钮是**同一个组件**（`IconStop`），于是「按下去的那枚」与「留下来的那枚」是同一个字形。
 * 两者永远不同框（一个在轮子跑的时候，一个在轮子停下之后）。
 *
 * 尺寸走 `globalStyle`：`IconStop` 自身写死 14px 且不收 props，而本包的 vanilla-extract
 * 选择器只能选中元素自己，选不到后代 —— 这是本包既有写法（`execute.css.ts` / `table.css.ts` 同源）。
 */
export const outcomeBadgeGlyph = style({
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
});

globalStyle(`${outcomeBadgeGlyph} svg`, {
  width: '10px',
  height: '10px',
});

/** The empty separator keeps two badge gaps between the label and reason. */
export const outcomeBadgeSeparator = style({
  flex: 'none',
  width: 0,
});

/**
 * 动作按钮。
 *
 * ❌ 不照抄上游 `elements-error-state` 的 `ms-auto`（把按钮顶到最右）：上游那个组件裹在
 * `max-w-sm` 里，按钮离文字很近；transcript 的行是整幅宽度，顶到最右会变成一个跟原因文案
 * 隔了半屏、看不出属于谁的孤立控件。这里紧跟在原因后面 —— 取的是上游的解剖，不是它的像素。
 */
export const outcomeAction = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  // 上游：`flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium`。
  // h-7 = 28px、px-2.5 = 10px、text-xs = 12px、gap-1 = 4px —— 全部照抄，❌ 不再自己缩。
  height: '28px',
  paddingInline: '10px',
  borderRadius: vars.radiusMd,
  // @@@type-chrome (Refs #6104) — 这是一枚**可点的动作**,不是标记 ⇒ 取 chrome 正文那一档(#7333:紧凑界面 14/20);
  // 外框 28 照上游 h-7 不动,字在框里居中。
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  // 上游两颗动作按钮是 `font-medium`：它们与旁边那枚徽章是同一条 lane 上的两种角色
  // （徽章在陈述、按钮在邀请），字重是把它们分开的那一档，而不是再加一层底色。
  fontWeight: 500,
  color: vars.fgMuted,
  background: 'transparent',
  transition: 'background-color 150ms ease, color 150ms ease, transform 150ms ease',
  selectors: {
    // @@@state-ladder-mix 同上:走状态档而不是表面阶梯的某一级。
    '&:hover': { color: vars.fg, background: vars.bgHover },
    '&:focus-visible:not([data-pointer-focus])': { color: vars.fg, background: vars.bgHover },
    // 上游的 `active:scale-[0.96]`;按下再补上底色那一档(spec:桌面也要有按压)。
    '&:active': { transform: 'scale(0.96)', background: vars.bgPress },
  },
  // 上游 `motion-reduce:transition-none` 那一支。⚠️ vanilla-extract 的媒体查询是顶层
  // `'@media'` 键，塞进 `selectors` 会被当成一个选择器字符串而静默失效。
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

/**
 * 「继续」——上游两颗动作按钮里**更重**的那一颗（上游 `text-foreground/70`，
 * 与 Discard 的 `text-foreground/45` 拉开一档）。同一副形状，只把静置色提上来。
 *
 * ❌ 不照抄上游的 `ms-auto`（把它顶到最右）：理由与 `outcomeAction` 那条相同 ——
 * 上游那组按钮裹在 `max-w-sm` 里，而 transcript 的行是整幅宽度。
 */
export const outcomeActionPrimary = style([
  outcomeAction,
  {
    color: vars.fg,
  },
]);

/** 原因说明；与主文案同一行，颜色更弱。窄宽下它是先让路的那一截（截断成省略号）。 */
export const outcomeReason = style({
  color: vars.fgMuted,
  minWidth: 0,
  // 折行只在离屏测量里定一次(`readableLabel` 把断点写成 \n),DOM 照画、❌ 自己再折:测量与排版差的那零点几像素
  // (字形宽度在 DOM 里按 1/64px 进位)会让 pre-wrap 把原因的最后一个字/词挤到第二行,而行高是按一行量的。
  whiteSpace: 'pre',
  overflowWrap: 'normal',
});

const outcomeRule = style({
  height: '1px',
  background: vars.border,
  alignSelf: 'center',
});

export const outcomeRuleTrail = style([outcomeRule, { flex: '1 1 0', minWidth: '16px' }]);

/**
 * 展开后那块**逐字原文**。
 *
 * 三条决定,每条都有出处:
 * ① `white-space: pre-wrap` + `user-select: text` —— 原文要能**原样读、原样复制**去对账。
 *    分类器交上来的 detail 本来就可能是多行(适配器退出码 + 它 stderr 的尾巴)。
 * ② 高度**封顶 + 自己滚**(`DETAIL_MAX_LINES`),而不是在数据侧截断。
 *    仓规是「原文进详情要逐字,❌ 硬截断;超长在 UI 侧折叠,不在数据侧砍」——
 *    这块框就是那个"折叠":一个看得见全部、只是一次看几行的视窗。
 * ③ 等宽字体:里面装的是错误码、请求 id、退出码、路径这类要**逐字符核对**的东西,
 *    比例字体会把 `l/1/I`、`0/O` 糊在一起。#7333 起走代码档 13/20(与代码块同一档),❌ 跟着徽章的标注档变。
 */
/**
 * 原文那一块的上下内距。**`measure()` 与这里读的是同一个常量** ——
 * 两边各写一个 6,哪天有人改了一边,行就会与下一行重叠,而那不会有任何东西报错。
 */
export const DETAIL_PAD_Y = 6;
export const DETAIL_PAD_X = 10;

/**
 * 原文那一块的行高。**`measure()` 与这里读的是同一个常量。**
 *
 * ⚠️ 第一版拿 `theme.fonts.body.lineHeight`(20px)去量,而那时这块是 11px 等宽、没写 line-height,
 * 真实行盒约 13–14px ⇒ 六行的框里只有四行多的字,`DETAIL_MAX_LINES` 那句「一次看几行」
 * 说的不是屏幕上真实发生的事。行高必须由这里**写死**,量它的人读同一个数。
 * #7333 代码档 13/20:行高 20。
 */
export const DETAIL_LINE_H = 20;

export const outcomeDetail = style({
  // ⚠️ 显式写死,❌ 不吃全局 reset:这块的高度是 `measure()` 算出来再写进 inline style 的,
  // 而算式里已经含了上下内距。box-sizing 换一档,量出来的高度就与真实 DOM 差 2×padY,
  // 虚拟化会让这一行与下一行重叠。测量与盒模型必须钉在同一个文件里。
  boxSizing: 'border-box',
  paddingBlock: `${DETAIL_PAD_Y}px`,
  fontFamily: vars.fontMono,
  fontSize: vars.typeCodeFontSize,
  lineHeight: `${DETAIL_LINE_H}px`,
  color: vars.fgMuted,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  overflowY: 'auto',
  userSelect: 'text',
  margin: 0,
  // 与徽章左缘对齐:徽章自己有 10px 内距,这里补上同一格,免得原文比它说明的那句话还靠左。
  paddingInline: DETAIL_PAD_X,
});

/** The marker and its inset belong to the failure lane, including wrapped actions. */
export const FAILURE_INSET = 14;
export const FAILURE_SEPARATOR = '\u2002';

export const failureRule = style({
  position: 'absolute',
  left: 0,
  top: 2,
  bottom: 2,
  width: 2,
  background: vars.fgError,
});

export const failureBadge = style({
  display: 'block',
  minWidth: 0,
  background: 'transparent',
  color: vars.fgError,
  border: 0,
  padding: 0,
  textAlign: 'left',
  fontFamily: vars.fontSans,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  selectors: {
    '&[data-detail-toggle]': { cursor: 'pointer' },
    '&[data-detail-toggle]:hover': { background: vars.bgHover },
    '&:focus-visible:not([data-pointer-focus])': { outline: '2px solid currentColor' },
  },
});

export const failurePreview = style({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  overflow: 'hidden',
});
