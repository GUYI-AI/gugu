/** Slices a UTF-16 range, moving split surrogate boundaries inward to preserve its budget. */
export function sliceWholeCharacters(text: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start += 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return text.slice(start, end);
}
