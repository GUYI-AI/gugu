/**
 * 文件族 → 字形 + 族色:一个文件画成什么只查这一张表(族从 `@gugu/core/shared/fileFamily` 来)。
 * 行内(≤ 20px:文件行、tab、输入框附件、存储面板……)只画字形、墨色;族色留给图块(`file-tile.css`:文件 App 的
 * 列表 / 宫格 / 详情、产物卡)。React 的 `FileMark`(session-ui)、Solid 的 `FileMark` / `FileTile`(session-chat-ui)和
 * App 页面的 `<gugu-file-mark>`(app-runtime/ui)都只是这张表的薄壳。
 */
import { fileFamily, type FileFamily } from '@gugu/core/shared/fileFamily.mjs';
import { extensionOf } from '@gugu/core/shared/imageMime.mjs';
import { FILE_GLYPHS } from './file-glyphs';

export const FILE_MARKS: Record<FileFamily, { glyph: string; color: string }> = {
  pdf: { glyph: FILE_GLYPHS.FilePdf, color: 'var(--file-pdf)' },
  word: { glyph: FILE_GLYPHS.FileText, color: 'var(--file-word)' },
  sheet: { glyph: FILE_GLYPHS.FileSheet, color: 'var(--file-sheet)' },
  slides: { glyph: FILE_GLYPHS.FileSlides, color: 'var(--file-slides)' },
  archive: { glyph: FILE_GLYPHS.FileArchive, color: 'var(--file-archive)' },
  image: { glyph: FILE_GLYPHS.FileImage, color: 'var(--file-image)' },
  video: { glyph: FILE_GLYPHS.FileVideo, color: 'var(--file-video)' },
  audio: { glyph: FILE_GLYPHS.FileAudio, color: 'var(--file-audio)' },
  code: { glyph: FILE_GLYPHS.FileCode, color: 'var(--file-code)' },
  text: { glyph: FILE_GLYPHS.FileText, color: 'var(--file-text)' },
  other: { glyph: FILE_GLYPHS.File, color: 'var(--file-generic)' },
};

/** 一张图读不回来时的字形:这是状态不是族,❌ 别画成 image 族 —— 那会把「没读到」说成「是张图」。 */
export const IMAGE_OFF_GLYPH = FILE_GLYPHS.ImageOff;

/**
 * A file's tile (`file-tile.css`): its family's glyph and colour, and the words the solid version writes on it — the
 * suffix, at most four letters (`XLSX`; a claimed `.vote.json` by its last part), else the family's (`PDF` for a pdf
 * named without one); `other` has none.
 */
export function fileTile(name: string, mime?: string): { family: FileFamily; glyph: string; color: string; label: string } {
  const family = fileFamily(name, mime);
  const suffix = extensionOf(name);
  const label = (suffix || (family === 'other' ? '' : family)).slice(0, 4).toUpperCase();
  return { family, ...FILE_MARKS[family], label };
}
