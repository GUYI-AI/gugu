/** @jsxImportSource solid-js */
import { FILE_ICON_VIEWBOX, fileMark } from '@gugu/session-shared/file-marks';
import '@gugu/session-shared/file-tile.css';

/** A file's tile (`file-tile.css`) at the size its box gives it: the output cards' 40px square. */
export function FileTile(props: { name: string; mime?: string; class?: string }) {
  const mark = () => fileMark(props.name, props.mime);
  return (
    <span class={`gg-file-tile ${props.class ?? ''}`} style={{ '--gg-file-tile': mark().color }} aria-hidden="true">
      <svg class="gg-file-tile-glyph" viewBox={FILE_ICON_VIEWBOX} fill="none" data-file-icon={mark().id} innerHTML={mark().body} />
    </span>
  );
}
