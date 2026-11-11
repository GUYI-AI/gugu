import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

/**
 * #1925 (44) `gugu.assistant` as a page reaches it: `status`, `open`, `advanceSetup` called straight through (the preload
 * reads the gesture on the very call), refusals as coded Errors, and `onChanged` built on the raw event, which is not on
 * `gugu` itself. A host without them (the phone, an older desktop) has no `gugu.assistant`.
 */
const files = { files: () => new Promise<never>(() => {}) };

describe('gugu.assistant', () => {
  it('has status, open, advanceSetup and onChanged; the raw event stays the host\'s', async () => {
    let hear: ((read: unknown) => void) | undefined;
    const status = vi.fn(async (name: string) => ({ name, state: 'unbound' }));
    const open = vi.fn(async () => { throw { code: 'denied', message: 'This account has no assistant of its own' }; });
    const advanceSetup = vi.fn(async () => undefined);
    const gugu = createGugu({
      appFiles: {}, reportError: () => {}, assistant: { status, open, advanceSetup },
      onAssistantChanged: (handler: (read: unknown) => void) => { hear = handler; return () => { hear = undefined; }; },
    } as never, files) as Record<string, unknown> & { assistant: Record<string, (...args: unknown[]) => unknown> };
    expect(Object.keys(gugu.assistant).sort()).toEqual(['advanceSetup', 'onChanged', 'open', 'status']);
    expect(gugu.onAssistantChanged).toBeUndefined();
    expect(await gugu.assistant.status('main')).toEqual({ name: 'main', state: 'unbound' });
    await expect(gugu.assistant.open('main', 'close')).rejects.toMatchObject({ code: 'denied', message: expect.any(String) });
    expect(await gugu.assistant.advanceSetup('main', 'done')).toBeUndefined();
    expect(advanceSetup).toHaveBeenCalledExactlyOnceWith('main', 'done');
    const heard = vi.fn();
    const off = gugu.assistant.onChanged(heard) as () => void;
    const read = { name: 'main', state: 'ready', status: { assistant: 'found' } };
    hear!(read);
    expect(heard).toHaveBeenCalledExactlyOnceWith(read);
    off();
    expect(hear).toBeUndefined();
    expect(() => gugu.assistant.onChanged('not a function')).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('a host without it has none', () => {
    const gugu = createGugu({ appFiles: {}, reportError: () => {} } as never, files) as Record<string, unknown>;
    expect(gugu.assistant).toBeUndefined();
  });
});
