import { describe, expect, it, vi } from 'vitest';
import { HOST_EVENTS } from '@shared/extensions/host-calls';
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
    const rename = vi.fn(async () => 'renamed');
    const gugu = createGugu({
      appFiles: {}, reportError: () => {}, assistant: { status, open, advanceSetup, rename },
      onAssistantChanged: (handler: (read: unknown) => void) => { hear = handler; return () => { hear = undefined; }; },
    } as never, files) as Record<string, unknown> & { assistant: Record<string, (...args: unknown[]) => unknown> };
    expect(Object.keys(gugu.assistant).sort()).toEqual(['advanceSetup', 'onChanged', 'open', 'rename', 'status']);
    expect(await gugu.assistant.rename('main', 'Pip')).toBe('renamed');
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

  it('onChanged gets what status answers — the snapshot, or unbound alone — and nothing of the event itself', () => {
    const { pick } = HOST_EVENTS.onAssistantChanged;
    const status = { assistant: 'none', name: null, avatar: null, home: null, setup: 'shell', preparing: true, cloudAvailable: true, member: null, loadError: null, counts: null } as const;
    expect(pick({ type: 'assistantChanged', name: 'main', state: 'ready', status, hostPage: true })).toEqual([{ name: 'main', state: 'ready', status, hostPage: true }]);
    expect(pick({ type: 'assistantChanged', name: 'main', state: 'unbound' })).toEqual([{ name: 'main', state: 'unbound' }]);
  });

  it('a host without it has none', () => {
    const gugu = createGugu({ appFiles: {}, reportError: () => {} } as never, files) as Record<string, unknown>;
    expect(gugu.assistant).toBeUndefined();
  });
});
