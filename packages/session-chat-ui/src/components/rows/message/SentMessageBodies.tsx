/** @jsxImportSource solid-js */
/**
 * The messages an agent sent to people (`ChatMessage.sentMessages`), drawn by the host with the chat's own MessageBody:
 * one slot per message. The slot is as tall as the host last reported (`ChatState.session.setBodySize`); before the
 * host has drawn it, an estimate from what the message is. This row never draws a widget, file card or reference
 * itself — that would be a second drawing of the same message kind.
 */
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import type { MeasureCtx } from '@session-chat/core/define';
import { layoutBlockStack } from '@session-chat/core/layout/block-stack';
import { Index, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';

/** Between two sent messages in one bubble (a group of files). */
export const SENT_BODY_GAP = 8;
/** A file card before the host has drawn it (FileAttachmentCard's height). */
const FILE_CARD_H = 60;
/** A picture before the host has drawn it. */
const IMAGE_H = 200;
/** A widget before the host has drawn it: WidgetBubble's width, and a height for when its App declares it (not the message). */
const WIDGET_W = 420;
const WIDGET_H = 240;

function estimate(message: MessageItem, ctx: MeasureCtx, width: number): { width: number; height: number } {
  if (message.content_type === 'widget') return { width: Math.min(width, WIDGET_W), height: parseWidgetMessage(message.content)?.height ?? WIDGET_H };
  if (message.content_type === 'attachment') return /\((image\/[^)]+)\)/.test(message.content?.split('\n')[0] ?? '')
    ? { width, height: IMAGE_H } : { width: Math.min(width, 260), height: FILE_CARD_H };
  const stack = layoutBlockStack(ctx.caches.parseBlocks(`sent:${message.id}`, message.content ?? ''), { ...ctx, width }, { isCollapsed: ctx.isCollapsed });
  return { width: stack.width, height: stack.height };
}

/** One sent message's slot: the host's drawn size, else the estimate. */
export function sentBodySize(message: MessageItem, ctx: MeasureCtx, width: number): { width: number; height: number } {
  return ctx.bodySize?.(message.id) ?? estimate(message, ctx, width);
}

/** All of a bubble's sent messages, stacked: the measure and the render read this one function. */
export function sentBodiesLayout(messages: readonly MessageItem[], ctx: MeasureCtx, width: number): { width: number; height: number } {
  const sizes = messages.map(message => sentBodySize(message, ctx, width));
  return { width: Math.max(0, ...sizes.map(size => Math.min(width, size.width))),
    height: sizes.reduce((sum, size) => sum + size.height, 0) + SENT_BODY_GAP * Math.max(0, sizes.length - 1) };
}

export function SentMessageBodies(props: { messages: readonly MessageItem[]; ctx: () => MeasureCtx | undefined; width: number }) {
  // A send is rebuilt from its call on every pass over the transcript, so the same message arrives as a new object:
  // Index keeps each slot, and its host content with it, instead of remounting a widget per streaming frame.
  return <div data-sent-message-bodies style={{ display: 'flex', 'flex-direction': 'column', gap: `${SENT_BODY_GAP}px`, overflow: 'hidden' }}>
    <Index each={props.messages}>{message => <SentMessageSlot message={message()} ctx={props.ctx} width={props.width} />}</Index>
  </div>;
}

function SentMessageSlot(props: { message: MessageItem; ctx: () => MeasureCtx | undefined; width: number }) {
  const commands = useCommands();
  const [root, setRoot] = createSignal<HTMLDivElement>();
  const mount = createMemo(() => commands().onMessageBodyMount);
  // What a sent message says never changes: the slot is offered once per message id, and again only for another message.
  const id = createMemo(() => props.message.id);
  createEffect(() => {
    const element = root(), offer = mount(), messageId = id();
    if (!element || !offer || !messageId) return;
    const cleanup = untrack(() => offer({ root: element, message: props.message }));
    if (cleanup) onCleanup(cleanup);
  });
  const size = () => { const ctx = props.ctx(); return ctx ? sentBodySize(props.message, ctx, props.width) : { width: props.width, height: 0 }; };
  // The slot is the row's whole inner width whatever the bubble is painted at now: the host's content decides its own
  // width inside it and reports both, so a narrow estimate cannot hold the content narrow. The stack clips the slot to
  // the bubble: the content is never wider than what it reported, so only empty slot is cut, and no scrollbar appears.
  return <div ref={setRoot} data-sent-message-body={props.message.id} data-content-type={props.message.content_type}
    style={{ height: `${size().height}px`, width: `${props.width}px`, 'min-width': 0, overflow: 'hidden' }} />;
}
