import { assertCredentialWebsite } from './credential-website';
import type { VaultLoginGateAnswer, VaultLoginGateRequest, VaultLoginReview, VaultLoginSelection } from './vault-browser-login-protocol';
import { createVaultPersonSubmission } from './vault-browser-login-person';

/** Runs ONLY in the private preload world. No page-world API or secret-bearing result. */
export function createVaultLoginPage(gate: (request: VaultLoginGateRequest) => VaultLoginGateAnswer) {
  // getRandomValues also works in the initial about:blank document; randomUUID need not.
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  const documentId = id();
  let reviewed: ReturnType<typeof inspect> | undefined;
  let fingerprint = '';
  let expectedOrigin = '';
  let signature = '';
  let filled = false;
  let submitted = false;
  let filledValues: { account: string; password: string } | undefined;
  const nativeSubmit = HTMLFormElement.prototype.submit;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  const fail = (): never => { throw new Error('credential_login_unavailable'); };
  const one = (selector: string): Element => {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) return fail();
    return matches[0];
  };
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility === 'visible' && style.display !== 'none';
  };
  function inspect(selection: VaultLoginSelection, origin: string) {
    if (window.top !== window || document.readyState === 'loading') return fail();
    assertCredentialWebsite(location.href, origin);
    const form = one(selection.form), account = one(selection.account), password = one(selection.password);
    const submitter = selection.submitter ? one(selection.submitter) : null;
    if (!(form instanceof HTMLFormElement) || !(account instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)
      || account === password || !['text', 'email'].includes(account.type) || password.type !== 'password'
      || account.form !== form || password.form !== form || !account.name || !password.name || account.name === password.name
      || account.disabled || password.disabled || account.readOnly || password.readOnly || !visible(account) || !visible(password)) return fail();
    if (submitter && (!(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement)
      || submitter.type !== 'submit' || submitter.form !== form || submitter.disabled)) return fail();
    const button = submitter as HTMLButtonElement | HTMLInputElement | null;
    const destinationUrl = new URL(button?.hasAttribute('formaction') ? button.formAction : form.action);
    destinationUrl.hash = '';
    const destination = destinationUrl.href;
    const method = button?.hasAttribute('formmethod') ? button.formMethod : form.method;
    const target = button?.hasAttribute('formtarget') ? button.formTarget : form.target;
    const enctype = button?.hasAttribute('formenctype') ? button.formEnctype : form.enctype;
    assertCredentialWebsite(destination, origin);
    if (method.toLowerCase() !== 'post' || target && target !== '_self'
      || !['application/x-www-form-urlencoded', 'multipart/form-data'].includes(enctype)) return fail();
    const elements = Array.from(form.elements);
    if (elements.filter(element => element instanceof HTMLInputElement && element.type === 'password').length !== 1
      || elements.some(element => element instanceof HTMLInputElement && element.type === 'file' && !element.disabled)) return fail();
    // Values of the two credential fields never participate in this private structural check.
    const structure = JSON.stringify([location.href, document.baseURI, destination, method, target, enctype,
      elements.map(element => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLButtonElement
          || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return fail();
        return [element.tagName, element.id, element.name, element.type, element.disabled,
          element === account || element === password ? null : element.value,
          element.getAttribute('formaction'), element.getAttribute('formmethod'), element.getAttribute('formtarget')];
      })]);
    return { selection, form, account, password, button, destination, method, target, enctype, elements, structure };
  }
  function current() {
    if (!reviewed) return fail();
    const actual = inspect(reviewed.selection, expectedOrigin);
    if (actual.form !== reviewed.form || actual.account !== reviewed.account || actual.password !== reviewed.password
      || actual.button !== reviewed.button || actual.structure !== signature
      || actual.elements.some((element, index) => element !== reviewed!.elements[index])) return fail();
    return actual;
  }
  // Password form clicks/Enter never spend the host capability. A new document may admit a native OTP gesture.
  const person = createVaultPersonSubmission(gate, documentId, () => !reviewed && !filled && !submitted);
  document.addEventListener('click', person.onGesture, true);
  document.addEventListener('keydown', person.onGesture, true);
  document.addEventListener('submit', person.onSubmit, true);
  return Object.freeze({
    review(selection: VaultLoginSelection, origin: string): VaultLoginReview {
      if (filled || submitted) return fail();
      reviewed = inspect(selection, origin); expectedOrigin = origin; signature = reviewed.structure;
      fingerprint = id();
      return { documentId, formFingerprint: fingerprint, destination: reviewed.destination };
    },
    fill(nonce: string): boolean {
      try {
        if (filled || submitted) return false;
        const actual = current();
        const answer = gate({ nonce, phase: 'fill', documentId, formFingerprint: fingerprint, destination: actual.destination });
        if (!answer.ok || typeof answer.account !== 'string' || typeof answer.password !== 'string') return false;
        current(); // The synchronous host round trip cannot substitute for the page's final check.
        filled = true;
        setValue.call(actual.account, answer.account); setValue.call(actual.password, answer.password);
        filledValues = { account: answer.account, password: answer.password };
        answer.account = ''; answer.password = '';
        return true;
      } catch { return false; }
    },
    submit(nonce: string): boolean {
      try {
        if (!filled || submitted) return false;
        const actual = current();
        if (!filledValues || actual.account.value !== filledValues.account || actual.password.value !== filledValues.password) return false;
        // Burn before the gate/side effect, including every failure after this point.
        submitted = true;
        if (!gate({ nonce, phase: 'submit', documentId, formFingerprint: fingerprint, destination: actual.destination }).ok) return false;
        current();
        if (actual.account.value !== filledValues.account || actual.password.value !== filledValues.password) return false;
        // Invoke isolated-world native submit, without site submit handlers changing the checked destination.
        actual.form.action = actual.destination; actual.form.method = actual.method;
        actual.form.target = '_self'; actual.form.enctype = actual.enctype;
        if (actual.button?.name) {
          const field = document.createElement('input'); field.type = 'hidden';
          field.name = actual.button.name; field.value = actual.button.value; actual.form.appendChild(field);
        }
        nativeSubmit.call(actual.form);
        return true;
      } catch { return false; } finally { filledValues = undefined; }
    },
    clear(): boolean {
      filledValues = undefined;
      try {
        if (reviewed) {
          setValue.call(reviewed.account, ''); setValue.call(reviewed.password, '');
          if (reviewed.account.value !== '' || reviewed.password.value !== '') return false;
        }
        return true;
      } catch { return false; }
    },
    completion() {
      const passwordPresent = !!document.querySelector('input[type="password"]');
      const person = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]')).some(visible);
      return { documentId, filledPasswordFieldsAbsent: !passwordPresent,
        requiresPersonInteraction: person || passwordPresent };
    },
  });
}
