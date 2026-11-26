/** @jsxImportSource solid-js */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { htmlRenderBlockDef } from '@session-chat/components/rows/markdown/html-render/html-render.def';
import { htmlRenderDocument, keepHtmlRenderPage } from '@session-chat/core/html-render/page';
import type { HtmlRenderBlock } from '@session-chat/core/markdown/document';
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse';
import { makeContractCtx } from '@session-chat/tests/contract';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../tests/support/awaitCondition';

let dispose: (() => void) | undefined;
let root: HTMLDivElement | undefined;
afterEach(() => { dispose?.(); root?.remove(); });

describe('html-render page expand', () => {
  it('opens the page over the window inside the chat root, and closes on Escape and on the close button', async () => {
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
    await until('the page mounts in view', () => root!.querySelectorAll('iframe').length === 1);
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

describe('html-render page scheme', () => {
  it('gives the page and its frame the scheme of the surface it sits on, so the frame stays transparent there', async () => {
    const host = document.documentElement;
    const theme = host.dataset.theme;
    const schemes: string[] = [];
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data?.scheme === 'string') schemes.push(event.data.scheme);
    };
    window.addEventListener('message', onMessage);
    host.dataset.theme = 'dark';
    const source = "```html-render\n<script>parent.postMessage({ scheme: getComputedStyle(document.documentElement).colorScheme }, '*')</script>\n```";
    const block = parseMarkdownToBlocks('t', source)[0] as HtmlRenderBlock;
    const ctx = makeContractCtx({ width: 480 });
    root = document.createElement('div');
    root.style.color = '#f5f5f5'; // a dark surface paints light text; the page's scheme follows that text
    document.body.appendChild(root);
    const Render = htmlRenderBlockDef.Render;
    const unrender = render(() => (
      <ThemeContext.Provider value={() => ctx.theme}>
        <CachesContext.Provider value={ctx.caches}>
          <Render node={htmlRenderBlockDef.measure(block, ctx)} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ), root);
    dispose = () => {
      unrender();
      window.removeEventListener('message', onMessage);
      if (theme === undefined) delete host.dataset.theme;
      else host.dataset.theme = theme;
    };
    await until('the page reports its scheme', () => schemes.length === 1);
    const frame = root.querySelector('iframe')!;
    expect(schemes).toEqual(['dark']);
    expect(getComputedStyle(frame).colorScheme).toBe('dark');

    root.style.color = '#111111';
    host.dataset.theme = 'light';
    await until('the page reloads on a light flip', () => schemes.length === 2);
    expect(schemes).toEqual(['dark', 'light']);
    expect(getComputedStyle(frame).colorScheme).toBe('light');
  });
});

describe('html-render page near the viewport', () => {
  it('mounts the frame only near the viewport, keeps the box height while away, and remounts at the reported height', async () => {
    const source = '```html-render\n<div style="height:300px">bars</div>\n```\n\nafter';
    const blocks = parseMarkdownToBlocks('t', 'before\n\n' + source);
    expect(blocks.map((block) => block.kind)).toEqual(['html', 'html-render', 'html']);
    const block = blocks[1] as HtmlRenderBlock;
    const ctx = makeContractCtx({ width: 480 });
    root = document.createElement('div');
    root.style.cssText = 'position:fixed;top:0;left:0;width:480px;height:400px;overflow:auto';
    const stack = root.appendChild(document.createElement('div'));
    stack.style.cssText = 'position:relative;height:8000px';
    document.body.appendChild(root);
    const Render = htmlRenderBlockDef.Render;
    const [node, setNode] = createSignal(htmlRenderBlockDef.measure(block, ctx));
    dispose = render(() => (
      <ThemeContext.Provider value={() => ctx.theme}>
        <CachesContext.Provider value={ctx.caches}>
          <Render node={node()} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ), stack);
    const frame = () => stack.querySelector('iframe');
    await until('the page reports its height', () => ctx.caches.htmlRenderHeight(block.source) === 316);
    // The row re-measures from the report, as a transcript row does.
    setNode(htmlRenderBlockDef.measure(block, ctx));
    const box = stack.querySelector<HTMLElement>('[data-block-id]')!;
    expect(box.offsetHeight).toBe(316);

    root.scrollTop = 5000;
    await until('the frame unmounts once scrolled away', () => frame() === null);
    expect(box.offsetHeight).toBe(316);

    root.scrollTop = 0;
    await until('the frame mounts again', () => frame() !== null);
    expect(frame()!.getAttribute('height')).toBe('316');
    expect(box.offsetHeight).toBe(316);
  });

  it('opens at the height the fence header declares before the page has reported', () => {
    const block = parseMarkdownToBlocks('t', '```html-render height=420\n<div>bars</div>\n```')[0] as HtmlRenderBlock;
    expect(block.height).toBe(420);
    expect(htmlRenderBlockDef.measure(block, makeContractCtx({ width: 480 })).height).toBe(420);
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

describe('html-render page', () => {
  it('puts a frame that navigated away back on its own page', async () => {
    // Each load says hello, then leaves; a second hello means the frame came back to the page.
    const seen = mountPage(`<script>parent.postMessage({ probe: 'hello' }, '*'); setTimeout(() => { location.href = 'about:blank'; }, 20);</script>`, true);
    await until('the page loads again after leaving', () => seen.filter((m) => m.probe === 'hello').length >= 2);
  });
});

describe('html-render link requests', () => {
  it("ignores the page's own link message without a click or key in the frame, and opens a clicked or entered link", async () => {
    // The page forges the host's link message when it loads and whenever the test asks it to. The gate covers exactly
    // these cases: no activation, or activation from a click elsewhere. Right after a click or key inside the frame the
    // page's script could still post one (activation and focus both hold); that limit is not tested as closed.
    const source = `<a href="https://example.org/clicked">go</a> <a href="https://example.org/keyed">two</a><script>
const forge = () => parent.postMessage({ jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://example.org/forged' } }, '*');
window.addEventListener('load', forge);
window.addEventListener('message', forge);
</script>`;
    const block = parseMarkdownToBlocks('t', '```html-render\n' + source + '\n```')[0] as HtmlRenderBlock;
    const ctx = makeContractCtx({ width: 480 });
    const measured = htmlRenderBlockDef.measure(block, ctx);
    const opened: string[] = [];
    let forged = 0;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.params?.url === 'https://example.org/forged') forged += 1;
    };
    window.addEventListener('message', onMessage);
    // The block is absolutely positioned, as in a block stack: give it its own box so the button below sits outside it.
    root = document.createElement('div');
    const view = document.createElement('div');
    view.style.position = 'relative';
    view.style.height = `${measured.height}px`;
    root.appendChild(view);
    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'elsewhere';
    root.appendChild(elsewhere);
    document.body.appendChild(root);
    const Render = htmlRenderBlockDef.Render;
    const unmount = render(() => (
      <ThemeContext.Provider value={() => ctx.theme}>
        <CachesContext.Provider value={ctx.caches}>
          <CommandsContext.Provider value={() => ({ onOpenLink: (url: string) => { opened.push(url); return true; } })}>
            <Render node={measured} />
          </CommandsContext.Provider>
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ), view);
    dispose = () => {
      unmount();
      window.removeEventListener('message', onMessage);
    };

    // Unprompted, on load.
    await until('the page forges on load', () => forged === 1);
    expect(opened).toEqual([]);

    // Right after a real click elsewhere in the app: the window is activated, but the frame does not have focus.
    await page.getByText('elsewhere').click();
    expect(navigator.userActivation.isActive).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
    view.querySelector('iframe')!.contentWindow!.postMessage('forge', '*');
    await until('the page forges after the click elsewhere', () => forged === 2);
    expect(opened).toEqual([]);

    // A real click on a link in the frame.
    const frame = page.frameLocator(page.getByTitle('Rendered page'));
    await frame.getByText('go').click();
    await until('the clicked link opens', () => opened.length === 1);
    // Enter on the next link, focused from the keyboard.
    await userEvent.keyboard('{Tab}');
    await userEvent.keyboard('{Enter}');
    await until('the keyed link opens', () => opened.length === 2);
    expect(opened).toEqual(['https://example.org/clicked', 'https://example.org/keyed']);
  });
});
