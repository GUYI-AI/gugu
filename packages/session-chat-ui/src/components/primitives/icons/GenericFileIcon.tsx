/** @jsxImportSource solid-js */
import { FILE_ROW_GLYPHS } from '@gugu/session-shared/file-row';
import { genericFileIcon } from '../icons.css';

/**
 * Fallback generic-file icon for when no file-type-specific icon is available.
 * Renders at 14x14 with muted color and no flex shrink.
 */
export function GenericFileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={genericFileIcon}
    >
      {FILE_ROW_GLYPHS.file.map(d => <path d={d} />)}
    </svg>
  );
}
