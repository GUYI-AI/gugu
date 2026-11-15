/** @jsxImportSource solid-js */
import { FILE_ROW_GLYPHS } from '@gugu/session-shared/file-row';

/**
 * Image-unavailable icon shown when an attachment image cannot be resolved
 * (for example, after reload when inline bytes were not replayed).
 */
export function ImageOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {FILE_ROW_GLYPHS.imageOff.map(d => <path d={d} />)}
    </svg>
  );
}
