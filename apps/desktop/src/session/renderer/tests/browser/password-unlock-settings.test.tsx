import { act, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { PasswordBetaUi, PasswordSnapshot, PasswordSyncView } from '@gugu/core/shared/passwordBetaProtocol';
import { PasswordSection } from '@/components/settings/PasswordSection';
import { PasswordDeviceHost } from '@/components/password/PasswordDeviceHost';
import { NoticeBannerSlot } from '@/components/NoticeHost';
import { Pane, PaneHeader } from '@/components/ui/Pane';
import { followRendererSession, queryClient } from '@/lib/replica';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';


const credential = { reference: { id: 'test-credential', version: 1, epoch: 'test' }, name: 'Example login', origin: 'https://example.test',
  maskedAccount: 't***', accountSecret: true, hasPassword: true, fields: [], grants: [], sites: [] };
const snapshot = (sync: PasswordSyncView): PasswordSnapshot => ({ items: [credential], approvals: [], saves: [], candidates: [], sync });
const ready = (): PasswordSnapshot => snapshot({ state: 'ready', devices: [], requests: [], recovery: 'set' });
let current: PasswordSnapshot;
let harness: ReturnType<typeof createReactHarness>;
let original: PasswordBetaUi | undefined;
const listeners = new Set<() => void>();
const invoke = vi.fn<PasswordBetaUi['invoke']>();

function Frame({ children }: { children?: ReactNode }) {
  const actions = useRef<HTMLDivElement>(null);
  return <Pane paneRole="detail" className="gg-settings-detail">
    <PaneHeader title="密码" actions={<div ref={actions} data-testid="password-actions" />} />
    <div className="gg-settings-body"><PasswordSection actionsHost={() => actions.current} /></div>
    {children}
  </Pane>;
}
beforeEach(async () => {
  await page.viewport(1100, 900);
  document.documentElement.dataset.theme = 'light';
  current = snapshot({ state: 'joining', code: '482916', recovery: true });
  original = window.passwordVaultBeta;
  // The vault is the signed-in account's (a replica entry of that account): one is signed in, its entry read afresh.
  followRendererSession('SIGNED_IN', 'password-tester');
  queryClient.removeQueries({ queryKey: ['passwordVault'] });
  invoke.mockReset(); invoke.mockImplementation(async () => ({ ok: true, snapshot: current }));
  window.passwordVaultBeta = { invoke, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  harness = createReactHarness();
  harness.container.style.cssText = 'display:flex;width:920px;height:800px;margin:40px';
});
afterEach(() => {
  harness.cleanup(); listeners.clear();
  if (original) window.passwordVaultBeta = original; else delete window.passwordVaultBeta;
  delete document.documentElement.dataset.theme;
});
async function mount(corner = false) {
  await harness.render(<><NoticeBannerSlot /><Frame>{corner && <PasswordDeviceHost />}</Frame></>);
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).not.toBeNull());
  return harness.container.querySelector<HTMLElement>('[data-testid="password-unlock-settings"]')!;
}
async function push(next: PasswordSnapshot) {
  await act(async () => { current = next; for (const listener of listeners) listener(); });
}
// The join card is a persistent notice: the banner (title + content + close) in the one banner slot.
const joinCard = () => document.querySelector('[data-testid="password-join-card"]')?.closest('.gugu-notice-banner') ?? null;
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!;
async function capture(name: string) {
  if (import.meta.env.VITE_OWNER_CAPTURE_PHASE) await page.screenshot({ element: document.body,
    path: `__screenshots__/password-unlock-${name}-${import.meta.env.VITE_OWNER_CAPTURE_PHASE}.png` });
}

it.each(['light', 'dark'])('uses the full-page entry and grouped code while retaining the corner card in %s', async theme => {
  document.documentElement.dataset.theme = theme;
  const entry = await mount(true);
  expect(entry.textContent).toContain('Passwords are not unlocked on this computer');
  expect(entry.textContent).toContain('In Gugu on another device, check that it shows the digits below, then click Allow.');
  expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('482 916');
  expect(entry.querySelector('[aria-label="Verification code 4 8 2 9 1 6"]')).not.toBeNull();
  expect(harness.container.textContent).not.toContain('Example login');
  expect(harness.container.textContent).not.toContain('在另一台设备上允许这台电脑后，你的密码会出现在这里');
  expect(harness.container.querySelector('[data-testid="password-actions"]')?.children).toHaveLength(0);
  const box = entry.querySelector('.password-unlock-entry')!.getBoundingClientRect();
  const body = harness.container.querySelector('.gg-settings-body')!.getBoundingClientRect();
  expect(Math.abs((box.left + box.right) / 2 - (body.left + body.right) / 2)).toBeLessThan(1);
  const heading = harness.container.querySelector('.gg-pane-header')!.getBoundingClientRect();
  expect(box.top - heading.bottom).toBeGreaterThanOrEqual(115);
  expect(box.top - heading.bottom).toBeLessThanOrEqual(140);
  await capture(`joining-${theme}`);
  await vi.waitFor(() => expect(joinCard()).not.toBeNull());
  await page.elementLocator(joinCard()!.querySelector<HTMLButtonElement>('[data-notice-close]')!).click();
  await vi.waitFor(() => expect(joinCard()).toBeNull());
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).not.toBeNull();
});

it('shows only a pending comparison code until the real joining code arrives', async () => {
  current = snapshot({ state: 'joining' });
  const entry = await mount();
  expect(entry.querySelector('[aria-label="Generating code"]')?.textContent).toBe('··· ···');
  await push(snapshot({ state: 'joining', code: '123456' }));
  await vi.waitFor(() => expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('123 456'));
});

it('uses only the title and primary recovery action when joining is blocked', async () => {
  current = snapshot({ state: 'blocked', recovery: true });
  const entry = await mount();
  expect(entry.querySelector('.password-unlock-instruction')).toBeNull();
  expect(entry.querySelector('[data-testid="password-unlock-code"]')).toBeNull();
  expect([...entry.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Unlock with recovery code']);
  expect(getComputedStyle(button(entry, 'Unlock with recovery code')).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  await capture('blocked');
});

it('asks again after refusal and updates both the settings entry and corner from the real command reply', async () => {
  current = snapshot({ state: 'refused', recovery: true });
  const entry = await mount(true);
  expect(entry.querySelector('[data-testid="password-unlock-code"]')).toBeNull();
  await capture('refused');
  invoke.mockImplementation(async command => {
    if (command.type === 'sync-ask-again') current = snapshot({ state: 'joining', code: '123456', recovery: true });
    return { ok: true, snapshot: current };
  });
  await page.elementLocator(button(entry, 'Request again')).click();
  expect(invoke).toHaveBeenCalledWith({ type: 'sync-ask-again' });
  await vi.waitFor(() => expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('123 456'));
  await vi.waitFor(() => expect(joinCard()?.textContent).toContain('another device'));
  expect(joinCard()?.textContent).not.toContain('declined');
});

it('restores the list automatically when another device approves', async () => {
  await mount(true); await push(ready());
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-settings"]')).not.toBeNull());
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).toBeNull();
  expect(harness.container.textContent).toContain('Example login');
  await vi.waitFor(() => expect(joinCard()).toBeNull());
  expect(button(harness.container, 'Add')).not.toBeUndefined();
  await capture('approved');
});

it('discards an open credential form when the device locks and returns to the list on approval', async () => {
  current = ready(); await harness.render(<Frame />);
  await vi.waitFor(() => expect(button(harness.container, 'Add')).not.toBeUndefined());
  await page.elementLocator(button(harness.container, 'Add')).click();
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-form"]')).not.toBeNull());
  await push(snapshot({ state: 'joining', code: '482916' }));
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).not.toBeNull());
  expect(harness.container.querySelector('[data-testid="password-form"]')).toBeNull();
  await push(ready());
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-settings"]')).not.toBeNull());
  expect(harness.container.querySelector('[data-testid="password-form"]')).toBeNull();
});

it('reuses recovery input, retains errors, and shows the replacement code after the list unlocks', async () => {
  const entry = await mount();
  await page.elementLocator(button(entry, 'Unlock with recovery code')).click();
  const sheet = () => document.querySelector<HTMLElement>('[data-testid="password-recover"]')!;
  await vi.waitFor(() => expect(sheet()).not.toBeNull());
  expect(sheet().textContent).toContain('Unlock with recovery code');
  expect(sheet().textContent).not.toContain('After restoring, this device can use your passwords');
  expect(button(sheet(), 'Unlock').disabled).toBe(true);
  await page.elementLocator(button(sheet(), 'Cancel')).click();
  await vi.waitFor(() => expect(sheet()).toBeNull());
  expect(invoke.mock.calls.some(([command]) => command.type === 'sync-recover')).toBe(false);
  await page.elementLocator(button(entry, 'Unlock with recovery code')).click();
  await page.getByRole('textbox', { name: 'Recovery code', exact: true }).fill('TEST-ONLY-RECOVERY-CODE');
  await capture('recovery-dialog');
  invoke.mockImplementation(async command => command.type === 'sync-recover' ? { ok: false, code: 'RECOVERY_INVALID' } : { ok: true, snapshot: current });
  await page.elementLocator(button(sheet(), 'Unlock')).click();
  await vi.waitFor(() => expect(sheet().textContent).toContain('The recovery code is incorrect. Check it and enter it again.'));
  invoke.mockImplementation(async command => {
    if (command.type === 'sync-recover') { current = ready(); return { ok: true, snapshot: current, recoveryCode: 'NEW-TEST-RECOVERY-CODE' }; }
    return { ok: true, snapshot: current };
  });
  await page.elementLocator(button(sheet(), 'Unlock')).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="password-recovery-code"]')?.textContent).toContain('NEW-TEST-RECOVERY-CODE'));
  expect(invoke).toHaveBeenCalledWith({ type: 'sync-recover', code: 'TEST-ONLY-RECOVERY-CODE' });
  expect(harness.container.querySelector('[data-testid="password-settings"]')).not.toBeNull();
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).toBeNull();
  expect(sheet()).toBeNull();
});
