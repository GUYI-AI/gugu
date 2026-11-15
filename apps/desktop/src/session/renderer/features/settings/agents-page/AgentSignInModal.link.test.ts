import { JSDOM } from 'jsdom';
import { observable, runInAction } from 'mobx';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';

const mocks = vi.hoisted(() => ({
  binding: null as null | {
    status: { current(): AuthStatusModelState };
    sendInput: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    markUrlHandled: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    refreshStatus: ReturnType<typeof vi.fn>;
  },
  opened: [] as string[],
  startFailure: null as Error | null,
  logged: [] as unknown[],
}));

const state = observable.box<AuthStatusModelState>({ status: { kind: 'unauthenticated' }, login: null }, { deep: false });

vi.mock('@renderer/lib/acp/auth-login-binding', () => ({
  AcpAuthLoginBinding: {
    create: async () => {
      if (mocks.startFailure) throw mocks.startFailure;
      mocks.binding = {
        status: { current: () => state.get() },
        sendInput: vi.fn(),
        resize: vi.fn(),
        markUrlHandled: vi.fn(),
        dispose: vi.fn(),
        refreshStatus: vi.fn(),
      };
      return mocks.binding;
    },
  },
}));
vi.mock('@renderer/lib/open-external-link', () => ({
  openExternalLinkInBrowser: (url: string) => mocks.opened.push(url),
  copyExternalLink: async () => true,
}));
vi.mock('./AcpAuthenticateSignIn', () => ({ AcpAuthenticateSignIn: () => null }));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgent: () => ({ data: null }) }));
vi.mock('@/components/settings/addServer/CommandBlock', () => ({ CommandBlock: () => null }));
vi.mock('@/i18n/registerSettingsCatalog', () => ({}));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: (...args: unknown[]) => mocks.logged.push(args) }) }));
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }));
// 不带 autoFocus:React 在 jsdom 里给获得焦点的输入框挂旧式 change 垫片(attachEvent),会刷一串无关报错。
vi.mock('@renderer/lib/ui/input', () => ({
  Input: ({ autoFocus: _autoFocus, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => React.createElement('input', props),
}));
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { DialogHeader: pass, DialogTitle: pass, DialogContentArea: pass, DialogFooter: pass };
});
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    translate: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));

const { AgentSignInModal } = await import('./AgentSignInModal');

const LINK = 'https://claude.ai/oauth/authorize?code=true';

function login(patch: Partial<NonNullable<AuthStatusModelState['login']>> = {}): AuthStatusModelState['login'] {
  return {
    methodId: 'login',
    startedAt: 1,
    transport: 'terminal',
    pendingUrl: { id: 'u1', url: LINK },
    userCode: null,
    awaitingInput: false,
    inputPromptCount: 0,
    exit: null,
    ...patch,
  };
}

describe('终端登录不摆终端:链接 + 等待 + 填码(#2507)', () => {
  let dom: JSDOM;
  let root: Root;
  const q = (id: string) => dom.window.document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const set = async (next: AuthStatusModelState) => {
    await act(async () => runInAction(() => state.set(next)));
  };
  const render = async (onSuccess = vi.fn()) => {
    await act(async () => {
      root.render(
        React.createElement(AgentSignInModal, {
          providerId: 'claude',
          providerName: 'Claude Code',
          steps: [{ methodId: 'login', transport: 'terminal' }],
          onSuccess,
          onClose: vi.fn(),
        })
      );
    });
    return onSuccess;
  };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    root = createRoot(dom.window.document.getElementById('root')!);
    mocks.binding = null;
    mocks.opened = [];
    mocks.startFailure = null;
    mocks.logged = [];
    runInAction(() => state.set({ status: { kind: 'unauthenticated' }, login: null }));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('没有终端;链接到了 ⇒「打开授权页」可点,打开的就是那条链接', async () => {
    await render();
    expect(dom.window.document.querySelector('.xterm')).toBeNull();
    expect(q('agent-sign-in-starting')).not.toBeNull();
    expect((q('agent-sign-in-open-page') as HTMLButtonElement).disabled).toBe(true);
    await set({ status: { kind: 'unauthenticated' }, login: login() });
    expect(q('agent-sign-in-waiting')).not.toBeNull();
    expect(mocks.binding?.markUrlHandled).toHaveBeenCalledWith('u1');
    await act(async () => q('agent-sign-in-open-page')!.click());
    expect(mocks.opened).toEqual([LINK]);
    // 登录进程放宽,长链接不被 CLI 按终端宽度折开
    expect(mocks.binding?.resize).toHaveBeenCalledWith(1000, 40);
  });

  it('设备码单独摆出来', async () => {
    await render();
    await set({ status: { kind: 'unauthenticated' }, login: login({ userCode: 'WDJB-MJHT' }) });
    expect(q('agent-sign-in-user-code')?.textContent).toBe('WDJB-MJHT');
  });

  it('CLI 要码 ⇒ 出输入框;交上去的码带回车送进登录,随后显示正在验证;码没过 ⇒ 说清楚再要', async () => {
    await render();
    await set({ status: { kind: 'unauthenticated' }, login: login() });
    expect(q('agent-sign-in-code-input')).toBeNull();
    await set({ status: { kind: 'unauthenticated' }, login: login({ awaitingInput: true, inputPromptCount: 1 }) });
    const input = q('agent-sign-in-code-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = '  abc123#state  ';
    await act(async () => {
      q('agent-sign-in-code-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.binding?.sendInput).toHaveBeenCalledWith('abc123#state\r');
    await set({ status: { kind: 'unauthenticated' }, login: login({ awaitingInput: false, inputPromptCount: 1 }) });
    expect(dom.window.document.body.textContent).toContain('agentsPage.signInVerifying');
    await set({ status: { kind: 'unauthenticated' }, login: login({ awaitingInput: true, inputPromptCount: 2 }) });
    expect(dom.window.document.body.textContent).toContain('agentsPage.signInCodeRejected');
    expect(q('agent-sign-in-code-input')).not.toBeNull();
  });

  it('要的是 API Key ⇒ 说「创建一把粘贴到下面」,不摆「正在等待授权」', async () => {
    await render();
    await set({
      status: { kind: 'unauthenticated' },
      login: login({ awaitingInput: true, inputPromptCount: 1, inputKind: 'key' }),
    });
    expect((q('agent-sign-in-code-input') as HTMLInputElement).type).toBe('password');
    expect(dom.window.document.body.textContent).toContain('agentsPage.signInWaitingKey');
    expect(q('agent-sign-in-waiting')).toBeNull();
  });

  it('登录命令失败退出 ⇒ 摆出它最后几行原话,给「重试」', async () => {
    await render();
    await set({
      status: { kind: 'unauthenticated' },
      login: login({ exit: { exitCode: 1, signal: null, tail: 'Error: token exchange failed (403)' } }),
    });
    expect(q('agent-sign-in-failed')?.textContent).toContain('Error: token exchange failed (403)');
    expect(dom.window.document.body.textContent).toContain('agentsPage.signInRetry');
  });

  it('登录起不来 ⇒ 原文进日志,界面只说没登录成功并给「重试」', async () => {
    mocks.startFailure = new Error('host rpc: ECONNRESET at 127.0.0.1:41507');
    await render();
    expect(q('agent-sign-in-failed')).not.toBeNull();
    expect(dom.window.document.body.textContent).not.toContain('ECONNRESET');
    expect(dom.window.document.body.textContent).toContain('agentsPage.signInRetry');
    expect(mocks.logged).toHaveLength(1);
  });

  it('读数翻成已登录 ⇒ 收掉登录进程并算成功', async () => {
    const onSuccess = await render();
    await set({ status: { kind: 'unauthenticated' }, login: login() });
    await set({ status: { kind: 'authenticated' }, login: null });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.binding?.dispose).toHaveBeenCalledWith(true);
  });
});
