/**
 * 一个文件画成什么只查这里：`file-icons/<id>.svg`（一个图标一个文件，16 格，全部 currentColor）加
 * `file-icons/manifest.json`（每个 id 的色名和匹配表，外加 11 色调色板）。换图 = 换那个 SVG 文件，加一种语言 =
 * manifest 加一项、加一个 SVG、`file-icons/index.ts` 加一行 import。React 的 `FileMark`（session-ui）、Solid 的 `FileMark` / `FileTile`（session-chat-ui）
 * 和 App 页面的 `<gugu-file-mark>`（app-runtime/ui）都只是这里的薄壳。
 *
 * 颜色：图标自己不带色，壳把 `color` 设成 `var(--file-<色名>)`（tokens.css 里一浅一深；App 页面是
 * `--em-file-<色名>`）。正文里的提及胶囊要墨色时，壳不设色，跟 `currentColor` 走。
 * 尺寸：12–24 px 直接画；≥ 32 px 的图块（`file-tile.css`）是同色浅底方块里放同一张图，边长取图块的 60%。
 */
import { fileFamily, type FileFamily } from '@gugu/core/shared/fileFamily.mjs';
import { FILE_GLYPHS } from './file-glyphs';
import manifest from './file-icons/manifest.json';
import { FILE_ICON_SVGS } from './file-icons/index';

type IconEntry = { shape: string; colour: string; label: string; names: string[]; patterns: string[]; ext: string[] };
const ICONS = manifest.icons as Record<string, IconEntry>;
export type FileIconId = keyof typeof manifest.icons;

/** Each SVG's inside (everything between `<svg …>` and `</svg>`): the shells draw it in their own 16-box `<svg>`. */
const BODIES: Record<string, string> = Object.fromEntries(
  Object.entries(FILE_ICON_SVGS).map(([id, svg]) => [id, /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1] ?? '']),
);

/** The viewBox every file icon is drawn in. */
export const FILE_ICON_VIEWBOX = '0 0 16 16';

// Match order (manifest `note`): names (exact, case-sensitive) > patterns (glob, case-insensitive) > ext (last
// extension, case-insensitive) > the file's family (by suffix, else by mime) > unknown.
const BY_NAME = new Map<string, string>();
const BY_PATTERN: [RegExp, string][] = [];
const BY_EXT = new Map<string, string>();
for (const [id, icon] of Object.entries(ICONS)) {
  for (const name of icon.names) BY_NAME.set(name, id);
  for (const pattern of icon.patterns) BY_PATTERN.push([new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'), id]);
  for (const ext of icon.ext) BY_EXT.set(ext.toLowerCase(), id);
}
/** A family's icon when nothing in the manifest named the file (no suffix, or one only its mime explains). */
const BY_FAMILY: Record<FileFamily, FileIconId> = {
  pdf: 'pdf', word: 'doc', sheet: 'sheet', slides: 'slides', archive: 'archive', image: 'image', video: 'video',
  audio: 'audio', code: 'code', text: 'text', other: 'unknown',
};

/** `src/app.ts` → `'ts'`, `pnpm-lock.yaml` → `'lock'`, `scan` (application/pdf) → `'pdf'`, `x.bin` → `'unknown'`. */
export function fileIconId(name: string, mime?: string): FileIconId {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const id = BY_NAME.get(base)
    ?? BY_PATTERN.find(([pattern]) => pattern.test(base))?.[1]
    ?? (dot > 0 ? BY_EXT.get(base.slice(dot + 1).toLowerCase()) : undefined);
  return (id ?? BY_FAMILY[fileFamily(base, mime)]) as FileIconId;
}

/** The CSS colour a file icon is drawn in (host `--file-<colour>`, one value per theme in tokens.css). */
export function fileIconColor(id: FileIconId): string {
  return `var(--file-${ICONS[id].colour})`;
}

/** A file as gugu draws it: its icon's id, the SVG inside (16-box, currentColor) and its colour. */
export function fileMark(name: string, mime?: string): { id: FileIconId; body: string; color: string } {
  const id = fileIconId(name, mime);
  return { id, body: BODIES[id] ?? BODIES.unknown, color: fileIconColor(id) };
}

/** A folder, closed or open, from the same set (manifest `folder` / `folder-open`). */
export function folderMark(open = false): { id: FileIconId; body: string; color: string } {
  const id: FileIconId = open ? 'folder-open' : 'folder';
  return { id, body: BODIES[id], color: fileIconColor(id) };
}

/** 一张图读不回来时的字形（24 格，Solar）：这是状态不是文件类型，❌ 别画成 image —— 那会把「没读到」说成「是张图」。 */
export const IMAGE_OFF_GLYPH = FILE_GLYPHS.ImageOff;
