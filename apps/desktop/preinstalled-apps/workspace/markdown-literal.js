// A file's name inside markdown (an inserted link's words, an image's alt, the link a tool hands an agent) that reads
// back as exactly that name.
// A copy of the host's `markdownLiteral` (packages/core/src/shared/markdownLiteral.ts): an App page loads only its own
// files and what `gugu.*` hands it, and the bridge does not carry this function. The two are pinned equal by
// tests/unit/desktop/preinstalledApps/workspaceMarkdownLiteral.test.ts.
// `[`, `]` and `$` are character references, not backslash escapes: `\[…\]` and `$…$` are math in gugu's markdown.
const REFERENCED = { '[': '&#91;', ']': '&#93;', $: '&#36;' }

export function markdownLiteral(text) {
  return text.replace(/[\\`*_~<>#|&]/g, '\\$&').replace(/[[\]$]/g, (char) => REFERENCED[char])
}
