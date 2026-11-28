/**
 * 一枚附件的「文件行」—— assistant-ui `elements/file` 那件:图标 + 名字 + 一行说明(宿主给的字),
 * **定宽**(owner:「人家的文件 ui 大小是固定这么大,你是超长变宽」),名字一行放不下就截断。
 * 数字照上游默认那枚(outline):左右 12、上下 8、圆角 8、图标 20 直接画(不套格子)、图标与文字隔 12,
 * 名字 14/20 字重 600,说明 12/16,两行隔 2。图片画成一张图(`PICTURE`),不是文件行。
 * 字重是唯一一处有意偏离上游:上游的 500 靠它自带的 Public Sans 网页字体;咕咕用系统字体,Windows 的 Segoe UI
 * 和微软雅黑都没有 500(落成 400,名字发虚),600 在 Windows 落到 Semibold/雅黑 Bold、mac 上是 Semibold。
 *
 * 尺寸只写在这里:绘制(`file-row.css` 读 `fileRowStyle()` 给的变量,图的框读 `fileRowBox`)和量高(`fileRowsHeight`)
 * 读同一组数。React 与 Solid 各自只套一层壳(给图标、给颜色),❌ 不各写一份尺寸。
 * `gap` 是一串文件行之间(横向、换行后纵向)的间距。
 */
const PAD_Y = 8, NAME_LINE = 20, LINE_GAP = 2, DETAIL_LINE = 16;

export const FILE_ROW = { width: 260, height: PAD_Y + NAME_LINE + LINE_GAP + DETAIL_LINE + PAD_Y, padX: 12, padY: PAD_Y,
  glyph: 20, columnGap: 12, nameSize: 14, nameLine: NAME_LINE, lineGap: LINE_GAP, detailSize: 12, detailLine: DETAIL_LINE,
  radius: 8, gap: 8 } as const;

/**
 * A picture is drawn the way a chat bubble draws one (`.chat-inline-image`): its own proportions inside a 280 square,
 * never enlarged, never wider than the strip. One whose size the message does not know gets a box 160 high and as wide as
 * a picture may be, the picture contained in it. Either way the box is known before the picture loads: a row's height is.
 */
export const PICTURE = { max: 280, unknownHeight: 160 } as const;

export type FileRowItem = { kind: 'file' } | { kind: 'image'; size?: { width: number; height: number } };

/** 一枚的框:文件行是定值,只有整条比它还窄时才收到可用宽度;图按 `PICTURE`。 */
export function fileRowBox(item: FileRowItem, available: number): { width: number; height: number } {
  if (item.kind === 'file') return { width: Math.max(1, Math.min(FILE_ROW.width, available)), height: FILE_ROW.height };
  if (!item.size) return { width: Math.max(1, Math.min(PICTURE.max, available)), height: PICTURE.unknownHeight };
  const { width, height } = item.size;
  const scale = Math.min(1, PICTURE.max / width, PICTURE.max / height, available / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 一串文件行与图 `flex-wrap` 排开后的总高(不含上下外距);空串是 0。
 * 每枚的框都在画之前定好,所以一行排几枚、一行多高(那一行最高的一枚)是确定的,不必量名字。
 */
export function fileRowsHeight(items: readonly FileRowItem[], available: number): number {
  let height = 0, line = 0, x = 0;
  for (const item of items) {
    const box = fileRowBox(item, available);
    if (x > 0 && x + FILE_ROW.gap + box.width > available) { height += line + FILE_ROW.gap; line = 0; x = 0; }
    x += (x > 0 ? FILE_ROW.gap : 0) + box.width;
    line = Math.max(line, box.height);
  }
  return height + line;
}

/** 挂在一串文件行的容器上:`file-row.css` 的尺寸全从这里读(`padX` → `--gg-file-row-pad-x`)。 */
export function fileRowStyle(): Record<string, string> {
  return Object.fromEntries(Object.entries(FILE_ROW).map(([key, value]) =>
    [`--gg-file-row-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, `${value}px`]));
}
