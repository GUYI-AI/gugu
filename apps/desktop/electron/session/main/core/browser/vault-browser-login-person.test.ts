// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/otp"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createVaultPersonSubmission } from './vault-browser-login-person';
import type { VaultLoginGateAnswer, VaultLoginGateRequest } from './vault-browser-login-protocol';

beforeEach(() => vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList));
afterEach(() => vi.restoreAllMocks());
function fixture(eligible = true) {
  document.body.innerHTML = '<form method="post" action="/challenge"><input name="otp" autocomplete="one-time-code"><button>Verify</button></form>';
  const form = document.querySelector('form')!, input = document.querySelector('input')!, button = document.querySelector('button')!;
  input.value = randomUUID();
  const native = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  const gate = vi.fn((_request: VaultLoginGateRequest): VaultLoginGateAnswer => ({ ok: true }));
  const handler = createVaultPersonSubmission(gate, 'new-document', () => eligible);
  const gesture = (trusted = true) => handler.onGesture({ isTrusted: trusted, target: input, type: 'keydown', key: 'Enter' } as unknown as KeyboardEvent);
  const submit = (trusted = true) => handler.onSubmit({ isTrusted: trusted, target: form, submitter: button, preventDefault() {}, stopImmediatePropagation() {} } as unknown as SubmitEvent);
  return { form, input, native, gate, gesture, submit };
}
describe('private native OTP continuation', () => {
  it('allows one native gesture on a plain new-document OTP form without spending a password lease', () => {
    const f = fixture(); f.gesture(); f.submit(); f.gesture(); f.submit();
    expect(f.native).toHaveBeenCalledTimes(1); expect(f.gate).toHaveBeenCalledTimes(1);
    expect(f.gate.mock.calls[0][0]).toMatchObject({ phase: 'person-submit', destination: 'https://example.test/challenge' });
  });
  it('does not trust script clicks or a UA submit event without a native gesture', () => {
    const f = fixture(); f.submit(); f.gesture(false); f.submit(); f.gesture(); f.submit(false);
    expect(f.native).not.toHaveBeenCalled(); expect(f.gate).not.toHaveBeenCalled();
  });
  it('expires the gesture after the current input event task', async () => {
    const f = fixture(); f.gesture(); await new Promise(resolve => setTimeout(resolve, 0)); f.submit();
    expect(f.native).not.toHaveBeenCalled();
  });
  it.each(['http://example.test/challenge', 'https://sub.example.test/challenge', 'https://example.test:8443/challenge'])('rejects changed action %s', action => {
    const f = fixture(); f.gesture(); f.form.action = action; f.submit();
    expect(f.native).not.toHaveBeenCalled(); expect(f.gate).not.toHaveBeenCalled();
  });
  it('rejects hidden replay fields, password inputs, and the old reviewed document', () => {
    for (const html of ['<input type="hidden" name="previous">', '<input type="password" name="previous" value="">']) {
      const f = fixture(); f.form.insertAdjacentHTML('beforeend', html); f.gesture(); f.submit();
      expect(f.native).not.toHaveBeenCalled();
    }
    const f = fixture(false); f.gesture(); f.submit(); expect(f.gate).not.toHaveBeenCalled();
  });
  it('remembers a password field after it is removed and does not retry a denied continuation', async () => {
    const f = fixture(); f.form.insertAdjacentHTML('beforeend', '<input type="password">'); await Promise.resolve();
    f.form.querySelector('input[type=password]')!.remove(); f.gesture(); f.submit(); expect(f.native).not.toHaveBeenCalled();
    const next = fixture(); next.gate.mockReturnValue({ ok: false }); next.gesture(); next.submit(); next.gesture(); next.submit();
    expect(next.gate).toHaveBeenCalledTimes(1); expect(next.native).not.toHaveBeenCalled();
  });
  it('rejects a password field inserted and removed before mutation callbacks run', () => {
    const f = fixture(); f.gesture(); f.form.insertAdjacentHTML('beforeend', '<input type="password">');
    f.form.querySelector('input[type=password]')!.remove(); f.submit(); expect(f.gate).not.toHaveBeenCalled();
  });
  it('latches a password removed from a transient wrapper in the same turn', () => {
    const f = fixture();
    const wrapper = document.createElement('div'); wrapper.innerHTML = '<input type="password">';
    document.body.appendChild(wrapper); wrapper.firstElementChild!.remove(); wrapper.remove();
    f.gesture(); f.submit();
    expect(f.gate).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  });
  it('rejects transparent OTP inputs and transparent rendered ancestors', () => {
    for (const target of ['input', 'form', 'slot']) {
      const f = fixture();
      if (target === 'slot') {
        const host = document.createElement('span'); f.form.prepend(host); host.appendChild(f.input);
        host.attachShadow({ mode: 'open' }).innerHTML = '<slot style="opacity:0"></slot>';
      } else (target === 'input' ? f.input : f.form).style.opacity = '0';
      f.gesture(); f.submit();
      expect(f.gate).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
    }
  });
});
