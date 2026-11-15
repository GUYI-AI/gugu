import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import { agentSessionContext } from './extension-agent-context';
import { extensionsService } from './extensions-root';
import { extensionProjections } from './extension-projection-bridge';
import type { ProjectionRemoteAppWatch } from './projection-remote-host';

/**
 * A page on another of the person's computers watches this App's projection in a session on this machine
 * (projection-remote-host.ts): this machine's install of the same App version, switched on, for a session here.
 */
export async function admitRemoteProjection(input: ProjectionRemoteAppWatch, send: (packet: ProjectionHostPacket) => void) {
  let version: string;
  try { version = extensionsService().get(input.app).manifest.version; }
  catch { throw Object.assign(new Error('This App is not installed on that computer'), { code: 'not-installed' }); }
  // A page and its program are one App, never two halves of different releases (as for app_call).
  if (version !== input.version) throw Object.assign(new Error(`That computer has version ${version} of this App`), { code: 'version-mismatch' });
  if (!(await agentSessionContext(input.session))) throw Object.assign(new Error('This task is not on that computer'), { code: 'not-found' });
  return extensionProjections.deviceViewer(input.app, input.session, input.source, send);
}
