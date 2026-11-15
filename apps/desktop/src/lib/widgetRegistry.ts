import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseWidgetMessage, type WidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import type { MessageReferenceTarget } from '@gugu/session-shared/markdown/dialect'
import { chatService } from './chat'
import { chatDb } from './supabase'

export type WidgetOriginMessage = Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id' | 'content'>
export interface RegisteredWidget {
  id: string
  chat_id: string
  message_id: string
  app: string
  view: string
  text: string
  data: Record<string, unknown> | null
  created_by: string | null
}
const WIDGET_COLUMNS = 'id,chat_id,message_id,app,view,text,data,created_by'

export async function registeredWidgetBy(column: 'id' | 'message_id', value: string): Promise<RegisteredWidget | null> {
  const { data, error } = await chatDb.from('widgets').select(WIDGET_COLUMNS).eq(column, value).maybeSingle()
  if (error) throw new Error(error.message)
  return data as RegisteredWidget | null
}

export type ResolvedWidget = { id: string; widget: WidgetMessage; senderId: string | null }

/** A widget row's view: its own spec, the original body's height. */
function resolvedOf(row: RegisteredWidget, parsed: WidgetMessage): ResolvedWidget {
  return { id: row.id, senderId: row.created_by, widget: { v: 2, app: row.app, view: row.view, text: row.text, wid: row.id,
    ...(row.data ? { data: row.data } : {}), ...(parsed.height !== undefined ? { height: parsed.height } : {}) } }
}

/** An original as the registry binds it (by its message); one it does not know is shown as text only. */
export async function widgetForOriginal(message: WidgetOriginMessage): Promise<ResolvedWidget | null> {
  const parsed = parseWidgetMessage(message.content)
  const row = parsed ? await registeredWidgetBy('message_id', message.id) : null
  return parsed && row ? resolvedOf(row, parsed) : null
}

export type MessageReferenceRead =
  | { status: 'unreadable' }
  | { status: 'retracted'; widget: boolean }
  | { status: 'readable'; message: MessageItem; widget?: ResolvedWidget }

/** Both navigation and cards read as the viewing account, including cold references. */
export async function readMessageReference(target: MessageReferenceTarget, userId: string): Promise<MessageReferenceRead> {
  if (target.kind === 'message') {
    const message = await chatService.getMessageById(target.messageId, userId)
    if (!message || message.chat_id !== target.chatId) return { status: 'unreadable' }
    if (message.retracted_at) return { status: 'retracted', widget: message.content_type === 'widget' }
    if (message.content_type !== 'widget') return { status: 'readable', message }
    const widget = await widgetForOriginal(message)
    return widget ? { status: 'readable', message, widget } : { status: 'unreadable' }
  }
  const row = await registeredWidgetBy('id', target.widgetId)
  if (!row) {
    const { data, error } = await chatDb.rpc('widget_origin', { p_widget_id: target.widgetId })
    if (error) throw new Error(error.message)
    return data?.[0]?.is_retracted ? { status: 'retracted', widget: true } : { status: 'unreadable' }
  }
  const message = await chatService.getMessageById(row.message_id, userId)
  if (!message || message.chat_id !== row.chat_id || message.content_type !== 'widget') return { status: 'unreadable' }
  if (message.retracted_at) return { status: 'retracted', widget: true }
  const parsed = parseWidgetMessage(message.content)
  if (!parsed) return { status: 'unreadable' }
  return { status: 'readable', message, widget: resolvedOf(row, parsed) }
}
