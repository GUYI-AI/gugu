// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunInstallProvider } from '@/components/firstRun/FirstRunInstallProvider';
import { NoticeBannerSlot } from '@/components/NoticeHost';
import { useFirstRunInstaller } from '@/components/firstRun/first-run-install-context';
import { queryClient } from '@/lib/replica';

const f = vi.hoisted(() => ({ install: vi.fn(), status: vi.fn(), probe: vi.fn(), list: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useAgentInstallationStatuses: () => ({ installAsync: f.install }), useAgentInstallProgress: () => null,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { agents: { probe: f.probe, getAgentInstallationStatus: f.status, cancelInstall: vi.fn() } } }));
// The shared installation status the agent store and Settings read; here a device entry over `f.list`.
vi.mock('@renderer/lib/stores/agent-replicas', async () => {
  const { replica } = await import('@/lib/replica');
  return { agentInstallationStatus: replica({ name: 'testAgentInstallationStatus', scope: 'device', read: (_device: string, _machine: null) => f.list() }) };
});

function Flow() {
  const queue = useFirstRunInstaller(); const [page, setPage] = useState('choose');
  return page === 'choose' ? <button onClick={() => { queue(['codex', 'claude']); setPage('next'); }}>Continue</button> : <p>Next setup step</p>;
}
let host: HTMLDivElement; let root: Root;
const deferred = () => { let resolve!: (x: { success: boolean }) => void; const promise = new Promise<{ success: boolean }>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.install.mockReset(); f.probe.mockReset().mockResolvedValue(undefined); f.list.mockReset().mockResolvedValue([]); f.status.mockReset().mockResolvedValue({ used: { kind: 'method', method: 'mise' }, installations: [{ provenance: { ours: true, kind: 'mise' }, status: 'available' }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); queryClient.clear(); });

describe('managed installations survive leaving the selection step (#7582)', () => {
  it('tracks both concurrent installs independently after continuing', async () => {
    const codex = deferred(), claude = deferred();
    f.install.mockImplementation(({ id }) => id === 'codex' ? codex.promise : claude.promise);
    await act(async () => root.render(<><NoticeBannerSlot /><FirstRunInstallProvider><Flow /></FirstRunInstallProvider></>));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Next setup step');
    expect(f.install.mock.calls.map(([x]) => x)).toEqual([{ id: 'codex', method: 'mise' }, { id: 'claude', method: 'mise' }]);
    await act(async () => claude.resolve({ success: true }));
    expect(host.querySelectorAll('[data-testid="install-progress-track"]')).toHaveLength(1);
    await act(async () => codex.resolve({ success: true }));
    expect(host.querySelectorAll('[data-testid="install-progress-track"]')).toHaveLength(0);
    expect(host.textContent?.split('firstRun.harnessInstalled')).toHaveLength(3);
    expect(f.status).toHaveBeenCalledWith('codex'); expect(f.status).toHaveBeenCalledWith('claude');
  });
  it('does not report an external installed copy as a successful managed install', async () => {
    f.install.mockResolvedValue({ success: true });
    f.status.mockResolvedValue({ used: { kind: 'auto' }, installations: [{ provenance: { ours: false, kind: 'path' }, status: 'available' }] });
    await act(async () => root.render(<><NoticeBannerSlot /><FirstRunInstallProvider><Flow /></FirstRunInstallProvider></>));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(host.textContent).not.toContain('firstRun.harnessInstalled');
  });
  it('does not queue an agent again when someone goes back and continues while it is installing', async () => {
    const codex = deferred();
    f.install.mockImplementation(() => codex.promise);
    function BackAndForth() {
      const queue = useFirstRunInstaller();
      return <><button data-k="a" onClick={() => queue(['codex'])}>Continue</button><button data-k="b" onClick={() => queue(['codex', 'claude'])}>Continue again</button></>;
    }
    await act(async () => root.render(<><NoticeBannerSlot /><FirstRunInstallProvider><BackAndForth /></FirstRunInstallProvider></>));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-k="a"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-k="b"]')!.click());
    expect(f.install.mock.calls.map(([x]) => x.id)).toEqual(['codex', 'claude']);
    await act(async () => codex.resolve({ success: true }));
  });
});

describe('first run uses a copy already on this computer when it is new enough', () => {
  const copy = (reading: string, version: string | null, supported: boolean | null) => ({ id: 'codex', reading, version, versionSupported: supported,
    used: { kind: 'auto' }, installations: [] });
  function One() { const queue = useFirstRunInstaller(); return <button onClick={() => queue(['codex'])}>Continue</button>; }
  it('does not install when session start would accept the local copy', async () => {
    f.list.mockResolvedValue([copy('installed', '0.160.0', true)]);
    await act(async () => root.render(<><NoticeBannerSlot /><FirstRunInstallProvider><One /></FirstRunInstallProvider></>));
    await act(async () => host.querySelector('button')!.click());
    expect(f.probe).toHaveBeenCalledWith('codex');
    expect(f.install).not.toHaveBeenCalled();
    expect(host.textContent).toContain('firstRun.harnessInstalled');
  });
  it.each([
    ['too old', [copy('installed', '0.145.0', false)], 'firstRun.installLocalOutdated'],
    ['failing to run', [copy('detected-but-broken', null, null)], 'firstRun.installLocalBroken'],
    ['running without a readable version', [copy('installed', null, null)], 'firstRun.installLocalBroken'],
    ['not found', [copy('not-detected', null, null)], 'firstRun.installLocalMissing'],
    ['absent from the list', [], 'firstRun.installLocalMissing'],
  ] as const)('installs its own copy without asking when the local one is %s, and says why', async (_label, statuses, reason) => {
    f.install.mockReturnValue(new Promise(() => {}));
    f.list.mockResolvedValue(statuses);
    await act(async () => root.render(<><NoticeBannerSlot /><FirstRunInstallProvider><One /></FirstRunInstallProvider></>));
    await act(async () => host.querySelector('button')!.click());
    expect(f.install.mock.calls.map(([x]) => x)).toEqual([{ id: 'codex', method: 'mise' }]);
    expect(host.querySelector('[data-testid="install-progress-heading"]')?.textContent).toBe(reason);
  });
});
