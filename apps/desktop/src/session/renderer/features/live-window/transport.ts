import type { ProjectionHost } from '@/session/app-runtime/projection-source';
import type { TaskPageState } from '@shared/browser-task-page';
import type { LiveWindowResourceDescriptor } from '@shared/extensions/live-window-protocol';

export interface LiveWindowTransport {
  list(sessionId: string): Promise<readonly LiveWindowResourceDescriptor[]>;
  observe(sessionId: string, changed: () => void): Promise<() => void>;
  picture(source: LiveWindowResourceDescriptor, page: (state: TaskPageState) => void): ProjectionHost;
}

export function liveWindowDescriptors(value: unknown, sessionId: string): LiveWindowResourceDescriptor[] {
  if (!Array.isArray(value)) throw new Error('The host did not return live picture sources');
  return value.map(source => {
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || !source.id
      || source.sessionId !== sessionId || typeof source.title !== 'string'
      || !['task-page', 'app-projection'].includes(source.type)
      || source.size !== null && (!source.size || !Number.isFinite(source.size.width) || !Number.isFinite(source.size.height)
        || source.size.width <= 0 || source.size.height <= 0)
      || source.type === 'app-projection' && (typeof source.appId !== 'string' || !source.appId || typeof source.appVersion !== 'string' || !source.appVersion)) {
      throw new Error('The host returned an invalid live picture source');
    }
    return source as LiveWindowResourceDescriptor;
  });
}

/** A viewer has no producer authority. Its existing watch/send methods are installed by the transport. */
export const viewerOnly = {
  create: async (): Promise<{ id: string }> => { throw new Error('The live window only watches an existing source'); },
  publish: async (): Promise<void> => { throw new Error('The live window cannot publish a picture'); },
  close: async () => {}, closed: async () => {}, inputResult: async () => {},
};
