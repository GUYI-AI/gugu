import type { CredentialUseBinding } from './credential-use-contract';
import type { CredentialHandoff } from './credential-handoff';
import { privateCredentialSurface } from './credential-isolation-registry';

/** Fixed host wiring after registerUse, never a page/IPC completion claim. Native load events only
 * request a fresh lifecycle read; the lifecycle still owns audit, cleanup, revocation and handback.
 */
export function watchCredentialLoginCompletion(
  binding: CredentialUseBinding, lifecycle: Pick<CredentialHandoff, 'refresh' | 'invalidate'>,
): () => void {
  const id = binding.loginSurfaceId, epoch = binding.loginSurfaceEpoch, browserId = binding.browserId;
  const surface = privateCredentialSurface(id, epoch), contents = surface.contents;
  if (surface.browserId !== browserId || contents.isDestroyed()) throw new Error('credential_completion_surface_unavailable');
  const refresh = lifecycle.refresh.bind(lifecycle), invalidate = lifecycle.invalidate.bind(lifecycle);
  let closed = false, dirty = false, running = false;

  const close = () => {
    if (closed) return;
    closed = true; dirty = false;
    contents.removeListener('dom-ready', schedule);
    contents.removeListener('did-navigate', schedule);
    contents.removeListener('did-navigate-in-page', inPage);
    contents.removeListener('did-stop-loading', schedule);
    contents.removeListener('destroyed', close);
  };
  const pump = async () => {
    try {
      while (!closed && dirty) {
        dirty = false;
        const current = privateCredentialSurface(id, epoch);
        if (current.contents !== contents || current.browserId !== browserId || contents.isDestroyed()) {
          throw new Error('credential_completion_surface_unavailable');
        }
        await refresh();
      }
    } catch {
      try { invalidate(); } catch { /* No native/page error payload may leave the private boundary. */ }
      close();
    } finally { running = false; }
  };
  function schedule() {
    if (closed || contents.isDestroyed()) return;
    dirty = true;
    if (!running) { running = true; queueMicrotask(() => { void pump(); }); }
  }
  function inPage(_event: unknown, _url: string, mainFrame: boolean) { if (mainFrame) schedule(); }

  contents.on('dom-ready', schedule);
  contents.on('did-navigate', schedule);
  contents.on('did-navigate-in-page', inPage);
  contents.on('did-stop-loading', schedule);
  contents.once('destroyed', close);
  return close;
}
