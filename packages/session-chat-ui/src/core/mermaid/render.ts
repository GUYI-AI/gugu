/**
 * The one mermaid renderer every surface draws with: transcript blocks and their viewer, documents, and the App
 * runtime's `gugu.markdown()`. Pele, each diagram type loaded on first use. The SVG takes its colours and fonts from the
 * `--pele-*` variables each surface maps to its theme, so one drawing serves light and dark. Pele escapes the text and
 * filters styles; links and images are off, so a diagram fetches and opens nothing. The result is an SVG string.
 */
import { renderAsync } from 'pele/lazy';

/** Rejects when pele cannot draw the source, or when `signal` aborted first. */
export async function renderMermaidDiagram(chart: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Text is measured in the face the diagram is drawn in, as pele's own mount() reads it.
  const root = getComputedStyle(document.documentElement);
  const font = (name: string) => root.getPropertyValue(name).trim() || undefined;
  const { svg } = await renderAsync(chart, {
    fontFamily: font('--pele-font'),
    fontFamilyMono: font('--pele-font-mono'),
    links: false,
    images: false,
    // No inline size: each surface's own CSS fits the SVG into its box.
    responsive: false,
  });
  return svg;
}
