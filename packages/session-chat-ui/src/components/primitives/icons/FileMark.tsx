/** @jsxImportSource solid-js */
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs';
import { FILE_MARKS, IMAGE_OFF_GLYPH } from '@gugu/session-shared/file-marks';

/** 一个文件的族字形(墨色,跟 `currentColor`),查 `FILE_MARKS`;`off`:是张图、但读不回来。 */
export function FileMark(props: { name: string; mime?: string; off?: boolean; size?: number; class?: string }) {
  return (
    <svg width={props.size ?? 20} height={props.size ?? 20} viewBox="0 0 24 24" aria-hidden="true" class={props.class}
      innerHTML={props.off ? IMAGE_OFF_GLYPH : FILE_MARKS[fileFamily(props.name, props.mime)].glyph} />
  );
}
