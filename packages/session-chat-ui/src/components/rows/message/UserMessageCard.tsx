/** @jsxImportSource solid-js */
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { useTurnState } from '@session-chat/components/contexts/TurnStateContext';
import { BlockStackView } from '@session-chat/components/primitives/BlockStackView';
import { clipTrackedHeight, isCardAnimating } from '@session-chat/components/primitives/card-clip';
import { FileMark, IconStop } from '@session-chat/components/primitives/icons';
import type { StackLayout } from '@session-chat/core/compose';
import type { Measured, MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { vars as themeVars } from '@session-chat/styles/theme.css';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { fileRowStyle } from '@gugu/session-shared/file-row';
import '@gugu/session-shared/file-row.css';
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type JSX } from 'solid-js';
import type { ChatAttachment, ChatMessage } from '@session-chat/model';
import {
  actionGap, attachStripHeight,
  effectiveMessageVars, messageAttachmentGap,
  type MessageVars,
  userAvailableWidth,
  userInnerWidth,
  userPillWidth,
} from './metrics';
import { isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import { srOnly } from './message.css';
import { useChatTranslator } from '@session-chat/localization';
import { conversationDestinationLayout } from './conversation-destination';
import { ConversationDestination } from './ConversationDestination';
import { UserMessageActions } from './UserMessageActions';
import { CONVERSATION_EXPAND_H, conversationBubbleKey, conversationCanCollapse, conversationTailLane } from './conversation-body';
import { UserMessageEditor } from './UserMessageEditor';
import { SentMessageBodies, sentBodiesLayout } from './SentMessageBodies';
import { InputSendStatus } from './InputSendStatus';
import { messageEditorMetrics } from './message-editor-metrics';
import {
  attachmentStrip,
  userMessageRoot,
  card,
  cardFadeOverlay,
  cardVars,
  stopButtonOverlay,
  userCardGroup,
  userMessageExpand,
  userMessageExpandRow,
} from './user-message.css';

export function UserMessageCard(props: { data: ChatMessage; ctx: RenderCtx; vars: MessageVars; conversation?: boolean; sender?: () => string | null; footerReference?: () => JSX.Element }) {
  const translate = useChatTranslator();
  const commands = useCommands();
  const [textRoot, setTextRoot] = createSignal<HTMLDivElement>();
  const [menuRoot, setMenuRoot] = createSignal<HTMLDivElement>();
  const textMount = createMemo(() => commands().onMessageTextMount);
  const textMessageId = createMemo(() => props.data.id);
  createEffect(() => {
    const root = textRoot(), bubble = menuRoot(), mount = textMount(), itemId = textMessageId();
    if (!props.conversation || !root || !mount) return;
    const cleanup = mount({ root, menuRoot: bubble, itemId, message: () => props.data, sender: () => props.sender?.() ?? null, commands });
    if (cleanup) onCleanup(cleanup);
  });
  const turn = useTurnState();
  const destination = () => props.conversation && props.ctx.measureCtx ? conversationDestinationLayout(props.data, props.ctx.measureCtx(), innerWidth()) : null;

  const mCtx = () => props.ctx.measureCtx?.();
  // Layout-resolved geometry (#4874): `base` narrows padding, drops the border
  // and reserves a left gutter. Same helper as measureMessage so the painted
  // box and the reserved row height come from one set of numbers.
  const layout = () => mCtx()?.theme.layout;
  const vars = () => effectiveMessageVars(props.vars, layout());
  const availableWidth = () => {
    const c = mCtx();
    return c ? userAvailableWidth(c.width, layout()) : 0;
  };

  const isCurrent = () => turn.currentMessageId() === props.data.id;
  /** 这一条就是正在跑的那一轮 —— 卡片高亮用它，与宿主接没接停止回调无关。 */
  const isGenerating = () => !commands().canDiscardSend?.(props.data.id) && isCurrent() && turn.turnStatus() === 'generating';
  /**
   * 停止按钮多一道门：宿主必须真的注入了 `onStop`。
   *
   * 在此之前它只看 `isGenerating()`，而唯一的产品宿主
   * （`acp-chat-panel.tsx` 的 `transcriptCommands`）从来没注入过 `onStop`
   * ⇒ `commands().onStop?.(...)` 在 `?.` 上短路，**这颗按钮按下去什么都不会发生**
   * （#3498 查出来的；与 #3500 是同一个形状）。composer 上那颗停止按钮走的是另一条路、
   * 一直是通的，正好把这颗死按钮掩护成「看起来能停」。
   * ⇒ 现在「没接回调」在结构上等于「不渲染控件」，而不是靠人记得去接。
   */
  const showStop = () => !props.data.guguDelivery && isGenerating() && Boolean(commands().onStop);

  const styleVars = () => ({
    userCardPadX: vars().userCardPadX,
    userCardPadY: vars().userCardPadY,
    cardBorder: vars().cardBorder,
    attachGap: attachmentGap(),
  });

  const innerWidth = () => (mCtx() ? userInnerWidth(availableWidth(), vars()) : 0);
  // One parse path for layout and copy text: a full parse drops the streaming record, so every
  // chunk would re-parse the reply and remount its settled blocks (and lose a selection in them).
  const parse = (ctx: MeasureCtx) => (props.data.streaming ? ctx.caches.parseBlocksStreaming : ctx.caches.parseBlocks)(props.data.id, props.data.text);

  /** What the agent sent to people is drawn by the host's MessageBody in slots (`SentMessageBodies`), not as text here. */
  const sent = createMemo(() => {
    const ctx = mCtx(), messages = props.data.sentMessages;
    return ctx && messages?.length ? sentBodiesLayout(messages, ctx, innerWidth()) : null;
  });
  const stack = createMemo<Measured<StackLayout> | null>(() => {
    const ctx = mCtx();
    if (!ctx || sent()) return null;
    const blocks = parse(ctx);
    if (blocks.length === 0) return null;
    const innerCtx = { ...ctx, width: innerWidth() };
    return layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
  });

  /**
   * 卡片自己的高度 —— **不含附件条**(#5269)。附件条挂在卡片外面(见 render),所以夹住长消息
   * 的那个上限只该量正文:附件不该把正文挤进折叠态,也不该被折叠遮住。
   */
  const fullContentH = createMemo(() => {
    const ctx = mCtx();
    const v = vars();
    if (!ctx) return v.collapsedMaxH;
    const innerW = userInnerWidth(availableWidth(), v);
    const bodies = sent();
    if (bodies) return bodies.height + 2 * v.userCardPadY + 2 * v.cardBorder;
    const blocks = parse(ctx);
    // 还在流、一个字没到:先占一行的气泡;收口了还没正文(只有附件)就没有气泡。
    if (blocks.length === 0) return props.data.streaming ? ctx.theme.fonts.body.lineHeight + 2 * v.userCardPadY + 2 * v.cardBorder : 0;
    const innerCtx = { ...ctx, width: innerW };
    const s = layoutBlockStack(blocks, innerCtx, { isCollapsed: ctx.isCollapsed });
    return s.height + 2 * v.userCardPadY + 2 * v.cardBorder;
  });

  const edit = () => {
    if (props.data.guguDelivery) return undefined;
    const current = commands().editingMessage;
    return current?.itemId === props.data.id ? current : undefined;
  };
  const attachmentGap = () => messageAttachmentGap(vars(), layout(), fullContentH() > 0 || !!edit());

  /**
   * 附件条的高度 —— 与 measure 调的是同一个函数(`message.def`),❌ 不各算一遍。
   * 它挂在卡片**外面**,所以宽度按卡片外宽算,不吃卡片的内距。
   */
  const attachStripH = createMemo(() =>
    attachStripHeight(props.data.attachments, availableWidth(), { attachGap: attachmentGap() })
  );

  /**
   * Painted width. `classic`: the row width (card spans the column). `base`:
   * hug the widest measured line, capped by the gutter-reduced width.
   * Height is independent of this — see userPillWidth.
   *
   * ⚠️ 从前「有附件就放弃 hug」——那时附件条长在卡片里,得占满内宽才排得开。现在它挂在
   * 卡片外面,卡片又只包正文,于是照常 hug(#5269)。
   */
  const paintedWidth = createMemo(() => {
    const available = availableWidth();
    if (!isDoubleColumnLayout(layout())) return available;
    const s = stack() ?? sent();
    return userPillWidth(available, s ? Math.max(s.width, destination()?.width ?? 0) : null, vars(), layout());
  });

  const isExpanded = () => mCtx()?.expandedId === props.data.id;
  const maxH = () => (isExpanded() ? vars().expandedMaxH : vars().collapsedMaxH);
  const clampedH = () => Math.min(fullContentH(), maxH());
  const isOverflowing = () => fullContentH() > maxH();
  const canCollapse = () => Boolean(props.conversation && mCtx() && conversationCanCollapse(props.data, mCtx()!));

  // Track the animated clip edge during expand/collapse tween so the bottom
  // border and rounded corners are never hidden by the UnitRow overflow clip.
  const cardH = clipTrackedHeight(props.ctx, clampedH);

  const plainText = () => {
    const ctx = mCtx();
    if (!ctx) return props.data.text;
    return parse(ctx).map(blockPlainText).join('\n\n');
  };
  const editorMetrics = () => {
    const ctx = mCtx();
    return ctx ? messageEditorMetrics(edit()?.text ?? '', ctx) : { height: 120, textHeight: 48 };
  };

  return (
    <div
      data-conversation-body={props.conversation ? props.data.role : undefined}
      class={userMessageRoot}
      style={{
        position: 'relative',
        ...assignInlineVars(cardVars, pxTokens(styleVars())),
        // `base`:整条右对齐到与气泡同一条边(owner 给的参考是 Kimi 那个形状)。
        ...(isDoubleColumnLayout(layout())
          ? { width: `${availableWidth()}px`, 'margin-left': props.conversation && props.data.role === 'assistant' ? '0' : 'auto' }
          : {}),
      }}
    >
      <Show when={props.data.attachments?.length}>
        {/* 附件**贴在消息上面**,不在气泡里(#5269,owner 2026-09-10 给的参考是 Kimi 那个形状:
            附件卡浮在气泡外、上方,气泡只包文字)——从前它长在卡片里,于是卡片被撑成一大块灰。 */}
        <div
          class={`${attachmentStrip} gg-file-rows`}
          style={{
            ...fileRowStyle(),
            height: `${attachStripH()}px`,
            // `base`:整条右对齐到与气泡同一条边。
            ...(isDoubleColumnLayout(layout()) ? { 'justify-content': props.conversation && props.data.role === 'assistant' ? 'flex-start' : 'flex-end' } : {}),
          }}
        >
          <For each={props.data.attachments}>
            {(att) => <AttachmentChip attachment={att} itemId={props.data.id} />}
          </For>
        </div>
      </Show>
    <Show when={edit()} fallback={<>
    {/* 只有附件、没有正文(长文本自动转成的 pasted-text.txt 就是这样):不画气泡 —— 空气泡是一条整行宽的色带。 */}
    <Show when={!mCtx() || stack() || sent() || props.data.streaming}>
    <div
      ref={setMenuRoot}
      data-user-card={props.data.id}
      data-conversation-bubble-key={props.conversation ? conversationBubbleKey(props.data) : undefined}
      data-user-card-expandable={props.conversation && !isExpanded() && isOverflowing() ? 'true' : undefined}
      class={`${card({ state: isOverflowing() && !isExpanded() ? 'overflowing' : 'static', current: isGenerating() })} ${userCardGroup}`}
      style={{
        ...assignInlineVars(cardVars, pxTokens(styleVars())),
        height: `${cardH() + (destination()?.height ?? 0)}px`,
        // 对话布局里人那一侧的字色由 conversation-message.css 给(跟着气泡底色反色),这里只管 agent 那一侧。
        ...(props.conversation && props.data.role !== 'assistant' ? {} : assignInlineVars({ [themeVars.fgBody]: props.conversation ? themeVars.fg : themeVars.bubbleUserFg, [themeVars.link]: props.conversation ? themeVars.fg : themeVars.bubbleUserFg })),
        // `base` pill: explicit hug width + right alignment. Left as-is in
        // classic so the card keeps spanning the column (no inline width).
        ...(isDoubleColumnLayout(layout())
          ? { width: `${paintedWidth()}px`, 'margin-left': props.conversation && props.data.role === 'assistant' ? '0' : 'auto' }
          : {}),
        // Force overflow:hidden while the UnitRow tween is in flight to avoid
        // a transient scrollbar mid-animation; restore auto only when expanded
        // at rest (so the user can scroll long messages).
        'overflow-y': isCardAnimating(props.ctx) || !isExpanded() ? 'hidden' : 'auto',
        cursor: !isExpanded() && isOverflowing() ? 'pointer' : 'default',
      }}
    >
      <div class={srOnly} role="note" aria-label={plainText()} />
      <div ref={setTextRoot} data-conversation-text={props.conversation ? props.data.id : undefined}
        style={destination() ? { height: `${Math.max(0, cardH() - 2 * vars().userCardPadY - 2 * vars().cardBorder)}px`, overflow: 'hidden' } : undefined}>
        <Show when={stack()}>{(s) => <BlockStackView node={s()} />}</Show>
        <Show when={props.data.sentMessages?.length && sent() ? props.data.sentMessages : null}>{messages =>
          <SentMessageBodies messages={messages()} ctx={mCtx} width={innerWidth()} />}</Show>
      </div>
      <Show when={!isExpanded() && isOverflowing()}>
        <div class={cardFadeOverlay} style={destination() ? { bottom: `${destination()!.height + vars().userCardPadY}px` } : undefined} />
      </Show>
      <Show when={destination()}>{target => <ConversationDestination text={target().text} width={target().width} />}</Show>
      <Show when={showStop()}>
        <button
          type="button"
          class={stopButtonOverlay}
          aria-label={translate('transcript.stopGenerating')}
          onClick={(e) => {
            e.stopPropagation();
            commands().onStop?.({ itemId: props.data.id });
          }}
        >
          <IconStop />
        </button>
      </Show>
    </div>
    </Show>
    <Show when={!stack() && !props.data.streaming && Boolean(props.data.attachments?.length) && destination()}>{target =>
      <div data-attachment-destination style={{ display: 'flex', 'justify-content': props.data.role === 'assistant' ? 'flex-start' : 'flex-end' }}>
        <ConversationDestination text={target().text} width={target().width} />
      </div>
    }</Show>
    {/* 对话布局里气泡折着:气泡下面单起一行「展开全文」,再下面才是时间那一行(owner 定稿 0 号图)。点了和点气泡一样展开(ChatRoot 认 `data-expand-user-card`)。 */}
    <Show when={props.conversation && isOverflowing() && !isExpanded()}>
      <div class={userMessageExpandRow} style={{ height: `${CONVERSATION_EXPAND_H}px` }}>
        <button type="button" class={userMessageExpand} data-expand-user-card={props.data.id}
          data-conversation-bubble-key={conversationBubbleKey(props.data)}>{translate('transcript.showFullText')}</button>
      </div>
    </Show>
    <Show when={!props.conversation || conversationTailLane(props.data, canCollapse(), Boolean(props.footerReference)) !== 'none'}>
    <UserMessageActions itemId={props.data.id} text={props.data.text} at={props.data.at}
      reference={props.footerReference} gap={actionGap(layout())}
      collapse={canCollapse() ? { bubbleKey: conversationBubbleKey(props.data), anchorId: props.data.id } : undefined}
      generating={isGenerating()} readOnly={Boolean(props.data.guguDelivery) || (props.conversation && props.data.role === 'assistant')} vars={props.vars} />
    </Show>
    </>}>
      {(editing) => <UserMessageEditor edit={editing()} height={editorMetrics().height} textHeight={editorMetrics().textHeight} />}
    </Show>
    <InputSendStatus item={props.data} right={isDoubleColumnLayout(layout()) ? paintedWidth() + 6 : 0}
      top={attachStripH() + (isDoubleColumnLayout(layout()) ? Math.max(0, cardH() - 15) : cardH() + 2)} />
    </div>
  );
}


/**
 * 一枚附件 = 一条文件行(`@gugu/session-shared/file-row`):文件是图标 + 名字 + 扩展名,图片是同高的缩略图。
 * 点开是同一个回调,宿主按 kind 分岔(图 → 看图、文件 → 用它该用的方式打开)。
 */
function AttachmentChip(props: { attachment: ChatAttachment; itemId: string }) {
  const commands = useCommands();
  const translate = useChatTranslator();
  const isImage = () => props.attachment.kind !== 'file';
  const [resolvedDataUrl] = createResource(
    () => (!isImage() || props.attachment.dataUrl ? null : props.attachment.id),
    async () => commands().resolveAttachment?.(props.attachment) ?? null
  );
  const dataUrl = () => props.attachment.dataUrl ?? resolvedDataUrl() ?? undefined;
  // 第二行只写扩展名(CSV、MD),没有扩展名就不画;类型文案归群聊卡片那套,❌ 这里再抄一份。
  const extension = () => /\.([^./]+)$/.exec(props.attachment.name)?.[1].toUpperCase();

  return (
    <button
      type="button"
      data-attachment-chip
      data-kind={isImage() ? 'image' : 'file'}
      class="gg-file-row"
      // 名字长了会截断,全名放这儿。
      title={props.attachment.name}
      // 附件名是原始数据(用户自己的文件名),只被这句话包住,❌ 不进 catalog。
      aria-label={translate(
        isImage() ? 'transcript.viewImage' : 'transcript.viewAttachment',
        { name: props.attachment.name }
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (props.attachment.href) { commands().onOpenLink?.(props.attachment.href); return; }
        commands().onViewAttachment?.({
          attachment: { ...props.attachment, ...(dataUrl() ? { dataUrl: dataUrl() } : {}) },
          itemId: props.itemId,
          source: 'user-message',
          thumb: e.currentTarget.querySelector('img') ?? undefined,
        });
      }}
    >
      <Show
        when={isImage() && dataUrl()}
        fallback={<>
          {/* 图片读不回来时给「图裂了」那个字形,❌ 不要跟文件用同一个 —— 那会把
              「这张图没读到」说成「这是个文件」。 */}
          <span class="gg-file-row-icon">
            <FileMark name={props.attachment.name} off={isImage()} />
          </span>
          <Show when={!isImage()}>
            <span class="gg-file-row-text">
              <span class="gg-file-row-name">{props.attachment.name}</span>
              <Show when={extension()}>{extension => <span class="gg-file-row-detail">{extension()}</span>}</Show>
            </span>
          </Show>
        </>}
      >
        {(src) => <img src={src()} alt="" />}
      </Show>
    </button>
  );
}

export { userInnerWidth };
export type { MessageVars };
