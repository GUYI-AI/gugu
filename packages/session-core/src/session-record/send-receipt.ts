/** Unwrap MCP text content without treating an error envelope as a successful receipt. */
export function sendReceipt(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    // A receipt names a message or its recipients. Every done tool call is asked whether it is one, on every rebuild
    // of a transcript: the other tools' outputs are turned away here, unparsed.
    if (!raw.includes('message_id') && !raw.includes('recipients')) return null;
    try { return sendReceipt(JSON.parse(raw)); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.isError === true || value.ok === false || value.status === 'error' || value.status === 'failed') return null;
  if (typeof value.message_id === 'string' || Array.isArray(value.recipients)) return value;
  const content = Array.isArray(raw) ? raw : value.content;
  if (Array.isArray(content)) for (const block of content) {
    if (block?.type === 'text') { const result = sendReceipt(block.text); if (result) return result; }
  }
  return null;
}

/** A message attachment link carries its canonical source chat; the host still checks message access. */
export function sentAttachmentLink(messageId: string, chatId?: string): string {
  return `gugu-message-file://${messageId}${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`;
}

export function parseSentAttachmentLink(href: string): { messageId: string; chatId?: string } | null {
  const match = /^gugu-message-file:\/\/([a-f0-9-]{36})(?:\?chat=([a-f0-9-]{36}))?$/i.exec(href);
  return match ? { messageId: match[1]!.toLowerCase(), ...(match[2] ? { chatId: match[2].toLowerCase() } : {}) } : null;
}
