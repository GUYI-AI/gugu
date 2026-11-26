/**
 * A web link's words led by its site's icon, so a reader sees where a link goes before following it. A rehype pass a
 * chat surface adds after the sanitizer (the transcript and chat-trust `Markdown`), so both draw the same mark; a
 * document page (`documentToHtml`) loads nothing on render and keeps its links plain.
 *
 * Ported from T3 Code `apps/web/src/components/chat/MarkdownExternalLink.tsx` and `packages/shared/src/favicon.ts`
 * (https://github.com/pingdotgg/t3code, MIT):
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The icon is the site's own `/favicon.ico`; a host that is not a public name (an IP, localhost, a private suffix) gets
 * the globe without a request. Changed: the icon stays on the line of the link's first letters; GitHub is its mark
 * drawn in the link's colour (markdown.css), no request, so it reads on a light or dark bubble alike. Dropped:
 * source-control brand icons, T3's IP-range classification (an IP literal simply gets the globe).
 */

import { parseGuguLink } from '@gugu/core/shared/ui/guguLink';
import type { Element, ElementContent, Root } from 'hast';

export const LINK_ICON_CLASS = 'gg-md-link-icon';

const PRIVATE_SUFFIXES = ['.alt', '.corp', '.example', '.home', '.internal', '.intranet', '.invalid', '.lan', '.local', '.localdomain', '.localhost', '.onion', '.private', '.test', '.home.arpa', '.ts.net'];

/** Hosts whose mark markdown.css draws in the link's colour (`data-mark`), in place of a fetched icon. */
const MARK_BY_HOSTNAME: Readonly<Record<string, string>> = { 'github.com': 'github' };

function hostName(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

/** The site icon to ask for, or null when the host is not a public name (no request leaves for it). */
export function faviconUrlForHost(host: string): string | null {
  const name = hostName(host);
  if (!name.includes('.') || /^[\d.]+$/.test(name) || name.includes(':') || name.startsWith('[')) return null;
  if (PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return null;
  return `https://${name}/favicon.ico`;
}

function webHost(href: unknown): string | null {
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href) || parseGuguLink(href)) return null;
  try {
    return new URL(href).hostname || null;
  } catch {
    return null;
  }
}

function leadingTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  // A whole code point, so a surrogate pair is not split across elements.
  return Array.from(text.slice(0, 2))[0]?.length ?? 0;
}

function icon(host: string): Element {
  const mark = MARK_BY_HOSTNAME[hostName(host)];
  if (mark) return { type: 'element', tagName: 'span', properties: { className: [LINK_ICON_CLASS], ariaHidden: 'true', dataMark: mark }, children: [] };
  const src = faviconUrlForHost(host);
  return {
    type: 'element',
    tagName: 'span',
    // No public name: the globe at once (markdown.css draws it for a failed icon too).
    properties: { className: [LINK_ICON_CLASS], ariaHidden: 'true', ...(src ? {} : { dataFailed: '' }) },
    children: src
      ? [{ type: 'element', tagName: 'img', properties: { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', draggable: 'false', dataLinkIcon: '' }, children: [] }]
      : [],
  };
}

function lead(link: Element, host: string): void {
  const [first, ...rest] = link.children;
  const children: ElementContent[] = [icon(host)];
  const after: ElementContent[] = [];
  if (first?.type === 'text' && first.value) {
    const at = leadingTextLength(first.value);
    children.push({ type: 'text', value: first.value.slice(0, at) });
    if (first.value.length > at) after.push({ type: 'text', value: first.value.slice(at) });
  } else if (first) {
    after.push(first);
  }
  link.children = [{ type: 'element', tagName: 'span', properties: { className: ['gg-md-link-lead'] }, children }, ...after, ...rest];
}

export function rehypeLinkIcons() {
  return (tree: Root) => mark(tree);
}

function mark(parent: Root | Element): void {
  for (const node of parent.children) {
    if (node.type !== 'element') continue;
    const host = node.tagName === 'a' ? webHost(node.properties?.href) : null;
    if (host) {
      lead(node, host);
      continue;
    }
    mark(node);
  }
}

let fallbackHooked = false;

/**
 * A site icon that cannot load becomes the globe. Error events do not bubble, so one capturing listener on the document
 * serves every renderer; installed once, on first use, for the page's life.
 */
export function hookLinkIconFallback(): void {
  if (fallbackHooked) return;
  fallbackHooked = true;
  document.addEventListener('error', (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.parentElement?.classList.contains(LINK_ICON_CLASS)) target.parentElement.dataset.failed = '';
  }, true);
}
