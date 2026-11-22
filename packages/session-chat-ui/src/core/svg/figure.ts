/**
 * The one ```svg fence renderer every surface draws with (chat bubbles, the transcript): an agent's figure becomes an
 * `<img>` of a `data:` SVG. An SVG loaded as an image runs no script and fetches nothing — the browser's own isolation,
 * so no sanitizer is needed. The agent colours with theme tokens (`var(--fg)`, `var(--c1)` …); they are written in as
 * this theme's colours before the image is made, since an image cannot see the page's CSS.
 */

/** Source bytes past this stay a code block. */
export const SVG_FIGURE_MAX_BYTES = 64 * 1024;

export type SvgFigure =
  | { ok: true; src: string; width: number; height: number }
  | { ok: false; reason: 'too-large' | 'invalid' | 'no-viewbox' };

/** Agent-facing token → the host variable it reads (series `c1`…`c6` → `--chart-1`…`--chart-6`). */
const HOST_TOKENS: Record<string, string> = {
  fg: '--text-primary',
  muted: '--text-secondary',
  border: '--border',
  surface: '--bg-secondary',
  accent: '--accent',
  success: '--green',
  warning: '--warn',
  error: '--danger',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`c${n}`, `--chart-${n}`])),
};

/** Calls `onChange` when the host's light/dark truth, `<html data-theme>` (written only by host-theme.ts), flips. */
export function subscribeHostTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** Token → colour as the element the figure is drawn in resolves it now (light or dark). */
export function svgPalette(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  const palette: Record<string, string> = {};
  for (const [token, host] of Object.entries(HOST_TOKENS)) {
    const value = style.getPropertyValue(host).trim();
    if (value) palette[token] = value;
  }
  return palette;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TOKEN = /var\(\s*--([a-z0-9-]+)\s*(?:,[^()]*)?\)/gi;
const PIXEL_LENGTH = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:px)?$/i;

function parsePixelLength(attribute: string | null): number {
  return Number(attribute?.trim().match(PIXEL_LENGTH)?.[1]);
}

/** The margin a drawn diagram gets inside its own background when viewed: pele crops its box to the shapes. */
const DRAWN_MARGIN = 16;

/**
 * A drawn diagram (pele's SVG, which reads `--*` variables) as an image to view: each variable it reads is set on its
 * root to the value `element` resolves now, and it sits on its own background (`--pele-bg`) with a margin, so it reads
 * as a card on the viewer's black. Read when it opens: the inline drawing keeps following the theme, the image does not.
 */
export function drawnSvgImage(svg: string, element: Element): { src: string; width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (root.localName !== 'svg' || box.length !== 4 || !box.every(Number.isFinite) || !(box[2]! > 0) || !(box[3]! > 0)) {
    throw new Error('drawn SVG has no root with a viewBox');
  }
  const [x, y, w, h] = box as [number, number, number, number];
  const width = w + 2 * DRAWN_MARGIN;
  const height = h + 2 * DRAWN_MARGIN;
  root.setAttribute('viewBox', `${x - DRAWN_MARGIN} ${y - DRAWN_MARGIN} ${width} ${height}`);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const style = getComputedStyle(element);
  const svgStyle = (root as unknown as SVGSVGElement).style;
  for (const name of new Set(Array.from(svg.matchAll(/var\(\s*(--[a-z0-9-]+)/gi), (match) => match[1]!))) {
    const value = style.getPropertyValue(name).trim();
    if (value) svgStyle.setProperty(name, value);
  }
  svgStyle.setProperty('background', 'var(--pele-bg)');
  const markup = new XMLSerializer().serializeToString(root);
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, width, height };
}

export function svgFigure(source: string, palette: Record<string, string>): SvgFigure {
  if (new TextEncoder().encode(source).length > SVG_FIGURE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const themed = source
    .replace(TOKEN, (token, name: string) => palette[name.toLowerCase()] ?? token)
    // Agents often leave out the namespace an image document needs; without it the root is not an SVG element.
    .replace(/<svg\b(?![^>]*\sxmlns=)/, `<svg xmlns="${SVG_NS}"`);
  const doc = new DOMParser().parseFromString(themed, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return { ok: false, reason: 'invalid' };
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  let [, , width = NaN, height = NaN] = box;
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n)) || width <= 0 || height <= 0) {
    width = parsePixelLength(root.getAttribute('width'));
    height = parsePixelLength(root.getAttribute('height'));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, reason: 'no-viewbox' };
    }
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  // The image's natural size is its viewBox (1 unit = 1px); the surface scales it down to fit.
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  if (!root.hasAttribute('color') && palette.fg) root.setAttribute('color', palette.fg);
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'sans-serif');
  const markup = new XMLSerializer().serializeToString(root);
  return { ok: true, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, width, height };
}
