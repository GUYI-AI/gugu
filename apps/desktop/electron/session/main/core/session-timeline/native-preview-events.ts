/** Preview invalidation carries identity only; it never attaches the full live session model. */
const listeners = new Set<(sessionId?: string) => void>();

export function onNativeMessagePreviewChanged(listener: (sessionId?: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishNativeMessagePreviewChanged(sessionId?: string): void {
  for (const listener of listeners) listener(sessionId);
}

export async function readNativeActiveMessagePreview(sessionId: string, historyFloor: string | null) {
  const { peekAcpWorkerClient } = await import('../acp/runtime-process/host');
  const client = await peekAcpWorkerClient();
  return client ? client.activeMessagePreview({ sessionId, historyFloor }) : null;
}
