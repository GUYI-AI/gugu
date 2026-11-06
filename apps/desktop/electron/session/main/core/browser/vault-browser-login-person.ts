import { assertCredentialWebsite } from './credential-website';
import type { VaultLoginGateAnswer, VaultLoginGateRequest } from './vault-browser-login-protocol';

/** Private-world continuation for a plain OTP form on a NEW document, never a password retry. */
export function createVaultPersonSubmission(gate: (request: VaultLoginGateRequest) => VaultLoginGateAnswer,
  documentId: string, eligible: () => boolean) {
  const nativeSubmit = HTMLFormElement.prototype.submit;
  const Input = HTMLInputElement, ElementClass = Element;
  let passwordSeen = false, submitted = false;
  let gesture: HTMLFormElement | undefined;
  const containsPassword = (root: ParentNode) => Array.from(root.querySelectorAll('input')).some(input => input.type === 'password');
  passwordSeen = containsPassword(document);
  const passwordNode = (node: Node) => node instanceof Input && node.type === 'password'
    || node instanceof ElementClass && containsPassword(node);
  const recordPasswords = (records: MutationRecord[]) => {
    passwordSeen ||= records.some(record => record.type === 'attributes' && record.oldValue?.toLowerCase() === 'password'
      || Array.from(record.addedNodes).some(passwordNode) || Array.from(record.removedNodes).some(passwordNode)
      || passwordNode(record.target));
  };
  const observer = new MutationObserver(recordPasswords);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  const fail = (): never => { throw new Error('credential_login_unavailable'); };
  function inspect(form: EventTarget | null, spent = false) {
    recordPasswords(observer.takeRecords()); // Include insert/remove/type changes from this same event turn.
    passwordSeen ||= containsPassword(document);
    if (!eligible() || submitted && !spent || passwordSeen || window.top !== window || !(form instanceof HTMLFormElement)) return fail();
    // Hidden fields could contain a replayed password. Only one explicit OTP field and plain buttons qualify.
    const elements = Array.from(form.elements);
    const inputs = elements.filter(element => element instanceof HTMLInputElement);
    const input = inputs[0];
    if (inputs.length !== 1 || !(input instanceof HTMLInputElement) || input.autocomplete !== 'one-time-code'
      || !['text', 'tel', 'number'].includes(input.type) || input.disabled || input.readOnly || !input.name
      || elements.some(element => element !== input && (!(element instanceof HTMLButtonElement)
        || element.type !== 'submit' || !!element.name || element.hasAttribute('formaction') || element.hasAttribute('formmethod')
        || element.hasAttribute('formtarget') || element.hasAttribute('formenctype')))) return fail();
    if (!input.getClientRects().length) return fail();
    // Require an opaque input through its rendered ancestor chain, including slots and shadow hosts.
    for (let element: Element | null = input; element;) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity || '1') !== 1) return fail();
      const root = element.getRootNode();
      element = element.assignedSlot ?? element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    const destination = new URL(form.action); destination.hash = '';
    assertCredentialWebsite(location.href, location.origin); assertCredentialWebsite(destination.href, location.origin);
    if (form.method !== 'post' || form.target && form.target !== '_self'
      || form.enctype !== 'application/x-www-form-urlencoded') return fail();
    return { form, input, destination: destination.href };
  }
  function onGesture(event: MouseEvent | KeyboardEvent) {
    gesture = undefined;
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target.closest('button, input');
    try {
      const form = target instanceof HTMLInputElement || target instanceof HTMLButtonElement ? target.form : null;
      const actual = inspect(form);
      if (event.type === 'click' && target instanceof HTMLButtonElement && target.type === 'submit'
        || event.type === 'keydown' && (event as KeyboardEvent).key === 'Enter' && target === actual.input) gesture = actual.form;
    } catch { /* Unsupported challenges remain isolated. */ }
    // A native event's default submit may run after listener microtasks. Expire at the next task.
    setTimeout(() => { gesture = undefined; }, 0);
  }
  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const nativeGesture = gesture; gesture = undefined;
    if (!event.isTrusted || !nativeGesture || nativeGesture !== event.target) return;
    try {
      const actual = inspect(event.target);
      if (!actual.input.value || event.submitter && (!(event.submitter instanceof HTMLButtonElement) || event.submitter.form !== actual.form)) return;
      submitted = true;
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (!gate({ nonce, phase: 'person-submit', documentId, formFingerprint: nonce, destination: actual.destination }).ok) return;
      // Recheck without reopening the spent continuation.
      const current = inspect(event.target, true);
      if (current.form !== actual.form || current.input !== actual.input || current.destination !== actual.destination) return;
      actual.form.action = actual.destination; actual.form.target = '_self';
      event.stopImmediatePropagation(); nativeSubmit.call(actual.form);
    } catch { submitted = true; }
  }
  return { onGesture, onSubmit };
}
