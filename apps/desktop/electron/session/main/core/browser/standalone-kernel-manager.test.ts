import { describe, expect, it, vi } from 'vitest';
import type { BrowserKernelKind } from '@shared/browser-kernel';
import { StandaloneKernelManager } from './standalone-kernel-manager';
import type { StandaloneKernelAsset, StandaloneKernelInstallation, StandaloneKernelProgress } from './standalone-kernel-installer';

const installation = { version: '158.0.1.1', installedBytes: 4096 } as StandaloneKernelInstallation;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let selection: BrowserKernelKind = 'builtin';
  let installed: StandaloneKernelInstallation | null = null;
  const completion = deferred<StandaloneKernelInstallation>();
  const install = vi.fn(async (_input: { signal: AbortSignal; progress(value: StandaloneKernelProgress): void }) => {
    const value = await completion.promise;
    installed = value;
    return value;
  });
  const select = vi.fn(async (value: BrowserKernelKind) => { selection = value; });
  const remove = vi.fn(async () => { installed = null; });
  const inUse = vi.fn(() => false);
  const manager = new StandaloneKernelManager({
    asset: { version: '158.0.1.1', bytes: 2048 } as StandaloneKernelAsset,
    selection: async () => selection,
    select, installation: async () => installed, install, remove, inUse,
  });
  return { manager, install, select, completion, remove, inUse, selected: () => selection };
}

describe('standalone kernel consent and cancellation', () => {
  it('reports real download progress but does not persist the new engine until verification completes', async () => {
    const f = fixture();
    expect(f.install).not.toHaveBeenCalled();
    await f.manager.downloadAndSwitch();
    const input = f.install.mock.calls[0]![0];
    input.progress({ stage: 'downloading', receivedBytes: 1024, totalBytes: 2048 });
    expect(await f.manager.status()).toMatchObject({ selected: 'standalone', phase: 'downloading', receivedBytes: 1024 });
    expect(f.selected()).toBe('builtin');
    await f.manager.downloadAndSwitch();
    expect(f.install).toHaveBeenCalledOnce();
    f.completion.resolve(installation);
    await vi.waitFor(() => expect(f.selected()).toBe('standalone'));
    await vi.waitFor(async () => expect((await f.manager.status()).phase).toBe('idle'));
    expect(await f.manager.status()).toMatchObject({ installation: { version: '158.0.1.1', installedBytes: 4096 } });
  });

  it('cancels even if the installer resolves late and does not switch the preference', async () => {
    const f = fixture();
    await f.manager.downloadAndSwitch();
    const cancelling = f.manager.cancel();
    expect(f.install.mock.calls[0]![0].signal.aborted).toBe(true);
    f.completion.resolve(installation);
    await cancelling;
    expect(f.selected()).toBe('builtin');
    expect(await f.manager.status()).toMatchObject({ phase: 'idle', selected: 'builtin', error: null });
  });

  it('a switch back to built-in wins over an installation already committing its preference', async () => {
    const f = fixture();
    const committing = deferred<void>();
    f.select.mockImplementation(async () => { await committing.promise; });
    await f.manager.downloadAndSwitch();
    f.completion.resolve(installation);
    await vi.waitFor(() => expect(f.select).toHaveBeenCalledWith('standalone'));
    const switching = f.manager.useBuiltin();
    committing.resolve();
    await switching;
    expect(f.select).toHaveBeenLastCalledWith('builtin');
  });

  it('a failed archive leaves the previous preference and exposes the actual error', async () => {
    const f = fixture();
    await f.manager.downloadAndSwitch();
    f.completion.reject(new Error('checksum mismatch'));
    await vi.waitFor(async () => expect((await f.manager.status()).error).toBe('checksum mismatch'));
    expect(f.selected()).toBe('builtin');
    expect((await f.manager.status()).installation).toBeNull();
  });

  it('does not delete a browser while any tab or profile shutdown is still using it', async () => {
    const f = fixture();
    f.inUse.mockReturnValue(true);
    await expect(f.manager.remove()).rejects.toThrow('still in use');
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    f.inUse.mockReturnValue(false);
    await f.manager.remove();
    expect(f.select).toHaveBeenCalledWith('builtin');
    expect(f.remove).toHaveBeenCalledOnce();
  });
});
