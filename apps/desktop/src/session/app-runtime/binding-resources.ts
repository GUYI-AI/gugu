import type { AppResourceEvent } from '@shared/extensions/agent-resources';
import { coded, guguError, type GuguHost } from './host';

/**
 * #1927 (42) `gugu.bindings`' agent resources: `resources(name, domain)`, `resource(name, domain, key)`, `save` / `remove`
 * (`chat:resources:write`), and `onResourcesChanged(name, fn)`. Each `onResourcesChanged` keeps its own host watch, as
 * `files.onChanged` does; it hears `{ state: 'changed' }` (read again) until `{ state: 'ended' }` — the host ended it (the
 * grant, account, App or chosen conversation changed) or never started it (no conversation chosen, or refused, which is
 * also reported as the App's error). The call itself cannot reject: it returns the unsubscribe.
 */
export function bindingResourcesApi(raw: GuguHost, reportError: (message: string) => Promise<unknown>): Record<string, unknown> {
  const bindings = raw.bindings;
  if (!bindings) return {};
  const { resources, resource, watch, save, remove } = bindings;
  const api: Record<string, unknown> = {
    ...(resources ? { resources: coded(resources) } : {}),
    ...(resource ? { resource: coded(resource) } : {}),
    ...(save ? { save: coded(save) } : {}),
    ...(remove ? { remove: coded(remove) } : {}),
  };
  // 50 (resources-management.ts): each one call, answered as the host answers it.
  for (const member of ['upload', 'createFolder', 'rename', 'removeFolder', 'transcribeVoiceNote', 'removeVoiceNote', 'exportVoiceNote'] as const) {
    const call = bindings[member];
    if (call) api[member] = coded(call as (...args: never[]) => Promise<unknown>);
  }
  const hear = raw.onBindingResources;
  if (!watch || !hear) return api;
  const handlers = new Map<string, (event: AppResourceEvent) => void>();
  let nextWatch = 0;
  let hearing: (() => void) | null = null;
  const end = (watchId: string, name: string) => {
    const handler = handlers.get(watchId);
    if (handlers.delete(watchId)) handler?.({ name, state: 'ended' });
  };
  api.onResourcesChanged = (name: unknown, handler: unknown): (() => void) => {
    if (typeof name !== 'string' || !name) throw guguError('invalid', 'bindings.onResourcesChanged(name, fn) names the binding');
    if (typeof handler !== 'function') throw guguError('invalid', 'bindings.onResourcesChanged(name, fn) takes a function');
    hearing ??= hear((watchId, event) => {
      const fn = handlers.get(watchId);
      if (event.state === 'ended') handlers.delete(watchId);
      fn?.(event);
    });
    const watchId = String(++nextWatch);
    handlers.set(watchId, handler as (event: AppResourceEvent) => void);
    const registered = coded(watch)(watchId, name, true).then((answer) => {
      if ((answer as { state?: unknown } | null)?.state !== 'watching') end(watchId, name);
    }, (error: unknown) => {
      void reportError(`gugu.bindings.onResourcesChanged(${name}): ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      end(watchId, name);
    });
    return () => {
      if (handlers.delete(watchId)) void registered.then(() => coded(watch)(watchId, name, false)).catch(() => undefined);
    };
  };
  return api;
}
