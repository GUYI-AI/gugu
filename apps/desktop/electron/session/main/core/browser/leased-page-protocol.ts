import type { WebContents } from 'electron';
import { anySignal } from '@gugu/core/shared/anySignal';
import { createPageProtocol, type PageProtocol } from './page-protocol';
import { LeasedPageInput } from './leased-page-input';
import { browserPageFeedback } from '@shared/browser-page-feedback';

/** Fence undispatched commands, release dispatched controls, then let the owner detach the protocol. */
export function leasePageProtocol(contents: WebContents, options: { ready: Promise<void>; capture(params: Record<string, unknown>): Promise<unknown> }) {
  const commands = new AbortController(), input = new LeasedPageInput();
  const feedback = browserPageFeedback(contents);
  const lifetimes = new WeakMap<AbortSignal, AbortSignal>();
  const watched = new Map<AbortSignal, () => void>();
  const raw = createPageProtocol(contents, { ...options,
    sent: (method, params, sessionId, native, signal) => {
      input.sent(method, params, sessionId, native);
      if (!commands.signal.aborted) {
        const call = signal && lifetimes.get(signal);
        if (call && !watched.has(call)) {
          const stop = feedback.followCall(call);
          const ended = () => watched.delete(call);
          call.addEventListener('abort', ended, { once: true });
          watched.set(call, () => { call.removeEventListener('abort', ended); stop(); });
        }
        feedback.dispatched(method, params, native, !!sessionId);
      }
    },
  });
  // Native events do not attach a debugger merely to observe presentation.
  const navigated = () => feedback.invalidate();
  contents.on('did-navigate', navigated);
  let closing: Promise<void> | undefined;
  const protocol: PageProtocol = { ...raw, get attached() { return raw.attached; },
    send: (method, params, sessionId, signal) => {
      const lifetime = anySignal([signal, commands.signal]);
      if (signal) lifetimes.set(lifetime, signal);
      return raw.send(method, params, sessionId, lifetime);
    },
    maintain: (method, params, sessionId, signal) => raw.maintain!(method, params, sessionId, anySignal([signal, commands.signal])),
  };
  return { protocol, cleanup() {
    if (closing) return closing;
    commands.abort(new Error('The task page lease ended'));
    contents.removeListener('did-navigate', navigated);
    for (const stop of watched.values()) stop(); watched.clear(); feedback.invalidate();
    // A lost native connection must never be reattached just to release old input.
    closing = raw.attached ? input.release((method, params, sessionId) =>
      raw.send(method, params, sessionId, AbortSignal.timeout(5_000))) : Promise.resolve();
    return closing;
  } };
}
