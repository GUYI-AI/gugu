// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, rpcOn: () => ({ extensions: {} }), onMachineEvent: () => () => undefined, events: { on: () => () => undefined } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn() } }));

const { AppMarketFirstScreen } = await import('./app-market-content');
type MarketCard = import('../market-replicas').MarketCard;

function card(id: string, button?: MarketCard['button']): MarketCard {
  return { id, version: '1.0.0', name: id, subtitle: 's', iconUrl: null, category: 'other', deprecated: false, defaultLocale: 'en', ...(button ? { button } : {}) };
}

describe('the market first screen kept across restarts', () => {
  it('draws each kept card\'s button in its first render; a card kept without one waits', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    // One synchronous render, nothing read: what the first frame draws.
    act(() => root.render(
      <AppMarketFirstScreen hostKey="local" chip="all" onChipChange={() => undefined} first={{
        featured: [card('f', { kind: 'get' })], featuredCount: 1, remainingCount: 3, categories: ['other'],
        grid: [card('a', { kind: 'open' }), card('b', { kind: 'update', version: '2.0.0' }), card('c')],
      }} />,
    ));
    const html = host.innerHTML;
    act(() => root.unmount());
    expect(html).toMatch(/data-testid="market-row-action-a"[^>]*data-lifecycle="open"|data-lifecycle="open"[^>]*data-testid="market-row-action-a"/);
    expect(html).toMatch(/data-testid="market-row-action-b"[^>]*data-lifecycle="update"|data-lifecycle="update"[^>]*data-testid="market-row-action-b"/);
    expect(html).not.toContain('market-row-action-c');
    expect(html).toMatch(/data-testid="app-featured-action-f"[^>]*data-lifecycle="get"|data-lifecycle="get"[^>]*data-testid="app-featured-action-f"/);
  });
});
