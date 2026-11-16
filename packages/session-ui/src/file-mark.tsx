import type { CSSProperties } from 'react';
import { fileFamily, type FileFamily } from '@gugu/core/shared/fileFamily.mjs';
import { FILE_MARKS, IMAGE_OFF_GLYPH } from '@gugu/session-shared/file-marks';

// 每族一个固定的 `{ __html }`:换一个新对象 React 就重写 innerHTML(见 icons.tsx 的 @@@icon-body-identity)。
const HTML = Object.fromEntries(Object.entries(FILE_MARKS).map(([family, mark]) => [family, { __html: mark.glyph }])) as Record<FileFamily, { __html: string }>;
const OFF = { __html: IMAGE_OFF_GLYPH };

/** 一个文件的族字形(墨色,跟 `currentColor`),查 `FILE_MARKS`;`off`:是张图、但读不回来。 */
export function FileMark({ name, mime, off, size = 20, className, style }: { name: string; mime?: string; off?: boolean; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className} style={style} dangerouslySetInnerHTML={off ? OFF : HTML[fileFamily(name, mime)]} />;
}
