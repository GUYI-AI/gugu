/**
 * 一枚附件的「文件行」—— assistant-ui `message-attachment` 那件:图标 + 名字 + 一行说明(宿主给的字)在一个框里,
 * **定宽**(owner:「人家的文件 ui 大小是固定这么大,你是超长变宽」),名字一行放不下就截断。
 * 图片是与文件行同高的方形缩略图。
 *
 * 尺寸只写在这里:绘制(`file-row.css` 读 `fileRowStyle()` 给的变量)和量高(`fileRowsHeight`)
 * 读同一组数。React 与 Solid 各自只套一层壳(给图标、给颜色),❌ 不各写一份尺寸。
 * 名字和说明各一行,都是标注档 12/18(#7333);`gap` 是一串文件行之间(横向、换行后纵向)的间距。
 */
export const FILE_ROW = { width: 260, height: 56, padStart: 10, padEnd: 14, icon: 36, glyph: 18, columnGap: 10, line: 18,
  radius: 14, iconRadius: 8, gap: 8 } as const;

export type FileRowKind = 'image' | 'file';

/**
 * 文件行图标位里的两个字形(24 格、2 描边的 path):文件,和「这张图读不出来」。Solid 与 React 两层壳都画这份,
 * ❌ 各自再挑一个长得像的图标 —— 同一条时间线里会是两枚不同的文件。
 */
export const FILE_ROW_GLYPHS = {
  file: ['M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z', 'M14 2v6h6'],
  imageOff: ['M2 2l20 20', 'M10.41 10.41a2 2 0 1 1-2.83-2.83', 'M13.5 13.5L6 21', 'M18 12l3 3',
    'M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59', 'M21 15V5a2 2 0 0 0-2-2H9'],
} as const;

/** 一枚多宽:定值,只有整条比它还窄时才收到可用宽度。 */
export function fileRowWidth(kind: FileRowKind, available: number): number {
  return Math.max(1, Math.min(kind === 'image' ? FILE_ROW.height : FILE_ROW.width, available));
}

/**
 * 一串文件行 `flex-wrap` 排开后的总高(不含上下外距);空串是 0。
 * 每枚宽度都是常量,所以一行排几枚是确定的,不必量名字。
 */
export function fileRowsHeight(kinds: readonly FileRowKind[], available: number): number {
  if (kinds.length === 0) return 0;
  let lines = 1;
  let x = 0;
  for (const kind of kinds) {
    const w = fileRowWidth(kind, available);
    if (x > 0 && x + FILE_ROW.gap + w > available) { lines += 1; x = 0; }
    x += (x > 0 ? FILE_ROW.gap : 0) + w;
  }
  return lines * FILE_ROW.height + (lines - 1) * FILE_ROW.gap;
}

/** 挂在一串文件行的容器上:`file-row.css` 的尺寸全从这里读(`padStart` → `--gg-file-row-pad-start`)。 */
export function fileRowStyle(): Record<string, string> {
  return Object.fromEntries(Object.entries(FILE_ROW).map(([key, value]) =>
    [`--gg-file-row-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, `${value}px`]));
}
