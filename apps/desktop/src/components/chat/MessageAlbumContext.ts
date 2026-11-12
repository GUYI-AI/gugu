import { createContext, useContext } from 'react'
import type { MessageAlbums } from './messageAlbum'

/** #2581 The sends the list draws as one message, by the id of the row that stands for each (see messageAlbum.ts). */
export const MessageAlbumContext = createContext<MessageAlbums>(new Map<string, never>())

/** The rows of the send this row stands for, in the order they were sent; null for a message sent on its own. */
export function useMessageAlbum(messageId: string) {
  return useContext(MessageAlbumContext).get(messageId) ?? null
}
