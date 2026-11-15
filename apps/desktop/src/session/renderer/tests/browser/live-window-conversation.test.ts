import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveWindowConversation } from '../../features/live-window/conversation';
import type { LiveWindowTransport } from '../../features/live-window/transport';
import type { LiveWindowResourceDescriptor } from '@shared/extensions/live-window-protocol';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';

const context = { conversationId: 'chat', deviceId: 'device', sessionId: 'session', agentId: 'agent', privateAgentChat: true, shown: true };
const source: LiveWindowResourceDescriptor = { id: 'page', type: 'task-page', sessionId: 'session', title: 'Actual page', size: { width: 640, height: 480 } };
let conversation: LiveWindowConversation | undefined;
afterEach(() => { conversation?.dispose(); conversation = undefined; document.body.replaceChildren(); });
function setup() {
  let emit: (watch: string, packet: ProjectionHostPacket) => void = () => {};
  let watch = '';
  const unwatch = vi.fn(async () => {}), report = vi.fn(), send = vi.fn(async () => {});
  const watched = vi.fn(async (args: { watchId: string }) => { watch = args.watchId; });
  const transport: LiveWindowTransport = {
    list: vi.fn(async () => [source]), observe: vi.fn(async () => () => {}),
    picture: () => ({ projection: {
      create: vi.fn(), publish: vi.fn(), close: vi.fn(), closed: vi.fn(), inputResult: vi.fn(), send, unwatch,
      watch: watched,
    }, onProjection: next => { emit = next; return () => { emit = () => {}; }; } }),
  };
  conversation = new LiveWindowConversation(context, 'desktop', transport, report);
  const current = conversation;
  const paint = async (sequence: number) => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    canvas.getContext('2d')!.fillRect(0, 0, sequence, sequence);
    emit(watch, { type: 'state', state: 'connecting', generation: 'g' });
    emit(watch, { type: 'frame', generation: 'g', frame: { sequence, width: 640, height: 480, mime: 'image/png', data: canvas.toDataURL().split(',')[1]! } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ packet: expect.objectContaining({ type: 'ack', frame: sequence }) })));
  };
  return { current, transport, paint, unwatch, report, watched };
}

describe('live conversation picture lifetime', () => {
  it('ends picture watches on true close and uses a fresh watch when the tool row reopens it', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    await s.paint(1); const first = s.watched.mock.calls[0]![0].watchId;
    s.current.model.dispatch({ type: 'close' });
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    expect(s.current.model.getSnapshot().visible).toBe(false);
    s.current.model.dispatch({ type: 'show-from-tool', kind: 'browser' });
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(2));
    expect(s.watched.mock.calls[1]![0].watchId).not.toBe(first);
    expect(s.report).not.toHaveBeenCalled();
  });
  it('retains the last decoded frame after the real turn ends and disposes it with the conversation', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.current.picture('page')?.querySelector('img') ?? null).not.toBeNull());
    document.body.append(s.current.picture('page')!); await s.paint(1);
    const image = s.current.picture('page')!.querySelector('img')!;
    const last = image.src;
    s.current.setOperating(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalled());
    expect(s.current.model.getSnapshot()).toMatchObject({ operating: false, visible: true });
    expect(image.src).toBe(last); expect(image.isConnected).toBe(true);
    expect(s.current.picture('page')!.querySelector('textarea')!.disabled).toBe(true);
    s.current.dispose(); expect(image.isConnected).toBe(false); expect(s.report).not.toHaveBeenCalled();
  });
  it('does not let a delayed read from the previous visibility overwrite a newly opened conversation', async () => {
    const s = setup(); const first = Promise.withResolvers<readonly LiveWindowResourceDescriptor[]>();
    vi.mocked(s.transport.list).mockImplementationOnce(() => first.promise);
    s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.transport.list).toHaveBeenCalledTimes(1));
    s.current.setVisible('chat', false); s.current.setVisible('chat', true);
    await Promise.resolve(); first.resolve([]);
    await vi.waitFor(() => expect(s.transport.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(s.current.model.getSnapshot().sources.map(item => item.id)).toEqual(['page']));
    expect(s.report).not.toHaveBeenCalled();
  });
  it('never enumerates pictures for a group conversation', async () => {
    const s = setup(); s.current.dispose();
    conversation = new LiveWindowConversation({ ...context, privateAgentChat: false }, 'desktop', s.transport, s.report);
    conversation.setOperating(true); conversation.setVisible('group', true); await conversation.refresh();
    expect(s.transport.list).not.toHaveBeenCalled(); expect(s.transport.observe).not.toHaveBeenCalled();
    expect(conversation.model.getSnapshot().visible).toBe(false);
  });
});
