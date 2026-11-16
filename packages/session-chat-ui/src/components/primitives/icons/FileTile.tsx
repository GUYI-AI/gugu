/** @jsxImportSource solid-js */
import { fileTile } from '@gugu/session-shared/file-marks';
import '@gugu/session-shared/file-tile.css';

/** A file's tile (`file-tile.css`) at the size its box gives it: the output cards' 40px square. */
export function FileTile(props: { name: string; mime?: string; class?: string }) {
  const tile = () => fileTile(props.name, props.mime);
  return (
    <span class={`gg-file-tile ${props.class ?? ''}`} style={{ '--gg-file-tile': tile().color }} aria-hidden="true">
      <svg class="gg-file-tile-glyph" viewBox="0 0 24 24" innerHTML={tile().glyph} />
      <span class="gg-file-tile-label">{tile().label}</span>
    </span>
  );
}
