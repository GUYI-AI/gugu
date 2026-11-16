import type { LiveWindowResourceDescriptor } from '@shared/extensions/live-window-protocol';
import { extensionProjections } from './extension-projection-bridge';
import { extensionTaskPages, taskPageForScreen } from './task-page-host';
import { extensionsService } from './extensions-root';
import { projectionTaskProject } from './projection-task';

/** This read cannot acquire a page, start an App program or launch a native driver. */
export async function readLiveWindowSources(sessionId: string): Promise<LiveWindowResourceDescriptor[]> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('A live window needs a session');
  await projectionTaskProject(sessionId);
  const result: LiveWindowResourceDescriptor[] = extensionProjections.describeSession(sessionId).map(source => {
    const manifest = extensionsService().get(source.extensionId).manifest;
    return { id: source.id, sessionId, type: 'app-projection', appId: source.extensionId, appVersion: manifest.version,
      title: manifest.name, size: source.size };
  });
  const lease = extensionTaskPages.describeSession(sessionId)[0];
  if (lease) {
    const page = await taskPageForScreen(sessionId);
    lease.signal.throwIfAborted();
    if (page && !page.isDestroyed()) result.unshift({ id: lease.id, sessionId, type: 'task-page', title: page.state().title, size: null });
  }
  return result;
}
