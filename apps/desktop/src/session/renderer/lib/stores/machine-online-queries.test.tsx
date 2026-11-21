// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #137 新建框问的这几样(名单、目录、凭据)都在选着的那台机器上:没连上就不问,连上了自己去取;
// 不问的时候 ❌ 报「正在读取」—— 那一格会一直转到机器回来,而原因由机器的提示说。
const mocks = vi.hoisted(() => ({
  host: { remote: { deviceId: 'mac-1', online: false } as { deviceId: string; online: boolean } },
  list: vi.fn(),
  modelCatalog: vi.fn(),
  modelCredential: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {},
  rpcOn: () => ({ agents: { list: mocks.list, modelCatalog: mocks.modelCatalog } }),
}));
vi.mock('@renderer/features/library/library-host', () => ({ LOCAL_HOST_KEY: 'local', useLibraryHost: () => mocks.host }));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({ modelCredential: mocks.modelCredential }),
}));
vi.mock('./use-agent-auth-status', () => ({ useAgentAuthStatus: () => ({ auth: null }) }));

import { followRendererSession, queryClient as client } from '@/lib/replica';
import { useAgents } from './use-agents';
import { useHarnessModelCatalog } from './use-harness-model-catalog';
import { useHarnessModelCredential } from './use-harness-model-credential';

let seen: { agents: unknown; awaited: boolean; catalog: string; credential: string | null } | null = null;
function Probe() {
  const agents = useAgents();
  const catalog = useHarnessModelCatalog('claude', 'acp');
  const credential = useHarnessModelCredential('claude', 'opus');
  // What the new-task box holds a place for (initial-session-section `agentOptionsLoading`).
  seen = { agents, awaited: agents.state !== 'error' && mocks.host.remote.online, catalog: catalog.state.kind, credential };
  return null;
}

let root: Root;
let container: HTMLDivElement;
// react-query 把结果推给组件排在下一个 setTimeout 里
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render(online: boolean) {
  mocks.host.remote = { deviceId: 'mac-1', online };
  await act(async () => {
    root.render(<Probe />);
  });
  await settle();
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.modelCatalog.mockReset();
  mocks.modelCredential.mockReset();
  client.clear();
  followRendererSession('SIGNED_IN', 'account-1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe('新建框跟着那台机器连没连上去问', () => {
  // The composer does not hold a place for a machine not connected (initial-session-section `agentOptionsLoading`).
  it('没连上:三样都不问,读数停在未知', async () => {
    await render(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.modelCatalog).not.toHaveBeenCalled();
    expect(mocks.modelCredential).not.toHaveBeenCalled();
    expect(seen?.agents).toEqual({ state: 'unknown' });
    // Unknown, but not asked: ❌ 「正在读取」.
    expect(seen?.awaited).toBe(false);
  });

  it('连上那一刻:自己去取,取的时候说「正在读取」,取到就是那台机器的', async () => {
    await render(false);
    let answer: (agents: unknown[]) => void = () => {};
    mocks.list.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mocks.modelCatalog.mockResolvedValue({ state: { kind: 'unsupported' }, refreshing: false });
    mocks.modelCredential.mockResolvedValue({ success: true, data: 'credentialed' });
    await render(true);
    expect(seen?.agents).toEqual({ state: 'unknown' });
    expect(seen?.awaited).toBe(true);
    await act(async () => answer([{ id: 'claude' }]));
    await settle();
    expect(seen?.agents).toMatchObject({ state: 'value', value: [{ id: 'claude' }] });
    expect(seen?.catalog).toBe('unsupported');
    expect(seen?.credential).toBe('credentialed');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.modelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.modelCredential).toHaveBeenCalledTimes(1);
  });
});
