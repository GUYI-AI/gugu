import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExtensionTabProvider, ExtensionTabResource } from './extension-tab-provider';
import { extensionSurfaceStore } from './extension-surface-store';

const h = vi.hoisted(() => ({ showModal: vi.fn(), invokeCommand: vi.fn() }));
vi.mock('@renderer/lib/modal/modal-provider', async (original) => ({
  ...await original<object>(), showModal: h.showModal,
}));
vi.mock('@renderer/lib/ipc', async (original) => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  return { ...actual, rpc: new Proxy(actual.rpc, {
    get(target, namespace, receiver) {
      if (namespace !== 'extensions') return Reflect.get(target, namespace, receiver);
      return new Proxy(actual.rpc.extensions, {
        get(target, command, receiver) {
          return command === 'invokeCommand' ? h.invokeCommand : Reflect.get(target, command, receiver);
        },
      });
    },
  }) };
});

const sessionId = 'unsaved-2877';
const tabId = 'file-tab';
const filePath = '/workspace/a<br>b.md';
const pageId = 27;
const provider = createExtensionTabProvider('workspace', 'main');
const resource = new ExtensionTabResource('workspace', filePath);
const close = () => provider.onBeforeClose!(
  { kind: provider.kind, tabId, state: { filePath } }, resource,
  { viewId: sessionId, place: { kind: 'session', sessionId, projectId: 'project' } },
  { alone: true },
);

beforeEach(() => {
  vi.resetAllMocks();
  // A real surface binds before it reports edits; an unbound empty surface is pruned.
  extensionSurfaceStore.setWebContentsId(sessionId, tabId, pageId);
  extensionSurfaceStore.reportDirty(sessionId, tabId, true, pageId);
  expect(extensionSurfaceStore.state(sessionId, tabId)).toMatchObject({
    webContentsId: pageId, dirtyIn: pageId, dirtyReports: 1,
  });
});
afterEach(() => extensionSurfaceStore.forget(sessionId, tabId));

it.each(['save', 'discard'] as const)('only permits closing after an explicit %s is acknowledged clean', async (choice) => {
  h.showModal.mockImplementation((_id, args) => {
    expect(args.fileName).toBe('a<br>b.md');
    args.onSuccess(choice);
  });
  h.invokeCommand.mockImplementation(async () => {
    extensionSurfaceStore.reportDirty(sessionId, tabId, false, pageId);
    return { success: true };
  });
  expect(await close()).toBe(true);
  expect(h.invokeCommand).toHaveBeenCalledExactlyOnceWith({
    webContentsId: pageId, commandId: `gugu.file.${choice}:${tabId}`,
  });
  expect(extensionSurfaceStore.state(sessionId, tabId).dirtyIn).toBeNull();
});

it('cancel keeps the dirty tab and sends no save or discard command', async () => {
  h.showModal.mockImplementation((_id, args) => args.onClose());
  expect(await close()).toBe(false);
  expect(h.invokeCommand).not.toHaveBeenCalled();
  expect(extensionSurfaceStore.state(sessionId, tabId).dirtyIn).toBe(pageId);
});

it('a failed save reported as still dirty vetoes closing', async () => {
  h.showModal.mockImplementation((_id, args) => args.onSuccess('save'));
  h.invokeCommand.mockImplementation(async () => {
    extensionSurfaceStore.reportDirty(sessionId, tabId, true, pageId);
    return { success: true };
  });
  expect(await close()).toBe(false);
  expect(h.invokeCommand).toHaveBeenCalledExactlyOnceWith({
    webContentsId: pageId, commandId: `gugu.file.save:${tabId}`,
  });
  expect(extensionSurfaceStore.state(sessionId, tabId).dirtyIn).toBe(pageId);
});

it('a rejected save remains a failure and never discards the dirty tab', async () => {
  const failure = new Error('file write failed');
  h.showModal.mockImplementation((_id, args) => args.onSuccess('save'));
  h.invokeCommand.mockRejectedValue(failure);
  await expect(close()).rejects.toBe(failure);
  expect(h.invokeCommand).toHaveBeenCalledTimes(1);
  expect(extensionSurfaceStore.state(sessionId, tabId).dirtyIn).toBe(pageId);
});
