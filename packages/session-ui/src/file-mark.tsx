import type { CSSProperties } from 'react';
import { FILE_ICON_VIEWBOX, fileMark, IMAGE_OFF_GLYPH } from '@gugu/session-shared/file-marks';

// 一个 body 一个固定的 `{ __html }`:换一个新对象 React 就重写 innerHTML(见 icons.tsx 的 @@@icon-body-identity)。
const HTML = new Map<string, { __html: string }>();
const html = (body: string) => { let value = HTML.get(body); if (!value) HTML.set(body, value = { __html: body }); return value; };
const OFF = { __html: IMAGE_OFF_GLYPH };

/**
 * 一个文件的图标(`file-marks.ts`):画成它的色;`ink` 时不设色、跟 `currentColor`(正文里的提及胶囊)。
 * `off`:是张图、但读不回来 —— 画 24 格的 Solar 字形,墨色。
 */
export function FileMark({ name, mime, off, ink, size = 20, className, style }: {
  name: string; mime?: string; off?: boolean; ink?: boolean; size?: number; className?: string; style?: CSSProperties;
}) {
  if (off) return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} style={style} dangerouslySetInnerHTML={OFF} />;
  const mark = fileMark(name, mime);
  return <svg width={size} height={size} viewBox={FILE_ICON_VIEWBOX} fill="none" aria-hidden="true" data-file-icon={mark.id} className={className}
    style={ink ? style : { ...style, color: mark.color }} dangerouslySetInnerHTML={html(mark.body)} />;
}
