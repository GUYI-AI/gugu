/**
 * #3857 — 「点击清理 弹窗被遮住了没法选」. App 市场 is a page modal (Sheet at --z-settings with a dialog layer inside it
 * that the global modal store is pointed at, as workspace.tsx PageModal does); an agent's details are their own dialog,
 * one layer above the sheet. The old-versions row asked the GLOBAL store for its confirmation, which opened inside the
 * sheet, under the details: drawn, focused, invisible. The criterion is the one a person has: what is under the pointer
 * at the confirmation's center (`elementFromPoint`), not which container it was rendered in.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { Sheet, PAGE_MODAL_FRAME } from '@/components/ui/Sheet';
import { captureOcclusions, findOcclusion } from '@/lib/overlayOcclusion';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { SessionModalHost } from '@/components/SessionModalHost';
import { confirmDanger } from '@/lib/confirmDanger';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { useConfirm } from '@renderer/lib/modal/modal-surface';
import { MarketDetailDialog } from '@renderer/features/extensions/panel/market-detail-dialog';
import { ManagedVersionsRow } from '@renderer/features/settings/agents-page/ManagedVersionsRow';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import '@renderer/index.css';

const state = vi.hoisted(() => ({ clean: vi.fn() }));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } });
vi.mock('@/lib/replica', async (load) => ({
  ...await load<typeof import('@/lib/replica')>(),
  replicaAccount: () => ({ id: 'owner' }),
  useReplica: () => ({ state: 'value', value: { currentVersion: '0.172.0', versions: ['0.167.1', '0.167.2', '0.172.0'] }, stale: false, error: null }),
}));
vi.mock('@renderer/features/settings/agents-page/managed-versions-model', () => ({ managedVersions: { refresh: async () => undefined }, cleanManagedVersions: state.clean }));
vi.mock('@renderer/features/library/library-host', async (load) => ({ ...await load<typeof import('@renderer/features/library/library-host')>(), useLibraryHost: () => ({ key: 'local', remote: null }) }));

const DIALOG_LAYER: CSSProperties = { position: 'fixed', top: 0, left: 0, width: 0, height: 0, zIndex: 'var(--z-modal)' };
let root: Root | undefined;
const els: HTMLElement[] = [];

beforeEach(async () => { await page.viewport(1280, 900); modalStore.closeModal(); });
afterEach(() => { modalStore.closeModal(); modalStore.setPortalContainer(null); root?.unmount(); root = undefined; for (const el of els.splice(0)) el.remove(); });

/** The App market frame as workspace.tsx PageModal draws it: the global store is pointed inside the sheet. */
function PageModalFrame({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (!layer) return; modalStore.setPortalContainer(layer); return () => modalStore.setPortalContainer(null); }, [layer]);
  return <Sheet onClose={() => undefined} {...PAGE_MODAL_FRAME} testId="page-modal" ariaLabel="apps">
    <div style={{ height: 400 }}>App market</div>
    {children}
    <div ref={setLayer} style={DIALOG_LAYER} />
  </Sheet>;
}

function mount(node: ReactNode) {
  const host = document.createElement('div'); const pageLayer = document.createElement('div');
  for (const el of [host, pageLayer]) { el.className = 'gugu-skin emlight'; document.body.append(el); els.push(el); }
  root = createRoot(host);
  root.render(<QueryClientProvider client={new QueryClient()}><SessionLocalizationProvider>
    <UiPortalContainerProvider value={pageLayer}>{node}<ModalRenderer /></UiPortalContainerProvider>
  </SessionLocalizationProvider></QueryClientProvider>);
}

const confirmation = () => document.querySelector<HTMLElement>('[data-surface-modal="confirmActionModal"]');
const centerHit = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };

it('the old-versions confirmation opens above the market details, inside the page modal', async () => {
  mount(<PageModalFrame><MarketDetailDialog onClose={() => undefined}><ManagedVersionsRow agentId="codex" name="Codex" disabled={false} /></MarketDetailDialog></PageModalFrame>);
  const rowButtons = () => [...document.querySelectorAll<HTMLElement>('[data-testid="managed-old-versions"] button:not([role="checkbox"])')];
  await until('the row is shown', () => rowButtons().length === 1);
  await userEvent.click(rowButtons()[0]);
  await until('the versions are listed', () => document.querySelectorAll('[role="checkbox"]').length === 3);
  await userEvent.click(document.querySelectorAll<HTMLElement>('[role="checkbox"]')[1]);
  // Cancel, Clean: the clean action is the last one.
  await userEvent.click(rowButtons().at(-1)!);
  await until('the confirmation opens', () => confirmation()?.hasAttribute('data-open') === true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const popup = confirmation()!;
  const details = document.querySelector<HTMLElement>('[data-testid="market-detail-dialog"]')!;
  expect(modalStore.activeModalId, 'the global store is not used from inside a dialog').toBeNull();
  expect(popup.hasAttribute('data-nested'), 'a Base UI nested dialog of the details').toBe(true);
  expect(popup.contains(centerHit(popup)), 'what is under the pointer at its center is the confirmation').toBe(true);
  expect(details.contains(centerHit(popup))).toBe(false);
  expect(findOcclusion(popup, 'test')).toBeNull();
  await page.screenshot({ path: '__screenshots__/overlay-layering-3857-market.png' });
  // Confirming runs the clean and closes only the confirmation: the details stay.
  state.clean.mockResolvedValue({ removed: ['0.167.1'], failed: [], snapshot: null });
  await userEvent.click([...popup.querySelectorAll<HTMLElement>('[data-slot="dialog-footer"] button')].at(-1)!);
  await until('the clean ran', () => state.clean.mock.calls.length === 1);
  await until('the confirmation closed', () => confirmation() === null);
  expect(state.clean).toHaveBeenCalledWith(null, 'codex', ['0.167.1']);
  expect(document.querySelector('[data-testid="market-detail-dialog"]')).not.toBeNull();
});

it('the old way is what the occlusion probe catches: the global store from inside the details', async () => {
  function GlobalAsk() {
    return <button type="button" data-testid="ask" onClick={() => modalStore.setModal('confirmActionModal', {
      title: 'old way', description: '', confirmLabel: 'OK', variant: 'default', onSuccess: () => undefined, onClose: () => modalStore.closeModal('dismissed'),
    })}>ask</button>;
  }
  const reports = captureOcclusions();
  try {
    mount(<PageModalFrame><MarketDetailDialog onClose={() => undefined}><GlobalAsk /></MarketDetailDialog></PageModalFrame>);
    await until('the details are open', () => document.querySelector('[data-testid="ask"]') !== null);
    document.querySelector<HTMLButtonElement>('[data-testid="ask"]')!.click();
    await until('the probe reports the global confirmation', () => reports.found.some((found) => found.owner === 'session-modal'));
    const found = reports.found.find((item) => item.owner === 'session-modal')!;
    expect(found.hit, 'covered by the details dialog').toContain('market-detail-dialog');
    expect(reports.found.filter((item) => item.owner !== 'session-modal'), 'nothing else is covered').toEqual([]);
  } finally {
    reports.stop();
    modalStore.closeModal();
  }
});

it('outside any overlay useConfirm still uses the global store', async () => {
  function Ask() { const confirm = useConfirm(); return <button type="button" data-testid="ask" onClick={() => confirm({ title: 'page', description: '', confirmLabel: 'OK', variant: 'default' })}>ask</button>; }
  mount(<Ask />);
  await until('mounted', () => document.querySelector('[data-testid="ask"]') !== null);
  document.querySelector<HTMLButtonElement>('[data-testid="ask"]')!.click();
  await until('the global store opened it', () => modalStore.activeModalId === 'confirmActionModal');
  expect(confirmation()).toBeNull();
});

it('a dialog taller than the window keeps its header and footer and scrolls its body', async () => {
  await page.viewport(800, 420);
  mount(<Dialog open><DialogContent data-testid="tall">
    <DialogHeader><DialogTitle>Tall</DialogTitle></DialogHeader>
    <div data-testid="tall-body"><div style={{ height: 1200 }}>content</div></div>
    <DialogFooter><button type="button" data-testid="tall-ok">OK</button></DialogFooter>
  </DialogContent></Dialog>);
  await until('open', () => document.querySelector('[data-testid="tall"]')?.hasAttribute('data-open') === true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const popup = document.querySelector<HTMLElement>('[data-testid="tall"]')!;
  const body = document.querySelector<HTMLElement>('[data-testid="tall-body"]')!;
  const ok = document.querySelector<HTMLElement>('[data-testid="tall-ok"]')!;
  expect(popup.getBoundingClientRect().height).toBeLessThanOrEqual(420);
  expect(getComputedStyle(body).overflowY).toBe('auto');
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  const r = ok.getBoundingClientRect();
  expect(r.bottom).toBeLessThanOrEqual(420);
  expect(ok.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), 'the footer button is reachable').toBe(true);
});

it('a confirmation from a plain function inside Contacts (a PAGE_MODAL_FRAME sheet, no redirect) opens above the sheet', async () => {
  // MainLayout draws Contacts in a Sheet at --z-settings and never points the global store into it; ContactsPanel and
  // ContactRowActions ask through confirmDanger / showModal. The global layer used to sit at --z-modal, under the sheet.
  const host = document.createElement('div'); document.body.append(host); els.push(host);
  root = createRoot(host);
  let answer: Promise<boolean> | null = null;
  root.render(<>
    <Sheet onClose={() => undefined} {...PAGE_MODAL_FRAME} testId="contacts-sheet" ariaLabel="contacts">
      <button type="button" data-testid="delete-contact" onClick={() => { answer = confirmDanger({ title: 'Delete contact?', description: 'x', confirmLabel: 'Delete' }); }}>delete</button>
    </Sheet>
    <SessionModalHost />
  </>);
  await until('the sheet is open', () => document.querySelector('[data-testid="delete-contact"]') !== null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await userEvent.click(document.querySelector<HTMLElement>('[data-testid="delete-contact"]')!);
  const popup = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')].find((el) => el.textContent?.includes('Delete contact?'));
  await until('the confirmation is open', () => popup()?.hasAttribute('data-open') === true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sheet = document.querySelector<HTMLElement>('[data-testid="contacts-sheet"]')!;
  expect(popup()!.contains(centerHit(popup()!)), 'the confirmation is what is under the pointer').toBe(true);
  expect(sheet.contains(centerHit(popup()!))).toBe(false);
  await page.screenshot({ path: '__screenshots__/overlay-layering-3857-contacts.png' });
  await userEvent.click([...popup()!.querySelectorAll<HTMLElement>('[data-slot="dialog-footer"] button')].at(-1)!);
  expect(await answer).toBe(true);
});
