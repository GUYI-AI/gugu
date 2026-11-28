import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext, createChatState, createChatView, type ChatCommands } from '@gugu/session-chat-ui';
import { nativeUserAttachmentCommands } from '@/components/session-watch/native-user-attachments';
import { openTranscriptImage } from '@renderer/lib/chat/delivered-message-presentation';
import { registerImageViewerHost, type ImageViewerRequest } from '@/lib/imageViewer';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIrkAAAAASUVORK5CYII=';
const ref = { id: 'immutable-image', name: 'photo.png', mimeType: 'image/png' as const };
// A restarted task: nothing runs, its turns come from the archive and the image is read by its attachment id alone.
const turns: TranscriptTurn[] = [{ id: 'c:turn:s28', seq: 28, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'c:turn:s28:message:user', seq: 0, role: 'user', text: 'caption', attachments: [ref] },
  { kind: 'message', id: 'c:turn:s28:message:answer', seq: 1, role: 'assistant', text: '收到图片' },
] }];
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

/** The task page's wiring (agent-conversation-view): the host reads bytes, a picture opens in the shared viewer. */
function mount(width: number, readImage: (id: string) => Promise<string>) {
  const native = nativeUserAttachmentCommands({ readImage, readPathImage: vi.fn(), openFile: vi.fn() });
  const commands: ChatCommands = { ...native, onViewAttachment: arg => openTranscriptImage(arg.attachment, arg.thumb, native.resolveAttachment!) };
  const opened: ImageViewerRequest[] = [];
  const unregister = registerImageViewerHost(request => { opened.push(request); });
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:45px;left:0;width:${width}px;height:800px`;
  document.body.append(host);
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', agentConversation: true, userGutter: 0 });
  const state = createChatState(context);
  state.transcript.history.seed(turns);
  const view = createChatView({ context, state, parent: host, commands });
  dispose = () => { view.dispose(); state.dispose(); context.dispose(); host.remove(); unregister(); };
  return { host, opened, chip: () => host.querySelector<HTMLButtonElement>('[data-attachment-chip]') };
}

it.each([390, 1280])('opens a restarted task picture out of its drawn thumbnail at once, reading it once, at %s px', async width => {
  const readImage = vi.fn(async () => url);
  const { host, opened, chip } = mount(width, readImage);
  await vi.waitFor(() => expect(chip()?.querySelector('img')?.naturalWidth).toBe(1));
  expect(chip()!.dataset.kind).toBe('image');
  chip()!.click();
  expect(opened, 'the viewer is asked as the click lands').toHaveLength(1);
  expect(opened[0]!.items[0]).toMatchObject({ url, alt: ref.name, thumb: chip()!.querySelector('img') });
  expect(readImage).toHaveBeenCalledExactlyOnceWith(ref.id);
  expect(host.textContent).toContain('caption');
});

it('opens a picture whose thumbnail has not been read yet at once, and reads it as the viewer shows it', async () => {
  let finish: (value: string) => void = () => {};
  const readImage = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const { opened, chip } = mount(1280, readImage);
  await vi.waitFor(() => expect(chip()).not.toBeNull());
  chip()!.click();
  expect(opened, 'no wait for the bytes before the viewer opens').toHaveLength(1);
  const [item] = opened[0]!.items;
  expect(item).toMatchObject({ url: '', alt: ref.name });
  const shown = item!.preview!();
  finish(url);
  expect(await shown).toBe(url);
  expect(readImage, 'the thumbnail and the viewer share one read').toHaveBeenCalledOnce();
});

it('opens at once and says the picture cannot be shown when its bytes cannot be read', async () => {
  const readImage = vi.fn(async () => { throw new Error('gone'); });
  const { opened, chip } = mount(1280, readImage);
  await vi.waitFor(() => expect(readImage).toHaveBeenCalledOnce());
  chip()!.click();
  expect(opened).toHaveLength(1);
  await expect(opened[0]!.items[0]!.preview!()).rejects.toThrow();
});
