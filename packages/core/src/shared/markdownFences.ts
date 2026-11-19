/** Marks fenced code lines, including delimiters, without changing line positions. */
export function fencedLineMask(text: string): boolean[] {
  let fence: { marker: string; length: number } | null = null;
  return text.split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
        fence = null;
      }
      return true;
    }
    // Backticks in an info string identify an inline code span, not a fence.
    if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
      fence = { marker: match[1][0], length: match[1].length };
      return true;
    }
    return false;
  });
}
