import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';
import type { AppVoiceNoteEvent, AppVoiceNoteView } from '@shared/extensions/voice-note-session';

/**
 * #1927 (47) `gugu.voiceNote` on a page: the verbs reject with a coded Error, as every verb does, and `onChanged(name, fn)`
 * keeps one host watch per call — the recorder whole until `ended`, which the host says when the grant went, or the
 * runtime says when the host never started it. Without the capability there is no `gugu.voiceNote` at all.
 */
type VoiceNote = {
  start: (name: string, options?: object) => Promise<unknown>; stop: (name: string) => Promise<unknown>;
  onChanged: (name: unknown, fn: unknown) => () => void;
};
const VIEW: AppVoiceNoteView = { recorder: { phase: 'recording', elapsedMs: 100, level: 0.2, silentMs: 0, error: null }, jobs: [] };

function page(watchAnswer: (args: unknown[]) => Promise<unknown>) {
  let deliver!: (watchId: string, event: AppVoiceNoteEvent) => void;
  const watch = vi.fn(async (...args: unknown[]) => watchAnswer(args));
  const reportError = vi.fn(async () => undefined);
  const start = vi.fn(async () => Promise.reject({ code: 'denied', message: 'needs a click' }));
  const gugu = createGugu({
    appFiles: {}, reportError,
    voiceNote: { start, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(async () => ({ name: 'main', state: 'ready', ...VIEW })), retry: vi.fn(),
      openMicSettings: vi.fn(), status: vi.fn(), watch },
    onVoiceNote: (fn: typeof deliver) => { deliver = fn; return () => undefined; },
  } as never, {} as never) as unknown as { voiceNote: VoiceNote; onVoiceNote?: unknown };
  return { gugu, voiceNote: gugu.voiceNote, watch, reportError, deliver: (watchId: string, event: AppVoiceNoteEvent) => deliver(watchId, event) };
}

describe('gugu.voiceNote on a page', () => {
  it('the verbs, coded refusals, and no host half on the page; none of it without the capability', async () => {
    const { gugu, voiceNote } = page(async () => ({ state: 'watching' }));
    expect(Object.keys(voiceNote).sort()).toEqual(['onChanged', 'openMicSettings', 'pause', 'resume', 'retry', 'start', 'status', 'stop']);
    expect(gugu.onVoiceNote).toBeUndefined();
    await expect(voiceNote.start('main')).rejects.toMatchObject({ code: 'denied', message: 'needs a click' });
    expect(await voiceNote.stop('main')).toMatchObject({ state: 'ready', recorder: { phase: 'recording' } });
    const without = createGugu({ appFiles: {}, reportError: vi.fn() } as never, {} as never) as unknown as { voiceNote?: unknown };
    expect(without.voiceNote).toBeUndefined();
  });

  it('each subscription hears its own watch until it ends or is stopped', async () => {
    const { voiceNote, watch, deliver } = page(async () => ({ name: 'main', state: 'watching' }));
    const first = vi.fn(), second = vi.fn();
    const stopFirst = voiceNote.onChanged('main', first);
    voiceNote.onChanged('main', second);
    expect(watch.mock.calls).toEqual([['1', 'main', true], ['2', 'main', true]]);
    deliver('1', { name: 'main', state: 'changed', ...VIEW });
    expect(first).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'changed', ...VIEW });
    expect(second).not.toHaveBeenCalled();
    deliver('2', { name: 'main', state: 'ended' });
    deliver('2', { name: 'main', state: 'changed', ...VIEW });
    expect(second.mock.calls).toEqual([[{ name: 'main', state: 'ended' }]]);
    stopFirst(); stopFirst();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(3));
    expect(watch.mock.calls.at(-1)).toEqual(['1', 'main', false]);
  });

  it('not started — no conversation chosen, or refused — ends at once; a refusal is reported as the App\'s error', async () => {
    const unbound = page(async () => ({ name: 'main', state: 'unbound' }));
    const heard = vi.fn();
    unbound.voiceNote.onChanged('main', heard);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'ended' }));
    const refused = page(async () => Promise.reject({ code: 'denied', message: 'A binding is the person\'s' }));
    const told = vi.fn();
    refused.voiceNote.onChanged('main', told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledExactlyOnceWith({ name: 'main', state: 'ended' }));
    expect(refused.reportError).toHaveBeenCalledWith(expect.stringContaining('gugu.voiceNote.onChanged(main)'));
    expect(() => refused.voiceNote.onChanged('main', 'not a function')).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => refused.voiceNote.onChanged(7, told)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
