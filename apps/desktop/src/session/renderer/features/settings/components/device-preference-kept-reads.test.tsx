// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * This device's preferences drawn as switches (the sidebar tint, the ideas capsule hidden): read before and their re-read
 * failed, the switch stays as read and the failure is said beside it (❌ shown as current).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({ error: new Error('settings unreadable') as Error | null }));
const reading = (value: boolean) => ({ state: 'value' as const, value, stale: false, error: h.error });
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/lib/sidebarTint', () => ({ useSidebarTintEnabled: () => reading(true), setSidebarTintEnabled: vi.fn() }));
vi.mock('@/lib/assistantIdeas', () => ({ useIdeasEntryHidden: () => reading(false), setIdeasEntryHidden: vi.fn() }));

const { SidebarTintRow } = await import('./SidebarTintRow');
const { IdeasPanel } = await import('@renderer/features/assistant/assistant-ideas');

async function draw(node: React.ReactElement) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(node));
  const out = { said: host.querySelector('[data-refresh-failed]') !== null, html: host.cloneNode(true) as HTMLDivElement };
  act(() => root.unmount());
  return out;
}

describe('a device preference read before, its re-read failed', () => {
  it('the sidebar tint switch stays on and the failure is said', async () => {
    h.error = new Error('settings unreadable');
    const tint = await draw(<SidebarTintRow />);
    expect(tint.html.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(tint.said).toBe(true);
  });

  it('the ideas panel keeps its hide switch and says the failure', async () => {
    h.error = new Error('settings unreadable');
    const panel = await draw(<IdeasPanel today={{ state: 'unknown' }} retry={vi.fn()} assistantId="a" name="Dot" askInChat={vi.fn()} onClose={vi.fn()} layout="dialog" />);
    expect(panel.html.querySelector('[data-testid="assistant-ideas-toggle"]')?.textContent).toContain('ideas.hide');
    expect(panel.said).toBe(true);
  });

  it('[control] read and current: nothing said', async () => {
    h.error = null;
    expect((await draw(<SidebarTintRow />)).said).toBe(false);
    expect((await draw(<IdeasPanel today={{ state: 'unknown' }} retry={vi.fn()} assistantId="a" name="Dot" askInChat={vi.fn()} onClose={vi.fn()} layout="dialog" />)).said).toBe(false);
  });
});
