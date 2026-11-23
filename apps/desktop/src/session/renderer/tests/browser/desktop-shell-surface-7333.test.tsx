import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders, contact } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerContactsCatalog';
import '@/styles/tokens.css';
import '@/styles/desktop-shell.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'));
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'));
const { ContactsPanel } = await import('@/components/ContactsPanel');
let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(1100, 760);
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.platform = 'mac';
});
afterEach(() => { harness?.cleanup(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.platform; });

it.each(['light', 'dark'])('real contacts in the %s page modal open a selected detail without full-height navigation borders', async (theme) => {
  document.documentElement.dataset.theme = theme;
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex';
  await renderWithAppProviders(harness,
    <div data-desktop-shell="" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div data-contacts-modal="" style={{ flex: 1, minHeight: 0 }}>
        <ContactsPanel mobile={false} />
      </div>
    </div>, {
      shellTab: 'contacts',
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })], groupChats: [] },
      chat: { chats: [] },
    });
  const region = harness.container.querySelector<HTMLElement>('[data-contacts-modal]')!;
  const getDetail = () => region.querySelector<HTMLElement>(':scope > div > :nth-child(2)')!;
  expect(getDetail().getBoundingClientRect().width, 'real CSS geometry must be present').toBeGreaterThan(600);
  const nav = region.querySelector<HTMLElement>('[data-role="nav"]')!;
  expect(getComputedStyle(nav).borderInlineEndWidth).toBe('0px');
  expect(getComputedStyle(getDetail().querySelector('.gg-pane-header')!).borderBottomWidth).toBe('1px');
  // 人在「个人」分组:先在左栏点开它,右边铺开这一组。
  await page.elementLocator(region.querySelector<HTMLElement>('[data-testid="contacts-section-nav"][data-section-key="people"]')!).click();
  await until('people group spreads on the right', () => !!region.querySelector('[data-contact-id="alice"]'));
  // Avatar loading can change the exact accessible name (Alice Alice → Alice).
  // Match the stable contact name while still exercising the real browser click.
  await page.getByRole('button', { name: /Alice/ }).click();
  await until('real contact profile opens', () => getDetail().textContent!.includes('Alice'));
  // 资料在右边那一列抽屉里(ContactsPageFrame),外框还是同一张卡片。
  expect(getDetail().querySelector('[data-testid="contacts-detail-drawer"] .gg-pane-title')?.textContent).toBe('Alice');
});

it('an empty contacts page keeps a titled header with its rule, and the empty-state call to action', async () => {
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex';
  await renderWithAppProviders(harness,
    <div data-desktop-shell="" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div data-contacts-modal="" style={{ flex: 1, minHeight: 0 }}><ContactsPanel mobile={false} onOpenAgentCreateDraft={() => {}} /></div>
    </div>, { shellTab: 'contacts', contacts: { contacts: [], groupChats: [], sharedGroupAgents: [] }, chat: { chats: [] } });
  const detail = harness.container.querySelector<HTMLElement>('[data-contacts-modal] > div > :nth-child(2)')!;
  // 右边恒是一个分组页(ContactsPageFrame):页头有标题、有分隔线,❌ 空白页头。
  const header = detail.querySelector<HTMLElement>('.gg-pane-header')!;
  expect(header.querySelector('.gg-pane-title')?.textContent).toBeTruthy();
  expect(getComputedStyle(header).borderBottomWidth).toBe('1px');
  expect(detail.querySelector('[data-testid="contacts-agent-empty"]')).not.toBeNull();
});
