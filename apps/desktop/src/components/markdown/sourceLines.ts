import type { Element, Root, RootContent } from 'hast'

/** Source positions belong to the parsed document, before display-only markup and highlighting. */
export function rehypeSourceLines(options: { lineOf: (line: number) => number; source: string }) {
  return (tree: Root) => {
    const lines = options.source.split(/\r?\n/)
    function mark(parent: Root | Element) {
      parent.children = parent.children.map((node): RootContent => {
        if (node.type === 'text' && node.position) {
          return {
            type: 'element', tagName: 'span',
            properties: { 'data-file-source-start': options.lineOf(node.position.start.line), 'data-file-source-end': options.lineOf(node.position.end.line) },
            children: [node],
          }
        }
        if (node.type === 'element') {
          if ((node.tagName === 'pre' || node.tagName === 'code') && node.position) {
            const { start, end } = node.position
            const fence = /^(`{3,}|~{3,})/.exec(lines[start.line - 1]?.slice(start.column - 1) ?? '')?.[1]
            const closed = fence && (lines[end.line - 1]?.trim().startsWith(fence) ?? false)
            // Streamdown replaces code elements with its highlighter and does not forward their attributes.
            return {
              type: 'element', tagName: node.tagName === 'pre' ? 'div' : 'span',
              properties: { 'data-file-source-start': options.lineOf(start.line + (fence ? 1 : 0)), 'data-file-source-end': options.lineOf(end.line - (closed ? 1 : 0)), ...(node.tagName === 'pre' ? { 'data-file-source-code': true } : {}) },
              children: [node],
            }
          }
          if (node.position) {
            node.properties['data-file-source-start'] = options.lineOf(node.position.start.line)
            node.properties['data-file-source-end'] = options.lineOf(node.position.end.line)
          }
          // Code and math renderers consume their raw text; wrapping their children would change that input.
          if (!String(node.properties.className).includes('math')) mark(node)
        }
        return node
      }) as typeof parent.children
    }
    mark(tree)
  }
}
