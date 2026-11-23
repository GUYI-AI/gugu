// #6264 一套工作台:别的机器上的会话,也要知道它背后是哪个 agent。
// 表只在启动那一刻读一次时,d22 的会话还没到。现在别的机器上的那一半读会话目录(行上带 agent id):
// 目录到了 / 变了、身份缓存补到了,都再收一遍;❌ 逐台机器去问(#7016:掉线又回来的那台会卡到超时)。
import { describe, expect, it, vi } from 'vitest';
import type { SessionShellAgentName } from '@shared/lib/ipc/shell-port';
import { SessionAgentBindings, type SessionAgentBindingsSource } from './session-agent-bindings';

const LOCAL: SessionShellAgentName = { conversationId: 'conv-local-1', displayName: 'Claude 3', agentUserId: 'agent-local-uuid' };
const REMOTE: SessionShellAgentName = { conversationId: 'conv-d22-1', displayName: 'Codex 8', agentUserId: 'agent-d22-uuid' };

function fakeSource(options: { all?: SessionShellAgentName[]; remote?: SessionShellAgentName[] } = {}) {
  let accountListener: (() => void) | null = null;
  let identityListener: ((event: SessionShellAgentName) => void) | null = null;
  let remoteListener: (() => void) | null = null;
  let directoryListener: (() => void) | null = null;
  let remote = options.remote ?? [];
  const source: SessionAgentBindingsSource = {
    readAll: vi.fn(() => Promise.resolve(options.all ?? [])),
    readRemote: () => remote,
    onRemoteChange: (cb) => {
      remoteListener = cb;
      return () => (remoteListener = null);
    },
    onIdentityEvent: (cb) => {
      identityListener = cb;
      return () => (identityListener = null);
    },
    directory: () => ({
      getSnapshot: () => null,
      subscribe: (cb) => {
        directoryListener = cb;
        return () => (directoryListener = null);
      },
      ensure: () => undefined,
    }),
    onAccountChange: (cb) => {
      accountListener = cb;
      return () => (accountListener = null);
    },
  };
  return {
    source,
    /** 换了登录的人(本机那一份从此按新的人答)。 */
    switchAccount: (all: SessionShellAgentName[]) => {
      options.all = all;
      accountListener?.();
    },
    push: (event: SessionShellAgentName) => identityListener?.(event),
    /** 会话目录变了(那台机器的列表到了)。 */
    directoryChanged: (rows: SessionShellAgentName[]) => {
      remote = rows;
      remoteListener?.();
    },
    /** 身份缓存补到了名字(目录行早就在,名字这时才有)。 */
    identitiesArrived: (rows: SessionShellAgentName[]) => {
      remote = rows;
      directoryListener?.();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sessionAgentBindings 覆盖别的机器上的会话 (#6264)', () => {
  it('那台机器的会话列表到了 ⇒ 从会话目录收进来,远端会话的身份卡有名字与 ID', async () => {
    const fake = fakeSource({ all: [LOCAL] });
    const names = new SessionAgentBindings(fake.source);
    names.start();
    await settle();
    expect(names.bindingFor(REMOTE.conversationId)).toBeUndefined();

    fake.directoryChanged([REMOTE]);
    expect(names.bindingFor(REMOTE.conversationId)).toEqual({ agentUserId: 'agent-d22-uuid' });
    expect(names.bindingFor(LOCAL.conversationId)).toEqual({ agentUserId: 'agent-local-uuid' });
  });

  it('目录里早就有、开起来就有的那几条:启动当场收进来', () => {
    const fake = fakeSource({ remote: [REMOTE] });
    const names = new SessionAgentBindings(fake.source);
    names.start();
    expect(names.bindingFor(REMOTE.conversationId)?.agentUserId).toBe('agent-d22-uuid');
  });

  it('目录行在、名字后到(身份缓存补取回来):补到就收', () => {
    const fake = fakeSource();
    const names = new SessionAgentBindings(fake.source);
    names.start();
    expect(names.bindingFor(REMOTE.conversationId)).toBeUndefined();
    fake.identitiesArrived([REMOTE]);
    expect(names.bindingFor(REMOTE.conversationId)?.agentUserId).toBe('agent-d22-uuid');
  });

  it('那台机器推来的开户事件落表(与本机同一条认领);缺 id 不入表', async () => {
    const fake = fakeSource();
    const names = new SessionAgentBindings(fake.source);
    names.start();
    fake.push({ conversationId: REMOTE.conversationId, displayName: 'Codex 8', agentUserId: REMOTE.agentUserId });
    expect(names.bindingFor(REMOTE.conversationId)).toEqual({ agentUserId: REMOTE.agentUserId });
    fake.push({ conversationId: 'conv-x', displayName: 'x', agentUserId: '' });
    expect(names.bindingFor('conv-x')).toBeUndefined();
  });

  it('start 幂等:再调一次不重订阅', () => {
    const fake = fakeSource();
    const onRemote = vi.spyOn(fake.source, 'onRemoteChange');
    const names = new SessionAgentBindings(fake.source);
    names.start();
    names.start();
    expect(onRemote).toHaveBeenCalledTimes(1);
  });
});

// Sign-out returns to the login page in place: the next person's sidebar reads this machine's table as that person,
// the same table a restart would read. A binding the previous person's run noted must not hide a task from the next.
describe('sessionAgentBindings across a sign-out in place', () => {
  it('the previous account\'s bindings are forgotten and the next start reads the table again', async () => {
    const fake = fakeSource({ all: [] });
    const names = new SessionAgentBindings(fake.source);
    names.start();
    await settle();
    fake.push(LOCAL);
    expect(names.bindingFor(LOCAL.conversationId)?.agentUserId).toBe(LOCAL.agentUserId);

    fake.switchAccount([]);
    expect(names.bindingFor(LOCAL.conversationId)).toBeUndefined();
    expect(names.isLoaded).toBe(false);

    names.start();
    await settle();
    expect(fake.source.readAll).toHaveBeenCalledTimes(2);
    expect(names.isLoaded).toBe(true);
    expect(names.bindingFor(LOCAL.conversationId)).toBeUndefined();
  });

  it('a read that comes back after the account changed does not land', async () => {
    const fake = fakeSource({ all: [LOCAL] });
    const names = new SessionAgentBindings(fake.source);
    names.start();
    fake.switchAccount([]);
    await settle();

    expect(names.bindingFor(LOCAL.conversationId)).toBeUndefined();
    expect(names.isLoaded).toBe(false);
  });

  it('start stays idempotent for one account: no second read', async () => {
    const fake = fakeSource({ all: [LOCAL] });
    const names = new SessionAgentBindings(fake.source);
    names.start();
    names.start();
    await settle();
    expect(fake.source.readAll).toHaveBeenCalledTimes(1);
  });
});
