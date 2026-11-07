// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/login"}
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultLoginPage } from './vault-browser-login-page';
import type { VaultLoginGateAnswer, VaultLoginGateRequest } from './vault-browser-login-protocol';

const selection = { form: '#login', account: '#account', password: '#password', submitter: '#submit' };
function fixture() {
  document.body.innerHTML = '<form id="login" method="post" action="/session"><input id="account" name="account"><input id="password" name="password" type="password"><button id="submit" name="login" value="1">Go</button></form>';
  const canary = randomUUID();
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  const gate = vi.fn((request: VaultLoginGateRequest): VaultLoginGateAnswer => request.phase === 'fill'
    ? { ok: true, account: randomUUID(), password: canary } : { ok: true });
  const page = createVaultLoginPage(gate);
  const review = () => page.review(selection, 'https://example.test');
  return { page, gate, submit, review, canary, password: () => document.querySelector<HTMLInputElement>('#password')! };
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => vi.restoreAllMocks());

describe('private login page atomic operations', () => {
  it('fills only after the synchronous gate and submits once with the native method', () => {
    const f = fixture(); const review = f.review();
    expect(JSON.stringify(review).includes(f.canary)).toBe(false);
    expect(f.page.fill('fill')).toBe(true);
    expect(f.password().value === f.canary).toBe(true);
    expect(f.page.fill('fill-again')).toBe(false);
    document.querySelector<HTMLButtonElement>('#submit')!.click();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.page.submit('submit')).toBe(true);
    expect(f.page.submit('duplicate')).toBe(false);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.gate.mock.calls.map(([request]) => request.phase)).toEqual(['fill', 'submit']);
  });
  it.each([
    ['scheme', (f: HTMLFormElement) => { f.action = 'http://example.test/session'; }],
    ['subdomain', (f: HTMLFormElement) => { f.action = 'https://sub.example.test/session'; }],
    ['port', (f: HTMLFormElement) => { f.action = 'https://example.test:8443/session'; }],
    ['lookalike', (f: HTMLFormElement) => { f.action = 'https://examp1e.test/session'; }],
    ['method', (f: HTMLFormElement) => { f.method = 'get'; }],
    ['target', (f: HTMLFormElement) => { f.target = 'other-frame'; }],
  ])('refuses changed %s at fill and at submission', (_name, mutate) => {
    const f = fixture(); f.review(); mutate(document.querySelector<HTMLFormElement>('form')!);
    expect(f.page.fill('fill')).toBe(false); expect(f.gate).not.toHaveBeenCalled();
    const next = fixture(); next.review(); expect(next.page.fill('fill')).toBe(true);
    mutate(document.querySelector<HTMLFormElement>('form')!);
    expect(next.page.submit('submit')).toBe(false); expect(next.submit).not.toHaveBeenCalled();
  });
  it('checks the submitter destination, field identities, form association and field type', () => {
    for (const mutation of [
      () => document.querySelector('#submit')!.setAttribute('formaction', 'https://other.test/post'),
      () => { document.querySelector('#password')!.outerHTML = '<input id="password" type="password" name="password">'; },
      () => document.querySelector('#password')!.setAttribute('form', 'other'),
      () => document.querySelector('#password')!.setAttribute('type', 'text'),
    ]) {
      const f = fixture(); f.review(); mutation();
      expect(f.page.fill('fill')).toBe(false); expect(f.gate).not.toHaveBeenCalled();
    }
  });
  it('does not select ambiguous fields, search/chat fields, framed login or GET forms', () => {
    const f = fixture();
    expect(() => f.page.review({ ...selection, account: 'input' }, 'https://example.test')).toThrow();
    f.password().type = 'search'; expect(() => f.review()).toThrow();
    f.password().type = 'password';
    vi.stubGlobal('window', { top: {} });
    expect(() => f.review()).toThrow(); vi.unstubAllGlobals();
    expect(f.gate).not.toHaveBeenCalled();
  });
  it('rechecks the actual form after a synchronous gate and never invokes site submit handlers', () => {
    const f = fixture(); f.review(); f.page.fill('fill');
    const handler = vi.fn(); document.querySelector('form')!.addEventListener('submit', handler);
    f.gate.mockImplementationOnce(() => { document.querySelector('form')!.action = 'https://other.test/post'; return { ok: true }; });
    expect(f.page.submit('submit')).toBe(false); expect(f.submit).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it('does not fill or submit when the host revokes and does not replay a failed submission', () => {
    const f = fixture(); f.review(); f.gate.mockReturnValueOnce({ ok: false });
    expect(f.page.fill('fill')).toBe(false); expect(f.password().value === '').toBe(true);
    const next = fixture(); next.review(); next.page.fill('fill'); next.gate.mockReturnValueOnce({ ok: false });
    expect(next.page.submit('submit')).toBe(false); expect(next.page.submit('retry')).toBe(false);
    expect(next.submit).not.toHaveBeenCalled();
  });
  it('clears filled inputs but does not turn an empty login form into completion', () => {
    const f = fixture(); f.review(); f.page.fill('fill'); expect(f.page.clear()).toBe(true);
    expect(f.password().value === '').toBe(true);
    expect(f.page.completion()).toMatchObject({ filledPasswordFieldsAbsent: false, requiresPersonInteraction: true });
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    expect(f.page.completion()).toMatchObject({ filledPasswordFieldsAbsent: true, requiresPersonInteraction: true });
    document.body.innerHTML = '<p>Finished</p>';
    expect(f.page.completion()).toMatchObject({ filledPasswordFieldsAbsent: true, requiresPersonInteraction: false });
  });
  it('refuses changed credential field values rather than submitting a replacement value', () => {
    const f = fixture(); f.review(); f.page.fill('fill'); f.password().value = randomUUID();
    expect(f.page.submit('submit')).toBe(false); expect(f.submit).not.toHaveBeenCalled();
  });
  it('normalizes a form fragment without broadening the reviewed destination', () => {
    const f = fixture(); document.querySelector('form')!.action = '/session#ignored';
    expect(f.review().destination).toBe('https://example.test/session');
    expect(f.page.fill('fill')).toBe(true); expect(f.page.submit('submit')).toBe(true);
  });
});
