export type ChatListNavigationDirection = 1 | -1

/** Return the next visible chat without wrapping at either end. */
export function nextChatId(
  chatIds: readonly string[],
  currentChatId: string | null,
  direction: ChatListNavigationDirection,
  accepts: (id: string) => boolean = () => true,
): string | null {
  if (chatIds.length === 0) return null

  const currentIndex = currentChatId ? chatIds.indexOf(currentChatId) : -1
  const start = currentIndex === -1 && direction === -1 ? chatIds.length : currentIndex
  for (let i = start + direction; i >= 0 && i < chatIds.length; i += direction) {
    if (accepts(chatIds[i])) return chatIds[i]
  }
  return null
}
