import { describe, expect, it } from 'vitest';
import { LiveWindowModel } from './model';
import type { LiveWindowContext, LiveWindowSource } from './types';

const context: LiveWindowContext = { conversationId: 'chat', deviceId: 'device', sessionId: 'session', agentId: 'agent', privateAgentChat: true, shown: true };
const source = (id = 'web', kind: LiveWindowSource['kind'] = 'browser'): LiveWindowSource => ({
  id, kind, deviceId: 'device', sessionId: 'session', agentId: 'agent', title: 'Example page',
  size: { width: 960, height: 600 }, status: 'operating',
});
function opened(platform: 'desktop' | 'phone' = 'desktop') {
  const model = new LiveWindowModel(platform); model.activate(context); model.observe(context, [source()]); return model;
}

describe('approved live-window presentation', () => {
  it('requires the operating source and the matching private agent conversation', () => {
    const model = new LiveWindowModel('desktop'); model.activate(context);
    model.observe(context, [{ ...source(), sessionId: 'other' }, { ...source(), agentId: 'other' }]);
    expect(model.getSnapshot().visible).toBe(false);
    model.activate({ ...context, privateAgentChat: false });
    model.observe({ ...context, privateAgentChat: false }, [source()]);
    expect(model.getSnapshot().visible).toBe(false);
  });
  it('does not open an unseen finished picture', () => {
    const model = new LiveWindowModel('desktop'); model.activate(context);
    model.observe(context, [{ ...source(), status: 'finished' }]);
    expect(model.getSnapshot().visible).toBe(false);
  });
  it('keeps each conversation position, selected source and mode when switching away and back', () => {
    const model = opened('phone'); model.observe(context, [source(), source('desktop', 'computer')]);
    model.dispatch({ type: 'select-source', sourceId: 'desktop' });
    model.dispatch({ type: 'position', small: { corner: 'top-left', x: .1, y: .2 } });
    model.dispatch({ type: 'dock', edge: 'left', ratio: .21 });
    const before = model.getSnapshot().presentation;
    model.activate({ ...context, conversationId: 'plain', sessionId: 'other' });
    expect(model.getSnapshot().visible).toBe(false);
    model.activate(context); expect(model.getSnapshot().presentation).toEqual(before);
    model.dispatch({ type: 'undock' });
    expect(model.getSnapshot().presentation?.small).toEqual({ corner: 'top-left', x: .1, y: .2 });
  });
  it('moves a desktop small window into a background tab, and disallows closing it from the chat', () => {
    const model = opened(); model.dispatch({ type: 'close-small' });
    expect(model.getSnapshot()).toMatchObject({ visible: false, presentation: { mode: 'tabbed', selectedTab: 'chat' } });
    model.dispatch({ type: 'close-tab', sourceId: 'web' });
    expect(model.getSnapshot().presentation?.mode).toBe('tabbed');
    model.dispatch({ type: 'select-tab', tab: 'screen', sourceId: 'web' });
    model.dispatch({ type: 'close-tab', sourceId: 'web' });
    expect(model.getSnapshot().presentation?.mode).toBe('closed');
    model.observe(context, [source()]);
    expect(model.getSnapshot().visible).toBe(false);
    model.dispatch({ type: 'show-from-tool', kind: 'browser' });
    expect(model.getSnapshot()).toMatchObject({ visible: true, presentation: { mode: 'floating' } });
  });
  it('shrinks for the conversation composer, except the desktop tab', () => {
    const model = opened(); model.dispatch({ type: 'enlarge' }); model.dispatch({ type: 'composer-focus' });
    expect(model.getSnapshot().presentation?.mode).toBe('floating');
    model.dispatch({ type: 'show-tab' }); model.dispatch({ type: 'composer-focus' });
    expect(model.getSnapshot().presentation?.mode).toBe('tabbed');
    model.dispatch({ type: 'dock', edge: 'left', ratio: .5 });
    expect(model.getSnapshot().presentation?.mode).toBe('tabbed');
  });
  it('retains the last picture after completion and never creates a takeover state', () => {
    const model = opened(); model.observe(context, []);
    expect(model.getSnapshot()).toMatchObject({ visible: true, operating: false, source: { status: 'finished' } });
    expect(model.getSnapshot().presentation?.mode).toBe('floating');
  });
  it('selects simultaneous sources without closing the other source', () => {
    const model = opened(); model.observe(context, [source(), source('desktop', 'computer')]);
    model.dispatch({ type: 'show-tab' }); model.dispatch({ type: 'select-tab', tab: 'screen', sourceId: 'desktop' });
    model.dispatch({ type: 'close-tab', sourceId: 'desktop' });
    expect(model.getSnapshot()).toMatchObject({ source: { id: 'web' }, presentation: { mode: 'tabbed' } });
  });
  it('clears all account-bound state and does not confuse equal session IDs on different devices', () => {
    const model = opened(); model.activate({ ...context, deviceId: 'other' });
    expect(model.getSnapshot().visible).toBe(false); model.activate(context); expect(model.getSnapshot().visible).toBe(true);
    model.clear(); model.activate(context); expect(model.getSnapshot().visible).toBe(false);
  });
  it('replaces a previous source of the same kind and preserves the selected screen when another tab closes', () => {
    const model = opened(); model.observe(context, [source('next'), source('desktop', 'computer')]);
    expect(model.getSnapshot().sources.map(item => item.id)).toEqual(['next', 'desktop']);
    model.dispatch({ type: 'show-tab' });
    model.dispatch({ type: 'select-tab', tab: 'screen', sourceId: 'next' });
    model.dispatch({ type: 'close-tab', sourceId: 'desktop' });
    expect(model.getSnapshot()).toMatchObject({ source: { id: 'next' }, presentation: { selectedTab: 'screen', mode: 'tabbed' } });
  });
});
