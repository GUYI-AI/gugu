import { act, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { PasswordBetaUi, PasswordSnapshot, PasswordSyncView } from '@gugu/core/shared/passwordBetaProtocol';
import { PasswordSection } from '@/components/settings/PasswordSection';
import { PasswordDeviceHost } from '@/components/password/PasswordDeviceHost';
import { Pane, PaneHeader } from '@/components/ui/Pane';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/shared/passwordBeta', () => ({ PASSWORD_BETA_ENABLED: true }));

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
  await harness.render(<Frame>{corner && <PasswordDeviceHost />}</Frame>);
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).not.toBeNull());
  return harness.container.querySelector<HTMLElement>('[data-testid="password-unlock-settings"]')!;
}
async function push(next: PasswordSnapshot) {
  await act(async () => { current = next; for (const listener of listeners) listener(); });
}
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!;
async function capture(name: string) {
  if (import.meta.env.VITE_OWNER_CAPTURE_PHASE) await page.screenshot({ element: document.body,
    path: `__screenshots__/password-unlock-${name}-${import.meta.env.VITE_OWNER_CAPTURE_PHASE}.png` });
}

it.each(['light', 'dark'])('uses the full-page entry and grouped code while retaining the corner card in %s', async theme => {
  document.documentElement.dataset.theme = theme;
  const entry = await mount(true);
  expect(entry.textContent).toContain('此电脑尚未解锁密码');
  expect(entry.textContent).toContain('请在另一台设备的咕咕上核对以下数字，并点击「允许」。');
  expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('482 916');
  expect(entry.querySelector('[aria-label="验证码 4 8 2 9 1 6"]')).not.toBeNull();
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
  const corner = document.querySelector('[data-testid="password-join-card"]')!;
  await page.elementLocator(corner.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!).click();
  expect(document.querySelector('[data-testid="password-join-card"]')).toBeNull();
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).not.toBeNull();
});

it('shows only a pending comparison code until the real joining code arrives', async () => {
  current = snapshot({ state: 'joining' });
  const entry = await mount();
  expect(entry.querySelector('[aria-label="验证码生成中"]')?.textContent).toBe('··· ···');
  await push(snapshot({ state: 'joining', code: '123456' }));
  await vi.waitFor(() => expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('123 456'));
});

it('uses only the title and primary recovery action when joining is blocked', async () => {
  current = snapshot({ state: 'blocked', recovery: true });
  const entry = await mount();
  expect(entry.querySelector('.password-unlock-instruction')).toBeNull();
  expect(entry.querySelector('[data-testid="password-unlock-code"]')).toBeNull();
  expect([...entry.querySelectorAll('button')].map(node => node.textContent)).toEqual(['用恢复码解锁']);
  expect(getComputedStyle(button(entry, '用恢复码解锁')).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
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
  await page.elementLocator(button(entry, '重新申请')).click();
  expect(invoke).toHaveBeenCalledWith({ type: 'sync-ask-again' });
  await vi.waitFor(() => expect(entry.querySelector('[data-testid="password-unlock-code"]')?.textContent).toBe('123 456'));
  expect(document.querySelector('[data-testid="password-join-card"]')?.textContent).not.toContain('拒绝');
});

it('restores the list automatically when another device approves', async () => {
  await mount(true); await push(ready());
  await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="password-settings"]')).not.toBeNull());
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).toBeNull();
  expect(harness.container.textContent).toContain('Example login');
  expect(document.querySelector('[data-testid="password-join-card"]')).toBeNull();
  expect(button(harness.container, '添加')).not.toBeUndefined();
  await capture('approved');
});

it('discards an open credential form when the device locks and returns to the list on approval', async () => {
  current = ready(); await harness.render(<Frame />);
  await vi.waitFor(() => expect(button(harness.container, '添加')).not.toBeUndefined());
  await page.elementLocator(button(harness.container, '添加')).click();
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
  await page.elementLocator(button(entry, '用恢复码解锁')).click();
  const sheet = () => document.querySelector<HTMLElement>('[data-testid="password-recover"]')!;
  await vi.waitFor(() => expect(sheet()).not.toBeNull());
  expect(sheet().textContent).toContain('用恢复码解锁');
  expect(sheet().textContent).not.toContain('恢复后，此设备可使用你的密码');
  expect(button(sheet(), '解锁').disabled).toBe(true);
  await page.elementLocator(button(sheet(), '取消')).click();
  await vi.waitFor(() => expect(sheet()).toBeNull());
  expect(invoke.mock.calls.some(([command]) => command.type === 'sync-recover')).toBe(false);
  await page.elementLocator(button(entry, '用恢复码解锁')).click();
  await page.getByRole('textbox', { name: '恢复码', exact: true }).fill('TEST-ONLY-RECOVERY-CODE');
  await capture('recovery-dialog');
  invoke.mockImplementation(async command => command.type === 'sync-recover' ? { ok: false, code: 'RECOVERY_INVALID' } : { ok: true, snapshot: current });
  await page.elementLocator(button(sheet(), '解锁')).click();
  await vi.waitFor(() => expect(sheet().textContent).toContain('恢复码不正确，请核对后重新输入。'));
  invoke.mockImplementation(async command => {
    if (command.type === 'sync-recover') { current = ready(); return { ok: true, snapshot: current, recoveryCode: 'NEW-TEST-RECOVERY-CODE' }; }
    return { ok: true, snapshot: current };
  });
  await page.elementLocator(button(sheet(), '解锁')).click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="password-recovery-code"]')?.textContent).toContain('NEW-TEST-RECOVERY-CODE'));
  expect(invoke).toHaveBeenCalledWith({ type: 'sync-recover', code: 'TEST-ONLY-RECOVERY-CODE' });
  expect(harness.container.querySelector('[data-testid="password-settings"]')).not.toBeNull();
  expect(harness.container.querySelector('[data-testid="password-unlock-settings"]')).toBeNull();
  expect(sheet()).toBeNull();
});
