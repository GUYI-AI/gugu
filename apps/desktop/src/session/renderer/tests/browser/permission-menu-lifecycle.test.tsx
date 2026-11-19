import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { buildSessionPermissionOptions } from '@shared/session-permission-options';
import { usePermissionMenu } from '@renderer/features/sessions/session-config/use-permission-menu';
import { localizePermissionModeOptions } from '@renderer/features/sessions/acp/permission-mode-options';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { i18n } from '@/i18n';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

const rpc = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionCreateModels: rpc.read } }) }));
const modeMap = { plan: { id: 'plan' }, 'read-only': { id: 'default' }, edit: { id: 'acceptEdits' }, 'ai-review': { id: 'auto' }, 'full-access': { id: 'bypassPermissions' } };
const native = Object.values(modeMap).map(({ id }) => ({ id, name: id }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); rpc.read.mockReset(); });

function Session({ lifecycle }: { lifecycle: string }) {
  const group = usePermissionMenu({ provider: 'claude', model: 'opus', modeMap, machine: null, leg: 'acp' });
  const options = group ? Object.fromEntries(group.available.map(({ id, ...choice }) => [id, choice])) : null;
  return <div data-lifecycle={lifecycle}><ChatComposer
    permissionModeOptions={localizePermissionModeOptions(options, translateSessionMessage, 'Claude', modeMap)}
    selectedPermissionMode="bypassPermissions" onPermissionModeChange={() => {}}
    onSubmit={() => {}} onStop={() => {}} /></div>;
}

it.each(['running', 'stopped', 'disconnected'])('renders the same native-qualified five rows for %s', async lifecycle => {
  await i18n.changeLanguage('zh-CN');
  rpc.read.mockResolvedValue({ ok: true, value: { permissionOptions: buildSessionPermissionOptions({ modeMap, native, review: { allowed: true } }) } });
  const container = document.createElement('div'); container.style.cssText = 'position:absolute;left:100px;bottom:40px;width:700px'; document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => { root.unmount(); container.remove(); client.clear(); });
  root.render(<QueryClientProvider client={client}><SessionLocalizationProvider><Session lifecycle={lifecycle} /></SessionLocalizationProvider></QueryClientProvider>);
  await until('native permission facts read', () => rpc.read.mock.calls.length === 1 && container.querySelector('[data-slot=composer-permission-mode]') !== null);
  await page.getByText('完全访问', { exact: true }).click();
  await until('menu mounted', () => document.querySelector('[data-slot=combobox-content]') !== null);
  const rows = [...document.querySelectorAll('[role=option]')].filter(e => e.getBoundingClientRect().width > 0);
  expect(rows.map(row => row.textContent)).toEqual(['规划', '只读', '编辑', '自动模式', '完全访问']);
  await until('review row qualified', () => rows.find(row => row.textContent === '自动模式')?.getAttribute('aria-disabled') !== 'true');
  expect(rpc.read.mock.calls[0][0]).toEqual({ harness: 'claude', sessionView: 'general', model: 'opus' });
});
