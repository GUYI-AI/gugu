import type { ContextMentionProvider } from '@gugu/session-ui/react/components';

/**
 * A session's composer, as something else on screen may send through it: the words go the way typed words go (queued while
 * the agent works, the same failure notice), and its @ list is the composer's. The desktop's and the phone's composer each
 * offer theirs while shown; the last one shown answers.
 */
export interface SessionSend {
  send(text: string): Promise<void>;
  mentionProvider?: ContextMentionProvider;
}

const offered = new Map<string, SessionSend[]>();

export function offerSessionSend(sessionId: string, send: SessionSend): () => void {
  offered.set(sessionId, [...(offered.get(sessionId) ?? []), send]);
  return () => {
    const rest = (offered.get(sessionId) ?? []).filter((current) => current !== send);
    if (rest.length) offered.set(sessionId, rest);
    else offered.delete(sessionId);
  };
}

export function sessionSend(sessionId: string): SessionSend | null {
  return offered.get(sessionId)?.at(-1) ?? null;
}
