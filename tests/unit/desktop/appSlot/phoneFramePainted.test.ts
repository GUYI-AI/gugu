// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost';
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest';
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol';

vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({}) }));
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => null }));
const manifest = parseExtensionManifest({ id: 'vote', name: 'Vote', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'main.html', contributes: { tabs: [{ name: 'poll', title: 'Vote' }] } });
const frames: HTMLIFrameElement[] = [];
const hosts: Array<ReturnType<typeof hostAppFrame>> = [];
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); frames.splice(0).forEach((frame) => frame.remove()); vi.restoreAllMocks(); });

function hosted(painted: () => void) {
  const frame = document.createElement('iframe');
  frame.src = 'https://vote.apps.gugu.invalid/main.html';
  document.body.append(frame);
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: vi.fn(), configurable: true });
  frames.push(frame);
  hosts.push(hostAppFrame(frame, { extensionId: 'vote', tabId: 'widget:w', tabName: 'poll', chatId: 'chat', capabilities: [], locale: 'en', themeMode: 'dark' },
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn(), painted }));
  return frame;
}
const from = (frame: HTMLIFrameElement, t: string) =>
  window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: new URL(frame.src).origin, data: { m: APP_FRAME_MARKER, t } }));

// A preloaded widget frame loads half a screen early; its placeholder goes when the App has drawn, not when it has loaded.
it('tells the slot its document painted, and only the frame that painted', () => {
  vi.spyOn(installedExtensionsStore, 'manifestFor').mockReturnValue(manifest);
  const first = vi.fn(), second = vi.fn();
  const one = hosted(first);
  hosted(second);
  from(one, 'hello');
  expect(first).not.toHaveBeenCalled();
  from(one, 'painted');
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});
