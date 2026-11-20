import { afterEach, expect, it, vi } from 'vitest';
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config';
import { showAgentHomeUpgradeNotice } from './agent-home-upgrade-notice';

const calls = vi.hoisted(() => ({ notify: vi.fn(), open: vi.fn(), storage: new Map<string, string>() }));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', getFixedT: () => (key: string) => key } }));
vi.mock('@/lib/notices', () => ({ notify: calls.notify }));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: vi.fn() }));
vi.mock('@renderer/lib/open-shell-settings', () => ({ openShellSettings: calls.open }));
afterEach(() => { vi.unstubAllGlobals(); calls.storage.clear(); vi.clearAllMocks(); });
function home(importedAt: string, upgradeSignIn?: 'copied' | 'relogin'): AgentHomeScan {
  vi.stubGlobal('localStorage', { getItem: (key: string) => calls.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { calls.storage.set(key, value); } });
  return { providerId: 'codex', name: 'Codex', userRoot: '/fixture/native', sourceReadable: true,
    importedAt, needsImport: false, sourceUpdated: false, migration: false, upgraded: true, upgradeSignIn,
    groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0 };
}

it('reaches an old copied-OAuth migration even after its original notice was dismissed, once per migration', () => {
  const old = home('old-oauth');
  old.upgradeSignIn = 'copied';
  calls.storage.set(`gugu.agentHomeMigration:${JSON.stringify([['codex', old.importedAt]])}`, '1');
  showAgentHomeUpgradeNotice([old]);
  showAgentHomeUpgradeNotice([old]);
  expect(calls.notify).toHaveBeenCalledTimes(1);
  const notice = calls.notify.mock.calls[0]![0];
  expect(notice).toMatchObject({ ongoing: true, description: 'agentHome.codexUpgradeRelogin' });
  expect(calls.storage.has(notice.key)).toBe(false);
  notice.action.onClick();
  expect(calls.open).toHaveBeenCalledWith('model');
  notice.onDismiss();
  expect(calls.storage.get(notice.key)).toBe('1');
});

it('does not repeat a persistently dismissed OAuth warning after restart', () => {
  const old = home('dismissed-oauth', 'copied');
  calls.storage.set(`gugu.codexUpgradeRelogin:${old.importedAt}`, '1');
  showAgentHomeUpgradeNotice([old]);
  expect(calls.notify).not.toHaveBeenCalled();
});

it('prompts a newly skipped OAuth sign-in but leaves API-key migrations on the ordinary notice', () => {
  showAgentHomeUpgradeNotice([home('new-oauth', 'relogin')]);
  expect(calls.notify.mock.calls[0]![0].description).toBe('agentHome.codexUpgradeRelogin');
  calls.notify.mockClear();
  showAgentHomeUpgradeNotice([home('api-key')]);
  expect(calls.notify).toHaveBeenCalledTimes(1);
  expect(calls.notify.mock.calls[0]![0].description).toBe('agentHome.migrationNotice');
});

it('keeps skipped-file results available alongside the OAuth warning', () => {
  showAgentHomeUpgradeNotice([{ ...home('oauth-skipped-files', 'copied'), upgradeIssues: [{ path: 'rules/link', reason: 'symlink' }] }]);
  expect(calls.notify).toHaveBeenCalledTimes(2);
  expect(calls.notify.mock.calls[1]![0].action).toBeDefined();
});
