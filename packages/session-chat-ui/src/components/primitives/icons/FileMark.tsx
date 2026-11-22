/** @jsxImportSource solid-js */
import { FILE_ICON_VIEWBOX, fileMark, IMAGE_OFF_GLYPH } from '@gugu/session-shared/file-marks';

/**
 * 一个文件的图标(`file-marks.ts`):画成它的色;`ink` 时不设色、跟 `currentColor`(正文里的提及胶囊)。
 * `off`:是张图、但读不回来 —— 画 24 格的 Solar 字形,墨色。
 */
export function FileMark(props: { name: string; mime?: string; off?: boolean; ink?: boolean; size?: number; class?: string }) {
  const mark = () => fileMark(props.name, props.mime);
  return props.off
    ? <svg width={props.size ?? 20} height={props.size ?? 20} viewBox="0 0 24 24" aria-hidden="true" class={props.class} innerHTML={IMAGE_OFF_GLYPH} />
    : <svg width={props.size ?? 20} height={props.size ?? 20} viewBox={FILE_ICON_VIEWBOX} fill="none" aria-hidden="true" class={props.class}
        data-file-icon={mark().id} style={props.ink ? undefined : { color: mark().color }} innerHTML={mark().body} />;
}
