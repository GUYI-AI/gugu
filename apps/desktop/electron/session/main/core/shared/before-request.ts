import type { CallbackResponse, OnBeforeRequestListenerDetails, Session } from 'electron';

type BeforeRequest = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void;

const claimed = new WeakMap<Session, string>();

/**
 * The one way to a session's `webRequest.onBeforeRequest`. Electron keeps a single listener per session and a second
 * silently replaces the first, taking down whatever it guarded (the default session's is what keeps previewed pages
 * off this machine's bytes). So each session's listener is installed here, once; a second claim throws — join the
 * first listener instead.
 */
export function claimBeforeRequest(ses: Session, owner: string, listener: BeforeRequest): void {
  const held = claimed.get(ses);
  if (held) throw new Error(`onBeforeRequest on this session already belongs to ${held}; ${owner} must join that listener`);
  claimed.set(ses, owner);
  ses.webRequest.onBeforeRequest(listener);
}

/** The claim's owner is done with the session (an App uninstalled; the session object lives on): its listener comes off. */
export function releaseBeforeRequest(ses: Session): void {
  if (!claimed.delete(ses)) return;
  ses.webRequest.onBeforeRequest(null);
}
