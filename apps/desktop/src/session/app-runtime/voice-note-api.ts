import type { AppVoiceNoteEvent } from '@shared/extensions/voice-note-session';
import { coded, guguError, type GuguHost } from './host';

/**
 * #1927 (47) `gugu.voiceNote`: `start(name, { meeting? })` (in a click), `pause`, `resume` (in a click), `stop`,
 * `retry(name, job)` (in a click), `openMicSettings(name)` (in a click), `status(name)` and `onChanged(name, fn)`. Each
 * `onChanged` keeps its own host watch, as `bindings.onResourcesChanged` does: `fn` hears the recorder and its notes whole
 * (`{ state: 'changed', recorder, jobs }`) until `{ state: 'ended' }` — the host ended it (the grant, account, App or chosen
 * conversation changed) or never started it (no conversation chosen, or refused, which is also reported as the App's
 * error). The call itself cannot reject: it returns the unsubscribe.
 */
export function voiceNoteApi(raw: GuguHost, reportError: (message: string) => Promise<unknown>): Record<string, unknown> | null {
  const host = raw.voiceNote;
  if (!host) return null;
  const { start, pause, resume, stop, retry, openMicSettings, status, watch } = host;
  const api: Record<string, unknown> = {
    start: coded(start), pause: coded(pause), resume: coded(resume), stop: coded(stop),
    retry: coded(retry), openMicSettings: coded(openMicSettings), status: coded(status),
  };
  const hear = raw.onVoiceNote;
  if (!hear) return api;
  const handlers = new Map<string, (event: AppVoiceNoteEvent) => void>();
  let nextWatch = 0;
  let hearing: (() => void) | null = null;
  const end = (watchId: string, name: string) => {
    const handler = handlers.get(watchId);
    if (handlers.delete(watchId)) handler?.({ name, state: 'ended' });
  };
  api.onChanged = (name: unknown, handler: unknown): (() => void) => {
    if (typeof name !== 'string' || !name) throw guguError('invalid', 'voiceNote.onChanged(name, fn) names the binding');
    if (typeof handler !== 'function') throw guguError('invalid', 'voiceNote.onChanged(name, fn) takes a function');
    hearing ??= hear((watchId, event) => {
      const fn = handlers.get(watchId);
      if (event.state === 'ended') handlers.delete(watchId);
      fn?.(event);
    });
    const watchId = String(++nextWatch);
    handlers.set(watchId, handler as (event: AppVoiceNoteEvent) => void);
    const registered = coded(watch)(watchId, name, true).then((answer) => {
      if ((answer as { state?: unknown } | null)?.state !== 'watching') end(watchId, name);
    }, (error: unknown) => {
      void reportError(`gugu.voiceNote.onChanged(${name}): ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      end(watchId, name);
    });
    return () => {
      if (handlers.delete(watchId)) void registered.then(() => coded(watch)(watchId, name, false)).catch(() => undefined);
    };
  };
  return api;
}
