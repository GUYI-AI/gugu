import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { useConversationOptions } from '@/components/chat/useConversationOptions';
import { followRendererSession, queryClient } from '@/lib/replica';
import { i18n } from '@/i18n';

const state = vi.hoisted(() => ({ withModelMenu: true, failing: false }));
vi.mock('@/components/assistant/assistantTimelineClient', () => ({
  conversationOptionClient: () => ({
    read: async () => { if (state.failing) throw new Error('host unreachable'); return {
      mode: { selected: ':read-only', available: [{ id: ':read-only', name: 'native' }] },
      modeMap: { 'read-only': { id: ':read-only' } },
      permissionAgentName: 'Codex',
      ...(state.withModelMenu ? { modelMenu: { agentName: 'Codex' } } : {}),
    }; },
  }),
}));

// The options are an account's reading: the product shows a conversation only to a signed-in person.
followRendererSession('SIGNED_IN', 'reader');

let root: Root | undefined;
afterEach(async () => {
  root?.unmount();
  document.body.replaceChildren();
  await i18n.changeLanguage('zh-CN');
});

function PermissionDescription() {
  const { props } = useConversationOptions({ deviceId: 'host', sessionId: 'session', local: false }, 'Agent nickname');
  return <p>{props.permissionModeOptions?.[':read-only']?.description}</p>;
}

it.each([
  { locale: 'en-US', withModelMenu: true }, { locale: 'zh-CN', withModelMenu: true },
  { locale: 'en-US', withModelMenu: false }, { locale: 'zh-CN', withModelMenu: false },
] as const)('conversation permissions use host metadata in $locale (model menu: $withModelMenu)', async ({ locale, withModelMenu }) => {
  state.withModelMenu = withModelMenu;
  await i18n.changeLanguage(locale);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(<PermissionDescription />);
  await until('the host name is interpolated', () => document.body.textContent?.includes('Codex') === true);
  expect(document.body.textContent).not.toContain('Agent nickname');
  expect(document.body.textContent).not.toContain('{agent}');
});

function OptionsNotice() {
  const { props } = useConversationOptions({ deviceId: 'host', sessionId: 'session-refresh', local: false }, 'Agent nickname');
  return <><p>{props.permissionModeOptions?.[':read-only']?.description}</p><p data-notice>{props.notice?.message}</p></>;
}

it('options read before whose read again fails stay offered and the failure is the composer notice (❌ drawn as current)', async () => {
  state.withModelMenu = true;
  state.failing = false;
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(<OptionsNotice />);
  await until('the options are read', () => document.body.textContent?.includes('Codex') === true);
  expect(document.querySelector('[data-notice]')?.textContent).toBe('');
  state.failing = true;
  await queryClient.refetchQueries({ type: 'active' }).catch(() => undefined);
  await until('the failed read again is said', () => (document.querySelector('[data-notice]')?.textContent ?? '') !== '');
  expect(document.body.textContent).toContain('Codex');
  state.failing = false;
});
