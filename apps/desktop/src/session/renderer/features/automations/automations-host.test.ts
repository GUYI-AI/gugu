import { focusManager, notifyManager } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followRendererSession, queryClient, type Reading } from '@/lib/replica';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const local = vi.hoisted(() => ({
  listAutomations: vi.fn(async () => [{ id: 'local-a' }]),
  createAutomation: vi.fn(),
  runAutomation: vi.fn(),
  listRunHeads: vi.fn(async () => ({})),
  listSessionSchedules: vi.fn(async () => [] as unknown[]),
}));
type Listener = { machine: string | null; name: string; cb: (data: unknown) => void };
const eventListeners = vi.hoisted(() => new Set<Listener>());
/** 那台机器上的同一组 `automations.*`(rpcOn(机器) 送过去)。 */
const d22 = vi.hoisted(() => ({
  listAutomations: vi.fn(async () => [{ id: 'd22-a' }]),
  createAutomation: vi.fn(async () => ({ id: 'saved' })),
  updateAutomationSettings: vi.fn(async () => ({ id: 'saved' })),
  runAutomation: vi.fn(async () => ({ id: 'saved' })),
  deleteAutomation: vi.fn(async () => ({ id: 'saved' })),
  listRunHeads: vi.fn(async () => ({ a1: { latest: { id: 'r1', status: 'done' }, next: null } })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { automations: local },
  rpcOn: (machine: string | null) => ({ automations: machine === 'd22' ? d22 : local }),
  onMachineEvent: (machine: string | null, event: { name: string }, cb: (data: unknown) => void) => {
    const listener = { machine, name: event.name, cb };
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
}));

const { AutomationsHostProvider, createMachineAutomationsHost } = await import('./automations-host');
const { useAutomations, useLatestAutomationRun } = await import('./use-automations');
const { useSessionSchedules } = await import('./use-session-schedules');

const device = { deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null };

const sessionConfig = {
  version: '1' as const,
  sessionConfig: { version: '1' as const, name: 'daily' },
  workspaceConfig: { version: '2' as const, workspace: { kind: 'repository-instance' as const, workspaceId: 'local-ws' } },
};

function emit(machine: string | null, name: string, data: unknown) {
  for (const listener of [...eventListeners]) if (listener.machine === machine && listener.name === name) listener.cb(data);
}

describe('已安排看别的机器:动作都去那台机器(#6264)', () => {
  it('建 / 改 / 立即运行 / 删:都是那台机器上同名同参的调用,本机一问不发', async () => {
    const host = createMachineAutomationsHost(device);
    await host.api.createAutomation({
      name: 'daily',
      projectId: 'p-d22',
      triggerConfig: { expr: '0 9 * * *' },
      agentConfig: { prompt: 'hi', provider: 'claude', autoApprove: true },
      sessionConfig,
    });
    await host.api.updateAutomationSettings('a1', { projectId: 'p-d22', sessionConfig });
    await host.api.runAutomation('a1');
    await host.api.deleteAutomation('a1');
    expect(d22.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-d22', sessionConfig }));
    expect(d22.updateAutomationSettings).toHaveBeenCalledWith('a1', { projectId: 'p-d22', sessionConfig });
    expect(d22.runAutomation).toHaveBeenCalledWith('a1');
    expect(d22.deleteAutomation).toHaveBeenCalledWith('a1');
    expect(local.createAutomation).not.toHaveBeenCalled();
    expect(local.runAutomation).not.toHaveBeenCalled();
  });
});

describe('已安排的读数:一台机器一份 replica,跟着页头选的那台机器(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let seen: { list?: Reading<unknown>; latest?: Reading<unknown> } = {};

  function Probe() {
    seen = { list: useAutomations().automations, latest: useLatestAutomationRun('a1') };
    return null;
  }

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(node);
    });
    await settle();
  }

  const mount = (host: Parameters<typeof AutomationsHostProvider>[0]['value'] | null) =>
    render(host ? React.createElement(AutomationsHostProvider, { value: host }, React.createElement(Probe)) : React.createElement(Probe));

  beforeEach(() => {
    vi.useFakeTimers();
    notifyManager.setScheduler((run) => run());
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    followRendererSession('SIGNED_IN', 'u1');
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    eventListeners.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('选了 d22:列表与最近一次运行读 d22 的,本机一问不发;只听 d22 推来的事件,❌ 轮询', async () => {
    await mount(createMachineAutomationsHost(device));
    expect(seen.list).toMatchObject({ state: 'value', value: [{ id: 'd22-a' }] });
    expect(seen.latest).toMatchObject({ state: 'value', value: { id: 'r1', status: 'done' } });
    expect(local.listAutomations).not.toHaveBeenCalled();
    expect(eventListeners.size).toBeGreaterThan(0);
    expect([...eventListeners].every((listener) => listener.machine === 'd22')).toBe(true);
    const before = d22.listAutomations.mock.calls.length;
    focusManager.setFocused(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(d22.listAutomations.mock.calls.length).toBe(before);
    focusManager.setFocused(undefined);
  });

  it('d22 离线:一问都不发,读数是「不知道」(❌ 空列表)', async () => {
    await mount(createMachineAutomationsHost({ ...device, online: false }));
    expect(d22.listAutomations).not.toHaveBeenCalled();
    expect(d22.listRunHeads).not.toHaveBeenCalled();
    expect(seen.list).toEqual({ state: 'unknown' });
  });

  it('本机(默认):读本机的,听本机的事件', async () => {
    await mount(null);
    expect(local.listAutomations).toHaveBeenCalled();
    expect(seen.list).toMatchObject({ state: 'value', value: [{ id: 'local-a' }] });
    expect([...eventListeners].every((listener) => listener.machine === null)).toBe(true);
  });

  it('一台机器只挂一对监听,不论几处在读;最后一个读者走了才摘', async () => {
    const many = React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(Probe), React.createElement(Probe));
    await render(many);
    expect([...eventListeners].map((listener) => listener.name).sort()).toEqual(['automation:changed', 'automation:run-changed']);
    act(() => root.unmount());
    expect(eventListeners.size).toBe(0);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  it('推来的运行直接放进「最近一次」,❌ 再问一遍;automation:changed 让列表重读', async () => {
    await mount(null);
    const headReads = local.listRunHeads.mock.calls.length;
    await act(async () => {
      emit(null, 'automation:run-changed', { automationId: 'a1', run: { id: 'r9', status: 'starting_agent' } });
    });
    await settle();
    expect(seen.latest).toMatchObject({ state: 'value', value: { id: 'r9' } });
    expect(local.listRunHeads.mock.calls.length).toBe(headReads);
    local.listAutomations.mockResolvedValueOnce([{ id: 'local-a' }, { id: 'local-b' }]);
    await act(async () => {
      emit(null, 'automation:changed', { automationId: 'local-b' });
    });
    await settle();
    expect(seen.list).toMatchObject({ state: 'value', value: [{ id: 'local-a' }, { id: 'local-b' }] });
  });

  it('没人看时漏掉的变化:监听重新挂上、手上已有值时再读一次', async () => {
    await mount(null);
    act(() => root.unmount());
    expect(eventListeners.size).toBe(0);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    const reads = local.listAutomations.mock.calls.length;
    local.listAutomations.mockResolvedValueOnce([{ id: 'local-c' }]);
    await mount(null);
    expect(local.listAutomations.mock.calls.length).toBe(reads + 1);
    expect(seen.list).toMatchObject({ state: 'value', value: [{ id: 'local-c' }] });
  });
});

describe('一条会话给自己排的定时:不知道 ≠ 没有', () => {
  let dom: JSDOM;
  let root: Root;
  let seen: Reading<readonly unknown[]> | undefined;

  function Probe({ sessionId }: { sessionId: string }) {
    seen = useSessionSchedules(null, sessionId);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    notifyManager.setScheduler((run) => run());
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    followRendererSession('SIGNED_IN', 'u1');
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    eventListeners.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('机器还没答:unknown(❌ 空列表);答了:这条会话的那几条,没有就是空', async () => {
    let answer: (value: unknown[]) => void = () => undefined;
    local.listSessionSchedules.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await act(async () => {
      root.render(React.createElement(Probe, { sessionId: 's1' }));
    });
    expect(seen).toEqual({ state: 'unknown' });
    await act(async () => {
      answer([{ id: 'x', sessionId: 's1' }]);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seen).toMatchObject({ state: 'value', value: [{ id: 'x', sessionId: 's1' }] });
    await act(async () => {
      root.render(React.createElement(Probe, { sessionId: 's2' }));
    });
    expect(seen).toMatchObject({ state: 'value', value: [] });
  });

  it('那台机器推来变化:重读(定时排上、到点、取消都经 automation:*)', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { sessionId: 's1' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    local.listSessionSchedules.mockResolvedValueOnce([{ id: 'y', sessionId: 's1' }]);
    await act(async () => {
      emit(null, 'automation:run-changed', { automationId: 'y', run: { id: 'r', status: 'scheduled' } });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seen).toMatchObject({ state: 'value', value: [{ id: 'y' }] });
  });
});
