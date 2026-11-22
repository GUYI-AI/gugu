import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { SubscriptionModelRows } from '@/components/settings/SubscriptionModelRows';

const fixture = vi.hoisted(() => ({ expired: false, credentialKind: 'oauth', buttons: [] as Array<Record<string, unknown>> }));
vi.mock('./listed-connections', () => ({ useConnectionDetails: () => ({ state: 'value', value: {
  status: { kind: 'authenticated', account: 'fixture-account', credentialKind: fixture.credentialKind }, plan: { payer: 'subscription' },
} }) }));
vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({ useAgentAuthStatus: () => ({ auth: fixture.expired
  ? { status: { kind: 'unauthenticated', reason: 'expired' } } : { status: { kind: 'authenticated' } } }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('./subscription-queries', () => ({ errorText: String }));
vi.mock('@/lib/icons', () => ({ Trash2: () => <svg /> }));
vi.mock('@renderer/lib/components/app-icon', () => ({ AppIcon: () => <span /> }));
vi.mock('@/components/settings/InlineConnectionName', () => ({ InlineConnectionName: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/components/settings/SettingsPrimitives', () => ({ SettingsNote: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  SettingsRow: ({ title, description, control, ...props }: { title?: ReactNode; description?: ReactNode; control?: ReactNode }) => <div {...props}>{title}{description}{control}</div> }));
vi.mock('@/components/settings/SubscriptionModelQuota', () => ({ SubscriptionModelQuota: ({ children }: { children?: ReactNode }) => <>{children}</> }));
vi.mock('@/components/settings/subscription-quota-windows', () => ({ useQuotaWindows: () => ({ windows: [] }) }));
vi.mock('@renderer/lib/ui/button', () => ({ Button: (props: Record<string, unknown>) => {
  fixture.buttons.push(props);
  return <button {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'size' && key !== 'variant'))} />;
} }));
afterEach(() => { fixture.expired = false; fixture.credentialKind = 'oauth'; fixture.buttons.length = 0; });
const agent = { id: 'codex', name: 'Codex' } as AgentPayload;
function render(kind: 'native' | 'account') {
  const onSignIn = vi.fn();
  const html = renderToStaticMarkup(<SubscriptionModelRows agent={agent} machine={null} busy={false}
    connections={[{ id: kind === 'native' ? 'native' : 'saved', kind, name: '', current: true }]}
    onSignIn={onSignIn} onRemove={vi.fn()} onSelect={vi.fn()} onRename={vi.fn()} onRetry={vi.fn()} />);
  return { html, onSignIn };
}

it('keeps re-login visible for an authenticated saved account whose auth file still exists', () => {
  const result = render('account');
  expect(result.html).toContain('subscriptions.connections.signInAgain');
  (fixture.buttons.find(button => button['data-testid'] === 'model-sign-in-saved')!.onClick as () => void)();
  expect(result.onSignIn).toHaveBeenCalledWith('saved');
});
it.each([false, true])('shows native status and logs into that same connection with expired=%s', expired => {
  fixture.expired = expired;
  const result = render('native');
  expect(result.html).toContain(expired ? 'subscriptions.connections.expired' : 'subscriptions.connections.signedIn');
  expect(result.html).toContain('subscriptions.connections.signInAgain');
  (fixture.buttons.find(button => button['data-testid'] === 'model-sign-in-native')!.onClick as () => void)();
  expect(result.onSignIn).toHaveBeenCalledWith('native');
});
it('does not offer an OAuth re-login action for an API-key connection', () => {
  fixture.credentialKind = 'api-key';
  expect(render('account').html).not.toContain('subscriptions.connections.signInAgain');
});
