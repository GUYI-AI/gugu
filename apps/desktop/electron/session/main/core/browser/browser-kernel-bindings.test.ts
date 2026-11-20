import { describe, expect, it } from 'vitest';
import { BrowserKernelBindings } from './browser-kernel-bindings';

describe('browser engine lifetime', () => {
  it('closes a tab whose asynchronous registration was still in flight', async () => {
    const tabs = new BrowserKernelBindings();
    let release!: () => void;
    const reading = new Promise<void>(done => { release = done; });
    const registration = tabs.run('tab', async () => {
      await reading;
      tabs.bind({ browserId: 'tab', partition: 'persist:gugu-browser-profile-shared' }, 'standalone');
    });
    const closing = tabs.run('tab', async () => { tabs.delete('tab'); });
    release();
    await Promise.all([registration, closing]);
    expect(tabs.get('tab')).toBeUndefined();
  });
  it('keeps existing pages on their engine when the default changes, including after profile changes', () => {
    const tabs = new BrowserKernelBindings();
    const old = { browserId: 'old', partition: 'persist:browser:default', sessionId: 'task' };
    expect(tabs.bind(old, 'builtin').kernel).toBe('builtin');
    expect(tabs.bind(old, 'standalone').kernel).toBe('builtin');
    expect(tabs.bind({ ...old, partition: 'persist:browser:other' }, 'standalone').kernel).toBe('builtin');
    expect(tabs.bind({ ...old, browserId: 'new' }, 'standalone').kernel).toBe('standalone');
    expect(tabs.bind({ ...old, browserId: 'new' }, 'builtin').kernel).toBe('standalone');
  });

  it('never transfers a browser identity into another Agent conversation', () => {
    const tabs = new BrowserKernelBindings();
    tabs.bind({ browserId: 'tab', partition: 'persist:browser:default', sessionId: 'one' }, 'standalone');
    expect(() => tabs.bind({ browserId: 'tab', partition: 'persist:browser:default', sessionId: 'two' }, 'builtin')).toThrow('another conversation');
    expect(tabs.forSession('two')).toEqual([]);
    expect(tabs.forSession('one')).toHaveLength(1);
  });

  it('keeps chat ownership separate from Agent session ownership, including equal raw ids', () => {
    const tabs = new BrowserKernelBindings();
    const input = { browserId: 'chat-tab', partition: 'persist:browser:default' };
    tabs.bind({ ...input, conversation: { kind: 'chat', chatId: 'one' } }, 'standalone');
    expect(tabs.belongsTo(input.browserId, { kind: 'chat', chatId: 'one' })).toBe(true);
    expect(tabs.belongsTo(input.browserId, { kind: 'session', sessionId: 'one' })).toBe(false);
    expect(tabs.forSession('one')).toEqual([]);
    expect(() => tabs.bind({ ...input, conversation: { kind: 'chat', chatId: 'two' } }, 'standalone')).toThrow('another conversation');
    expect(() => tabs.assertOwner({ ...input, sessionId: 'one' })).toThrow('another conversation');
    tabs.bind({ ...input, browserId: 'session-tab', conversation: { kind: 'session', sessionId: 'one' } }, 'builtin');
    expect(tabs.forSession('one').map(tab => tab.browserId)).toEqual(['session-tab']);
  });

  it('releases a closed identity before a new tab chooses its own engine', () => {
    const tabs = new BrowserKernelBindings();
    tabs.bind({ browserId: 'tab', partition: 'persist:browser:default' }, 'builtin');
    tabs.delete('tab');
    expect(tabs.bind({ browserId: 'tab', partition: 'persist:browser:default' }, 'standalone').kernel).toBe('standalone');
  });
});
