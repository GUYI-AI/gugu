import { desktopLiveWindowContext } from './desktop-context';
import { desktopLiveWindowTransport } from './desktop-transport';
import { getLiveWindowConversation } from './use-live-window-conversation';
import type { LiveWindowKind } from './types';

/** An App's automatic preview request targets the host's real picture container, not a duplicate App page. */
export async function revealLiveWindow(projectId: string, sessionId: string, kind: LiveWindowKind): Promise<void> {
  const context = desktopLiveWindowContext(projectId, sessionId, false);
  const transport = desktopLiveWindowTransport(context.deviceId === 'local' ? null : context.deviceId);
  await new Promise<void>((resolve, reject) => {
    let ended = false, off = () => {}, checking = false, again = false;
    const finish = (error?: unknown) => { if (ended) return; ended = true; clearTimeout(timeout); off(); if (error) reject(error); else resolve(); };
    const timeout = setTimeout(() => finish(new Error('The App has not published a live picture for this conversation')), 5_000);
    const check = async () => {
      if (ended) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        do {
          again = false;
          const sources = await transport.list(sessionId);
          if (sources.some(source => kind === 'browser' ? source.type === 'task-page' : source.type === 'app-projection' && source.appId === 'computer-use')) finish();
        } while (!ended && again);
      } catch (error) { finish(error); }
      finally { checking = false; }
    };
    void transport.observe(sessionId, () => { void check(); }).then(stop => { if (ended) { stop(); return; } off = stop; void check(); }, finish);
  });
  const conversation = getLiveWindowConversation(context, 'desktop', transport);
  await conversation.refresh();
  // Automatic App preview may discover a source, but must not undo the person's header-toggle choice.
}
