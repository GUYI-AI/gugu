import { describe, expect, it } from 'vitest';
import { LiveWindowModel } from './model';
import type { LiveWindowContext, LiveWindowSource } from './types';

const chat: LiveWindowContext = { conversationId: 'private', deviceId: 'host', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true };
const picture = (kind: 'browser' | 'computer', activity: number, status: 'operating' | 'finished' = 'operating'): LiveWindowSource => ({
  id: kind, kind, activity, deviceId: 'host', sessionId: 'task', agentId: 'agent', title: kind,
  size: { width: 1280, height: 900 }, status,
});

describe.each(['desktop', 'phone'] as const)('%s header viewing', platform => {
  it('opens once and keeps its icon after hiding, including later sources and turns', () => {
    const model = new LiveWindowModel(platform); model.activate(chat);
    model.observe(chat, [picture('browser', 1)]);
    expect(model.getSnapshot().visible).toBe(true);
    model.dispatch({ type: 'toggle-window' });
    expect(model.getSnapshot()).toMatchObject({ visible: false, headerSource: { kind: 'browser' } });
    model.observe(chat, [picture('browser', 1, 'finished')]);
    model.observe(chat, [picture('browser', 2), picture('computer', 3)]);
    expect(model.getSnapshot()).toMatchObject({ visible: false, headerSource: { kind: 'computer' } });
    model.dispatch({ type: 'toggle-window' });
    expect(model.getSnapshot()).toMatchObject({ visible: true, source: { kind: 'computer' } });
  });
  it('keeps a completed frame but removes resources that the host actually closed', () => {
    const model = new LiveWindowModel(platform); model.activate(chat);
    model.observe(chat, [picture('browser', 1), picture('computer', 2)]);
    model.observe(chat, [picture('browser', 1, 'finished'), picture('computer', 2, 'finished')]);
    expect(model.getSnapshot()).toMatchObject({ visible: true, operating: false, headerSource: { kind: 'computer' } });
    model.observe(chat, [picture('browser', 1, 'finished')]);
    expect(model.getSnapshot().sources.map(source => source.kind)).toEqual(['browser']);
    model.observe(chat, []);
    expect(model.getSnapshot()).toMatchObject({ visible: false, headerSource: null });
    model.observe(chat, [picture('browser', 4)]);
    expect(model.getSnapshot().visible).toBe(false);
  });
  it('keeps Browser before Computer even when Computer is discovered first', () => {
    const model = new LiveWindowModel(platform); model.activate(chat);
    model.observe(chat, [picture('computer', 1)]);
    model.observe(chat, [picture('computer', 1), picture('browser', 2)]);
    expect(model.getSnapshot().sources.map(source => source.kind)).toEqual(['browser', 'computer']);
    expect(model.getSnapshot().source?.kind).toBe('browser');
  });
  it('does not expose the icon in groups, topics or another conversation', () => {
    const model = new LiveWindowModel(platform); model.activate(chat); model.observe(chat, [picture('browser', 1)]);
    for (const conversationId of ['group', 'topic']) {
      const other = { ...chat, conversationId, privateAgentChat: false };
      model.activate(other); model.observe(other, [picture('browser', 1)]);
      expect(model.getSnapshot()).toMatchObject({ visible: false, headerSource: null });
    }
    model.activate({ ...chat, conversationId: 'other', sessionId: 'other' });
    expect(model.getSnapshot().headerSource).toBeNull();
    model.activate(chat);
    expect(model.getSnapshot()).toMatchObject({ visible: true, headerSource: { kind: 'browser' } });
  });
});
