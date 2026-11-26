import { useEffect, useRef } from 'react';
import type { AskSource, Settlement } from '@gugu/session-core/session-record/contract';
import { passwordAskOf, PASSWORD_ASK_SOURCE, type PasswordRequestView } from '@gugu/core/shared/passwordBetaProtocol';
import { mountPasswordRequestCard } from '@gugu/session-chat-ui/password-card';
import { initSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { sessionWaitsOnApproval } from './app-install-approval';
import { useSessionHostAsk } from './use-session-host-ask';

const PASSWORD: readonly AskSource[] = [PASSWORD_ASK_SOURCE];

/**
 * An Agent's password request (password_save's form, password_fill's approval) waiting in its session: the session's
 * `password` Ask, drawn above the composer as its card, where the person is looking — like an App install's band and an
 * agent's question. The card answers the vault (here, or the desktop that keeps it); the outcome ends the Ask.
 */
export function SessionPasswordRequest({ sessionId, session, settlements }: {
  sessionId: string | null;
  /** Its status as the host wrote it: without `settlements`, the timeline is read only while it waits on an approval. */
  session?: { status: string | null; detail: string | null } | null;
  /** What the page's own feed already holds of this session's asks; absent = follow the timeline here. */
  settlements?: Readonly<Record<string, Settlement>> | null;
}) {
  const ask = useSessionHostAsk(settlements || sessionWaitsOnApproval(session) ? sessionId : null, PASSWORD, false, settlements);
  const request = passwordAskOf(ask?.origin);
  if (!sessionId || !request) return null;
  return <div className="px-2 pt-1" data-composer-top-band="password"><PasswordRequestDock key={request.requestId} request={request} /></div>;
}

/** The card itself, for any surface that holds the Ask (the session page, the agent's private chat). */
export function PasswordRequestDock({ request }: { request: PasswordRequestView }) {
  const host = useRef<HTMLDivElement>(null);
  // One card per request (the caller keys it): the payload does not change while it waits.
  useEffect(() => host.current ? mountPasswordRequestCard(host.current, request, initSharedChatContext()) : undefined,
    []);
  return <div ref={host} data-testid="session-password-request" />;
}
