import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import css from '../../../../../preinstalled-apps/workspace/style.css?raw';
import ui from '../../../app-runtime/ui/ui.css?raw';
import tokens from '@/styles/tokens.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { until } from '../../../../../../../tests/support/awaitCondition';

let frame: HTMLIFrameElement | null = null;
afterEach(() => { frame?.remove(); frame = null; });
const no = async () => undefined;
const off = () => () => undefined;

for (const theme of ['light', 'dark'] as const) {
  for (const width of [360, 390, 1280]) it(`the shipped JSON editor has readable ${theme} syntax at ${width}px`, async ({ annotate }) => {
    await page.viewport(width, 844);
    frame = document.body.appendChild(document.createElement('iframe'));
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
    const doc = frame.contentDocument!;
    doc.open(); doc.write(html.replace(/<link[^>]*>|<script[^>]*>[\s\S]*?<\/script>/g, '')); doc.close();
    doc.documentElement.dataset.guguTheme = theme;
    const style = doc.createElement('style');
    style.textContent = appPaletteCss(tokens) + ui + css;
    doc.head.append(style);
    const entry = { id: 'controlled-json', chat: 'controlled-chat', name: '项目配置.json', displayName: '项目配置.json', path: '项目配置.json', parentId: null, type: 'json', contentType: 'application/json', size: 256, version: 1, createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [], keep: { expiresAt: null, mine: true } };
    const data = { name: '实验记录', reviewed: true, count: 24 };
    const transact = vi.fn();
    const errors: string[] = [];
    const guest = frame.contentWindow!;
    guest.addEventListener('error', event => errors.push(event.message));
    Object.assign(guest, { __vitest_browser_runner__: (window as any).__vitest_browser_runner__, gugu: {
      getContext: async () => ({ locale: 'zh-CN', themeMode: theme, tabId: 'json-test', chat: { id: entry.chat, name: '受控群聊', kind: 'group' }, file: entry, capabilities: ['files:read', 'files:write'] }),
      onContextChanged: off, onLink: off, onCommand: off, setTabTitle: no, setTabDirty: no, setViewState: no,
      reportError: async (message: string) => { errors.push(message); },
      files: {
        viewPreferences: async () => ({ showAppData: false }), onChanged: off, list: async () => [entry], versions: async () => [], draft: async () => null,
        open: async () => ({ entry, type: 'json', readOnly: false, status: 'online', toJSON: () => data, data, transact, onChange: off, onStatus: off, close: no, presence: { self: { userId: 'controlled-user', color: '' }, others: [], onChange: off, set: no } }),
      },
    } });
    const script = doc.createElement('script'); script.type = 'module';
    script.src = '/apps/desktop/src/session/renderer/tests/browser/workspace-json-contrast-2851-guest.ts'; doc.head.append(script);
    const syntax = () => [...doc.querySelectorAll<HTMLElement>('.cm-line span')];
    await until('real JSON editor paints tokens', () => errors.length > 0 || syntax().some(node => node.textContent === '"实验记录"'));
    expect(errors).toEqual([]);
    const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
    const painter = canvas.getContext('2d')!;
    const rgba = (color: string) => { painter.clearRect(0, 0, 1, 1); painter.fillStyle = color; painter.fillRect(0, 0, 1, 1); return [...painter.getImageData(0, 0, 1, 1).data]; };
    const luma = (color: number[]) => color.slice(0, 3).reduce((sum, value, index) => { const c = value / 255; return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]; }, 0);
    const readings = [];
    for (const text of ['"实验记录"', 'true', '24', '"name"']) {
      let node = syntax().find(node => node.textContent === text);
      if (!node) {
        // Unstyled tokens are text nodes. Read their real parent's inherited colour as well.
        const walker = doc.createTreeWalker(doc.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
        for (let at = walker.nextNode(); at; at = walker.nextNode()) {
          if (at.textContent?.includes(text)) { node = at.parentElement ?? undefined; break; }
        }
      }
      expect(node, `real syntax token ${text}`).toBeTruthy();
      let parent: Element | null = node!;
      let bg: number[] | null = null;
      while (parent) { const value = rgba(guest.getComputedStyle(parent).backgroundColor); if (value[3] === 255) { bg = value; break; } parent = parent.parentElement; }
      expect(bg, 'the actual App paints an opaque background').not.toBeNull();
      const fg = rgba(guest.getComputedStyle(node!).color);
      const contrast = (Math.max(luma(fg), luma(bg!)) + .05) / (Math.min(luma(fg), luma(bg!)) + .05);
      readings.push({ text, fg, bg, contrast });
    }
    expect(transact).not.toHaveBeenCalled();
    await annotate(JSON.stringify({ theme, width, readings }), 'JSON syntax contrast');
    await page.screenshot({ path: `__screenshots__/ui2851-json/${theme}-${width}.png` });
    for (const reading of readings) expect(reading.contrast, `${theme} ${reading.text}`).toBeGreaterThanOrEqual(4.5);
  });
}
