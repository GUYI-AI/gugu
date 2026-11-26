export type ChatListNavigationDirection = 1 | -1

/** Return the next visible chat without wrapping at either end. */
export function nextChatId(
  chatIds: readonly string[],
  currentChatId: string | null,
  direction: ChatListNavigationDirection,
): string | null {
  if (chatIds.length === 0) return null

  const currentIndex = currentChatId ? chatIds.indexOf(currentChatId) : -1
  if (currentIndex === -1) return direction === 1 ? chatIds[0] : chatIds[chatIds.length - 1]

  const nextIndex = currentIndex + direction
  return chatIds[nextIndex] ?? null
}
