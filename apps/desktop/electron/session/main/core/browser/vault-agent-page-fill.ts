import type { WebContents } from 'electron';
import { assertCredentialWebsite } from './credential-website';

/** Its own isolated world in the Agent's page: the page's scripts never see this code or its arguments. */
const FILL_WORLD = 998;

/** What the page calls each input, and which ones hide what is typed: for the person's card, never trusted. */
export type AgentPageReview = Readonly<{ documentId: string; frameId: string; passwordInputs: readonly boolean[]; labels: readonly string[] }>;

/**
 * Runs in the page's isolated world, so it must not refer to anything outside itself. `documentId` names the page's
 * current document: a navigation starts a new isolated world, so a fill can only land on the document reviewed.
 */
function pageScript(op: 'review' | 'fill' | 'present', selectors: string[], values: string[] | undefined, documentId: string | undefined) {
  const fillTypes = ['text', 'email', 'password', 'tel', 'url', 'number'];
  const scope = globalThis as unknown as { __guguFill?: string };
  scope.__guguFill ??= Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (op === 'present') return { documentId: scope.__guguFill, passwordPresent: !!document.querySelector('input[type="password"]') };
  if (window.top !== window || document.readyState === 'loading' || documentId !== undefined && documentId !== scope.__guguFill) return null;
  const visible = (element: Element) => { const style = getComputedStyle(element); return element.getClientRects().length > 0 && style.visibility === 'visible' && style.display !== 'none'; };
  const targets: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    const element = matches[0];
    if (matches.length !== 1 || !(element instanceof HTMLInputElement && fillTypes.includes(element.type) || element instanceof HTMLTextAreaElement)
      || element.disabled || element.readOnly || !visible(element) || targets.includes(element)) return null;
    targets.push(element);
  }
  if (op === 'review') {
    const tidy = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return { documentId: scope.__guguFill, passwordInputs: targets.map(element => element instanceof HTMLInputElement && element.type === 'password'),
      labels: targets.map(element => tidy(element.getAttribute('aria-label')) || tidy(element.labels?.[0]?.textContent)
        || tidy(element.getAttribute('placeholder')) || tidy(element.name) || tidy(element.id)) };
  }
  if (!values || values.length !== targets.length) return null;
  targets.forEach((element, index) => {
    const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
    element.focus();
    setter.call(element, values[index]);
    // Controlled inputs (React and the like) only take a value they hear about.
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  values.fill('');
  return { documentId: scope.__guguFill, filled: true };
}

/**
 * Fills the Agent's own tab, the way a person's autofill would: the inputs get the values, and the Agent goes on (clicks
 * the button, reads the result) with its own browser tools. Nothing is submitted here.
 */
export class AgentPageFill {
  constructor(private readonly contents: WebContents, private readonly origin: string) {
    assertCredentialWebsite(origin, origin);
  }
  /** The page is still on the website and its main document. */
  private assertPage(): void {
    if (this.contents.isDestroyed()) throw new Error('the browser tab was closed');
    assertCredentialWebsite(this.contents.getURL(), this.origin);
  }
  private frameId(): string { return `${this.contents.mainFrame.processId}:${this.contents.mainFrame.routingId}`; }
  private async run<T>(op: 'review' | 'fill' | 'present', selectors: string[], values?: string[], documentId?: string): Promise<T | null> {
    this.assertPage();
    const code = `(${pageScript.toString()})(${JSON.stringify(op)}, ${JSON.stringify(selectors)}, ${values ? JSON.stringify(values) : 'undefined'}, ${documentId ? JSON.stringify(documentId) : 'undefined'})`;
    return await this.contents.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code }]) as T | null;
  }

  async review(fills: readonly string[]): Promise<AgentPageReview> {
    if (!fills.length || fills.length > 16) throw new Error('fill_targets_invalid');
    const value = await this.run<{ documentId: string; passwordInputs: boolean[]; labels: string[] }>('review', [...fills]);
    if (!value || typeof value.documentId !== 'string' || !Array.isArray(value.passwordInputs) || value.passwordInputs.length !== fills.length
      || !Array.isArray(value.labels) || value.labels.length !== fills.length) throw new Error('fill_targets_invalid');
    return Object.freeze({ documentId: value.documentId, frameId: this.frameId(), passwordInputs: Object.freeze([...value.passwordInputs]), labels: Object.freeze([...value.labels]) });
  }

  /** Into the reviewed document only; false when the page has moved on or its inputs changed. */
  async fill(review: AgentPageReview, fills: readonly string[], values: readonly Buffer[]): Promise<boolean> {
    if (this.frameId() !== review.frameId || values.length !== fills.length) return false;
    const text = values.map(value => value.toString('utf8'));
    try { return (await this.run<{ filled: boolean }>('fill', [...fills], text, review.documentId))?.filled === true }
    catch { return false }
    finally { text.fill('') }
  }

  /** Whether the page's current document still has a password input, and which document that is. */
  async passwordPresent(): Promise<{ documentId: string; passwordPresent: boolean } | undefined> {
    try { return (await this.run<{ documentId: string; passwordPresent: boolean }>('present', [])) ?? undefined }
    catch { return undefined }
  }
}
