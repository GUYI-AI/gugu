import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createServerTaskBrowser, PipeConnection } from '../../../../server/server-task-browser';
import { TaskPageClosedDuringOpen, TaskPopupClosed } from '../../../../server/task-popups';
import { StandaloneBrowserPool } from './standalone-browser-pool';

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }));

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };

function fakeChrome(hold: (command: Command) => boolean) {
  const write = new PassThrough();
  const read = new PassThrough();
  const connection = new PipeConnection(write, read);
  const commands: Command[] = [];
  const deliver = (...messages: object[]) => { read.write(messages.map(message => JSON.stringify(message) + '\0').join('')); };
  const reply = (command: Command, result: unknown = {}) => deliver({ id: command.id, result });
  const child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null as number | null, signalCode: null, kill: vi.fn(() => true),
  });
  let nextTarget = 0;
  write.on('data', (data: Buffer) => {
    const command = JSON.parse(data.toString().slice(0, -1)) as Command;
    commands.push(command);
    if (hold(command)) return;
    let result: object = {};
    if (command.method === 'Target.createTarget') result = { targetId: `T${++nextTarget}` };
    if (command.method === 'Target.attachToTarget') result = { sessionId: `watch-${command.params.targetId}` };
    if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main', url: 'about:blank' } } };
    if (command.method === 'Page.getNavigationHistory') result = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
    queueMicrotask(() => reply(command, result));
  });
  return {
    child, commands, deliver, reply, connection,
    spawn: () => ({ process: child as unknown as ChildProcess, connection }),
    exit() {
      child.exitCode = 0;
      connection.fail(new Error('fake Chrome exited'));
      child.emit('exit', 0, null);
    },
  };
}

function fixture(hold: (command: Command) => boolean) {
  const chromes: ReturnType<typeof fakeChrome>[] = [];
  const pool = new StandaloneBrowserPool({
    profilesRoot: '/unused',
    installation: async () => ({
      schema: 'gugu-standalone-browser/1', platform: 'darwin-arm64', version: '158', executable: '/unused', sha256: 'fake', downloadBytes: 1, installedBytes: 1,
    }),
    create: ({ profile }) => {
      const chrome = fakeChrome(hold);
      chromes.push(chrome);
      return createServerTaskBrowser({
        binary: () => null, profile, reportInitialPageClose: true, spawn: chrome.spawn, log: { info: vi.fn(), warn: vi.fn() },
      });
    },
  });
  const open = (browserId: string, url?: string, popup?: string) => pool.pageFor({
    partition: 'persist:gugu-browser-profile-proof', browserId, url, popup, signal: new AbortController().signal,
  });
  return { chromes, open, close: (id: string) => pool.closeTab(id) };
}

function observe(operation: Promise<unknown>) {
  let value: unknown;
  let settled = false;
  const done = operation.then(result => { value = result; }, error => { value = error; }).then(() => { settled = true; });
  return { done, value: () => value, settled: () => settled };
}

describe('Standalone Chrome lifecycle over the real pipe adapter', () => {
  it.each([
    { popup: undefined, targetId: 'T2', closedError: TaskPageClosedDuringOpen, urlUses: 1 },
    { popup: 'popup', targetId: 'popup', closedError: TaskPopupClosed, urlUses: 0 },
  ])('settles an attaching tab when target $targetId closes without replying', async ({ popup, targetId, closedError, urlUses }) => {
    const f = fixture(call => (call.sessionId === `watch-${targetId}` && call.method === 'Page.enable') || call.method === 'Runtime.evaluate' || call.method === 'Browser.getVersion');
    const opener = await f.open('opener');
    const chrome = f.chromes[0];
    const url = 'https://one-time.test/once';
    if (popup) {
      opener.reportNewWindows?.();
      chrome.deliver({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId, openerId: 'T1', url } } });
    }
    const attaching = observe(f.open('self-closing', url, popup));
    const nextPage = observe(f.open('next'));
    await turn();
    expect(chrome.commands).toContainEqual(expect.objectContaining({ method: 'Page.enable', sessionId: `watch-${targetId}` }));
    chrome.deliver({ method: 'Target.attachedToTarget', params: { sessionId: 'other-session-on-closed-page', targetInfo: { targetId } } });
    const closedSession = observe(chrome.connection.send('Runtime.evaluate', {}, 'other-session-on-closed-page'));
    const liveSession = observe(chrome.connection.send('Runtime.evaluate', {}, 'watch-T1'));
    const browserRequest = observe(chrome.connection.send('Browser.getVersion'));
    chrome.deliver({ method: 'Target.targetDestroyed', params: { targetId } });
    await turn();

    expect(attaching.settled()).toBe(true);
    expect(attaching.value()).toBeInstanceOf(closedError);
    expect(closedSession.value()).toBeInstanceOf(Error);
    expect(opener.isDestroyed()).toBe(false);
    expect(nextPage.settled()).toBe(true);
    expect(nextPage.value()).not.toBeInstanceOf(Error);
    expect(f.chromes).toHaveLength(1);
    expect(chrome.commands.filter(call => call.method === 'Target.createTarget' && call.params.url === url)).toHaveLength(urlUses);
    expect(liveSession.settled()).toBe(false);
    expect(browserRequest.settled()).toBe(false);
    chrome.reply(chrome.commands.find(call => call.sessionId === 'watch-T1' && call.method === 'Runtime.evaluate')!, { alive: true });
    chrome.reply(chrome.commands.find(call => call.method === 'Browser.getVersion')!, { alive: true });
    await Promise.all([liveSession.done, browserRequest.done]);
    expect(liveSession.value()).toEqual({ alive: true });
    expect(browserRequest.value()).toEqual({ alive: true });
    chrome.exit();
  });

  it.each([
    { method: 'Target.createTarget', nextMethod: 'Target.attachToTarget', blockedTarget: 'immediate', result: { targetId: 'immediate' } },
    { method: 'Target.attachToTarget', nextMethod: 'Page.enable', blockedTarget: 'T2', result: { sessionId: 'watch-T2' } },
  ])('does not continue attachment or replay the URL after $method replies with a close in the same read', async ({ method, nextMethod, blockedTarget, result }) => {
    const url = 'https://one-time.test/immediate';
    const f = fixture(call => call.method === method && (call.params.url === url || call.params.targetId === blockedTarget));
    await f.open('opener');
    const chrome = f.chromes[0];
    const opening = observe(f.open('self-closing', url));
    await turn();
    const blocked = chrome.commands.find(call => call.method === method && (call.params.url === url || call.params.targetId === blockedTarget))!;
    chrome.deliver(
      { id: blocked.id, result },
      { method: 'Target.targetDestroyed', params: { targetId: blockedTarget } },
    );
    await opening.done;
    expect(opening.value()).toBeInstanceOf(TaskPageClosedDuringOpen);
    expect(chrome.commands.some(call => call.method === nextMethod && (call.params.targetId === blockedTarget || call.sessionId === `watch-${blockedTarget}`))).toBe(false);
    expect(chrome.commands.filter(call => call.method === 'Target.createTarget' && call.params.url === url)).toHaveLength(1);
    expect((await f.open('next')).isDestroyed()).toBe(false);
    chrome.exit();
  });

  it('covers an unacknowledged Browser.close with the watchdog and waits for process exit before reusing the profile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let armedAtClose = false;
      const f = fixture(call => {
        if (call.method !== 'Browser.close') return false;
        armedAtClose = vi.getTimerCount() > 0;
        return true;
      });
      await f.open('last');
      const chrome = f.chromes[0];
      const closing = observe(f.close('last'));
      const nextPage = observe(f.open('next'));
      await turn();

      expect(armedAtClose).toBe(true);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(chrome.child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(chrome.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      chrome.connection.fail(new Error('pipe closed before child exit'));
      await turn();
      expect(closing.settled()).toBe(false);
      expect(nextPage.settled()).toBe(false);
      expect(f.chromes).toHaveLength(1);

      chrome.exit();
      await Promise.all([closing.done, nextPage.done]);
      expect(closing.value()).toBeUndefined();
      expect(nextPage.value()).not.toBeInstanceOf(Error);
      expect(f.chromes).toHaveLength(2);
      f.chromes[1].exit();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the watchdog for a normal exit before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = fixture(() => false);
      await f.open('last');
      const closing = observe(f.close('last'));
      await turn();
      const chrome = f.chromes[0];
      expect(chrome.commands).toContainEqual(expect.objectContaining({ method: 'Browser.close' }));
      expect(closing.settled()).toBe(false);
      chrome.exit();
      await closing.done;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(closing.value()).toBeUndefined();
      expect(chrome.child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a detached session without closing the live target or disturbing its other session', async () => {
    const f = fixture(call => call.method === 'Runtime.evaluate');
    const page = await f.open('page');
    const chrome = f.chromes[0];
    chrome.deliver({ method: 'Target.attachedToTarget', params: { sessionId: 'secondary', targetInfo: { targetId: 'T1' } } });
    const waiting = observe(chrome.connection.send('Runtime.evaluate', {}, 'secondary'));
    const primary = observe(chrome.connection.send('Runtime.evaluate', {}, 'watch-T1'));
    chrome.deliver({ method: 'Target.detachedFromTarget', params: { sessionId: 'secondary' } });
    await waiting.done;
    expect(waiting.value()).toBeInstanceOf(Error);
    await expect(chrome.connection.send('Runtime.evaluate', {}, 'secondary')).rejects.toThrow('Session with given id not found');
    expect(chrome.commands.filter(call => call.sessionId === 'secondary')).toHaveLength(1);
    expect(page.isDestroyed()).toBe(false);
    expect(primary.settled()).toBe(false);
    chrome.reply(chrome.commands.find(call => call.sessionId === 'watch-T1' && call.method === 'Runtime.evaluate')!, { alive: true });
    await primary.done;
    expect(primary.value()).toEqual({ alive: true });
    chrome.exit();
  });
});
