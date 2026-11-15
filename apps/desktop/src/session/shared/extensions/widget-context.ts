import type { AppWidget } from './app-runtime-protocol';
import { EXTENSION_WIDGET_IDENTITY_API_VERSION, type ExtensionHostContext } from './bridge-protocol';

/** Older Apps keep the original message projection when a live page changes slot. */
export function widgetContext(widget: AppWidget, apiVersion: number): NonNullable<ExtensionHostContext['widget']> {
  const identity = apiVersion >= EXTENSION_WIDGET_IDENTITY_API_VERSION && widget.id && widget.originMessageId;
  return { messageId: identity ? widget.messageId : widget.originMessageId ?? widget.messageId,
    data: widget.data, sender: widget.senderId,
    ...(identity ? { id: widget.id, originMessageId: widget.originMessageId } : {}) };
}

export function sameWidgetIdentity(a: AppWidget | undefined, b: AppWidget | undefined): boolean {
  return !!a && !!b && !!a.id && !!a.originMessageId && a.id === b.id && a.originMessageId === b.originMessageId
    && a.senderId === b.senderId && JSON.stringify(a.data) === JSON.stringify(b.data);
}
