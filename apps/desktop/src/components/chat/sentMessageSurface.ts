import { createContext } from 'react'

/**
 * Whether this message body is drawn in a task timeline's slot. The same message can be on screen in a chat and in the
 * task that sent it (a group beside its task), so its widget's tab is named per surface. A task is open in one place, so
 * the timeline holds one copy of a message and the name stays the same when its row scrolls away and comes back.
 *
 * In a slot a picture also loads as soon as its row is mounted: the timeline draws a sent picture without its dimensions
 * (they come with a chat row, not with a send's receipt), so its size is known only once it has loaded, and loading ahead
 * of the viewport lets the timeline's scroll anchoring absorb the change before the reader gets there.
 */
export const SentMessageSurface = createContext(false)

export const widgetTabId = (widgetId: string, inTimeline: boolean) => inTimeline ? `widget:${widgetId}:timeline` : `widget:${widgetId}`
