/** Coordinates normalized to the picture the person selected, independent of zoom or screen density. */
export type BrowserAnnotationQuery = { x: number; y: number; width: number; height: number };
export type BrowserAnnotationTarget = {
  url: string;
  selector: string | null;
  targetPath: string | null;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  text: string;
};
export type BrowserAnnotationInspection = { target: BrowserAnnotationTarget; screenshot?: string };

export function isBrowserAnnotationQuery(value: unknown): value is BrowserAnnotationQuery {
  if (!value || typeof value !== 'object') return false;
  const query = value as BrowserAnnotationQuery;
  return [query.x, query.y, query.width, query.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
    && query.x + query.width <= 1.001 && query.y + query.height <= 1.001;
}

/** Runs in the selected page. It reads DOM evidence only and never acts on that evidence. */
function inspectTarget(query: BrowserAnnotationQuery): BrowserAnnotationTarget {
  const viewport = { width: innerWidth, height: innerHeight, scrollX, scrollY };
  const region = query.width > 0 || query.height > 0;
  let rect = { x: query.x * innerWidth, y: query.y * innerHeight, width: query.width * innerWidth, height: query.height * innerHeight };
  const element = document.elementFromPoint(rect.x, rect.y);
  if (!element) throw new Error('The selected page element is unavailable');
  const parts: string[] = [];
  const names: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    names.unshift(current.tagName.toLowerCase() + (current.id ? `#${current.id}` : ''));
    if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
    const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(sibling => sibling.tagName === current.tagName) : [current];
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
  }
  let text: string;
  if (region) {
    const selected: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim() || node.parentElement?.closest('script, style, noscript') || !node.parentElement?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (Array.from(range.getClientRects()).some(box => box.right > rect.x && box.left < rect.x + rect.width && box.bottom > rect.y && box.top < rect.y + rect.height)) selected.push(node.textContent);
    }
    text = selected.join('\n');
  } else {
    const box = element.getBoundingClientRect();
    rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    text = (element as HTMLElement).innerText ?? element.textContent ?? '';
  }
  return { url: location.href, selector: region ? null : parts.join(' > '), targetPath: region ? null : names.join(' > '), rect, viewport, text };
}

export function browserAnnotationScript(query: BrowserAnnotationQuery): string {
  if (!isBrowserAnnotationQuery(query)) throw new Error('Invalid page selection');
  return `(${inspectTarget.toString()})(${JSON.stringify(query)})`;
}
