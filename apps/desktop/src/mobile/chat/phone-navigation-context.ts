/** Filter the existing rows without reconstructing their route identities. */
export function matchesPhoneNavigationLabel(name: string, query: string): boolean {
  return name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}

export function phoneTopicHeader(
  room: { id: string; name: string },
  current: { chatId: string; name: string } | null,
  topics: readonly { chat_id: string; name: string }[],
) {
  if (!current) return { kind: 'chat' as const, id: room.id, name: room.name }
  const live = topics.find(topic => topic.chat_id === current.chatId)
  return { kind: 'topic' as const, id: current.chatId, name: live?.name ?? current.name }
}

export function phoneAgentHeaderName(sessionTitle: string, identityName?: string | null): string {
  return identityName?.trim() ? identityName : sessionTitle
}
