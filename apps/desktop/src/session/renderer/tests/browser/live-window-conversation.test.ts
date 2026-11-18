import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveWindowConversation } from '../../features/live-window/conversation';
import type { LiveWindowTransport } from '../../features/live-window/transport';
import type { LiveWindowResourceDescriptor } from '@shared/extensions/live-window-protocol';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';

const context = { conversationId: 'chat', deviceId: 'device', sessionId: 'session', agentId: 'agent', privateAgentChat: true, shown: true };
const source: LiveWindowResourceDescriptor = { id: 'page', type: 'task-page', sessionId: 'session', title: 'Actual page', size: { width: 640, height: 480 } };
let conversation: LiveWindowConversation | undefined;
afterEach(() => { conversation?.dispose(); conversation = undefined; document.body.replaceChildren(); });
function setup(descriptor: LiveWindowResourceDescriptor = source) {
  let emit: (watch: string, packet: ProjectionHostPacket) => void = () => {};
  let watch = '';
  const unwatch = vi.fn(async () => {}), report = vi.fn(), send = vi.fn(async () => {});
  const watched = vi.fn(async (args: { watchId: string }) => { watch = args.watchId; });
  const transport: LiveWindowTransport = {
    list: vi.fn(async () => [descriptor]), observe: vi.fn(async () => () => {}),
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
  return { current, transport, paint, unwatch, report, watched,
    end: () => emit(watch, { type: 'state', generation: 'g', state: 'closed', reason: 'The browser closed' }) };
}

describe('live conversation picture lifetime', () => {
  it('retains the decoded frame offline and removes it only on a successful host close read', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    const picture = s.current.picture('page')!; document.body.append(picture); await s.paint(1);
    const last = picture.querySelector('img')!.src;
    s.current.setConnected(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    expect(s.current.model.getSnapshot()).toMatchObject({ connected: false, operating: false, visible: true, headerSource: { id: 'page' } });
    expect(picture.querySelector('img')!.src).toBe(last);
    vi.mocked(s.transport.list).mockResolvedValue([]);
    await s.current.refresh();
    expect(s.current.picture('page')).toBe(picture);
    s.current.setConnected(true); await s.current.refresh();
    expect(s.current.model.getSnapshot()).toMatchObject({ headerSource: null, visible: false, sources: [] });
    expect(s.current.picture('page')).toBeNull();
  });
  it('ends picture watches on true close and uses a fresh watch when the tool row reopens it', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    await s.paint(1); const first = s.watched.mock.calls[0]![0].watchId;
    s.current.model.dispatch({ type: 'close' });
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    expect(s.current.model.getSnapshot().visible).toBe(false);
    await s.current.refresh();
    s.current.setOperating(false); s.current.setOperating(true); await s.current.refresh();
    expect(s.watched).toHaveBeenCalledTimes(1);
    expect(s.current.model.getSnapshot().visible).toBe(false);
    s.current.model.dispatch({ type: 'show-from-tool', kind: 'browser' });
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(2));
    expect(s.watched.mock.calls[1]![0].watchId).not.toBe(first);
    expect(s.report).not.toHaveBeenCalled();
  });
  it('hides the desktop window and clears its running state when the real turn ends', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.current.picture('page')?.querySelector('img') ?? null).not.toBeNull());
    document.body.append(s.current.picture('page')!); await s.paint(1);
    const image = s.current.picture('page')!.querySelector('img')!;
    const last = image.src;
    s.current.setOperating(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalled());
    expect(s.current.model.getSnapshot()).toMatchObject({ operating: false, visible: false, presentation: { mode: 'closed' } });
    expect(image.src).toBe(last); expect(image.isConnected).toBe(true);
    expect(s.current.picture('page')!.querySelector('textarea')!.disabled).toBe(true);
    s.current.dispose(); expect(image.isConnected).toBe(false); expect(s.report).not.toHaveBeenCalled();
  });
  it('keeps the last Computer frame when a resumed watch ends before painting and the picture moves into a tab', async () => {
    const s = setup({ ...source, type: 'app-projection', appId: 'computer-use', appVersion: '0.5.1' });
    s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    const picture = s.current.picture('page')!; document.body.append(picture);
    await s.paint(1); const last = picture.querySelector('img')!.src;
    s.current.setOperating(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    s.current.setOperating(true);
    s.current.model.dispatch({ type: 'toggle-window' });
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(2));
    s.current.setOperating(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(2));
    s.current.model.dispatch({ type: 'toggle-window' });
    s.current.model.dispatch({ type: 'enlarge' }); s.current.model.dispatch({ type: 'show-tab' });
    expect(s.current.model.getSnapshot().presentation?.mode).toBe('tabbed');
    const tab = document.createElement('div'); document.body.append(tab); tab.append(picture);
    expect(picture.querySelector('img')!.src === last).toBe(true);
    expect(picture.querySelectorAll('img')).toHaveLength(1);
    expect(picture.querySelector('textarea')!.disabled).toBe(true);
    expect(s.report).not.toHaveBeenCalled();
  });
  it('replaces a frozen Computer picture only when the resumed watch has painted its new frame', async () => {
    const s = setup({ ...source, type: 'app-projection', appId: 'computer-use', appVersion: '0.5.1' });
    s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    const picture = s.current.picture('page')!; document.body.append(picture);
    await s.paint(1); const last = picture.querySelector('img')!.src;
    s.current.setOperating(false);
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    s.current.setOperating(true);
    s.current.model.dispatch({ type: 'toggle-window' });
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(2));
    expect(picture.querySelector('img')!.src === last).toBe(true);
    await s.paint(2);
    expect(picture.querySelectorAll('img')).toHaveLength(1);
    expect(picture.querySelector('img')!.src === last).toBe(false);
    expect(s.report).not.toHaveBeenCalled();
  });
  it('stops only the closed source watch when the other desktop screen tab remains open', async () => {
    const s = setup();
    vi.mocked(s.transport.list).mockResolvedValue([source, { ...source, id: 'computer', type: 'app-projection', appId: 'computer-use', appVersion: '0.5.1' }]);
    s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(2));
    s.current.model.dispatch({ type: 'show-tab' });
    s.current.model.dispatch({ type: 'close-tab', sourceId: 'page' });
    await vi.waitFor(() => expect(s.unwatch).toHaveBeenCalledTimes(1));
    expect(s.current.model.getSnapshot().sources.map(item => item.id)).toEqual(['computer']);
    await s.current.refresh();
    expect(s.watched).toHaveBeenCalledTimes(2);
    s.current.model.dispatch({ type: 'show-from-tool', kind: 'browser' });
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(3));
    expect(s.report).not.toHaveBeenCalled();
  });
  it('reconciles a closed browser stream before the surrounding agent turn ends', async () => {
    const s = setup(); s.current.setOperating(true); s.current.setVisible('chat', true);
    await vi.waitFor(() => expect(s.watched).toHaveBeenCalledTimes(1));
    await s.paint(1);
    vi.mocked(s.transport.list).mockResolvedValue([]);
    s.end();
    await vi.waitFor(() => expect(s.current.model.getSnapshot()).toMatchObject({ visible: false, operating: false, headerSource: null }));
    expect(s.current.picture('page')).toBeNull();
    expect(s.report).not.toHaveBeenCalled();
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
