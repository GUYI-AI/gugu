/** @jsxImportSource solid-js */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { htmlRenderBlockDef } from '@session-chat/components/rows/markdown/html-render/html-render.def';
import type { HtmlRenderBlock } from '@session-chat/core/markdown/document';
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse';
import { makeContractCtx } from '@session-chat/tests/contract';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';

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
