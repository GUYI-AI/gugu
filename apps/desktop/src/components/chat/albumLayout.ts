// How the images of one send tile into one bubble (#2581), after Telegram's albums: one tile per image, each tile keeps
// roughly its image's shape (the image fills it, cropped at the edges), and the album spans the width one image may take.

export interface AlbumTile { x: number; y: number; width: number; height: number }
export interface AlbumLayout { width: number; height: number; tiles: AlbumTile[] }

export const ALBUM_GAP = 2
// A panorama or a long screenshot is cropped to these bounds in its tile, so it cannot flatten or stretch a row.
const MIN_RATIO = 0.5
const MAX_RATIO = 2.5

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) && ratio > 0 ? ratio : 1))
const portrait = (ratio: number) => ratio < 0.85
const landscape = (ratio: number) => ratio > 1.2

/** Tiles for images of the given width/height ratios, in order, inside `width` CSS pixels. */
export function layoutAlbum(ratios: readonly number[], width: number): AlbumLayout {
  const r = ratios.map(clampRatio)
  const W = Math.floor(width)
  if (r.length === 0) return { width: W, height: 0, tiles: [] }
  if (r.length === 1) return finish(W, [{ x: 0, y: 0, width: W, height: Math.round(Math.min(W / r[0], W)) }])
  if (r.length === 2 && landscape(r[0]) && landscape(r[1]) && r[0] + r[1] > 3) return finish(W, stack(r, W))
  if ((r.length === 3 || r.length === 4) && portrait(r[0])) return finish(W, sideColumn(r, W))
  if ((r.length === 3 || r.length === 4) && landscape(r[0])) return finish(W, topThenRow(r, W))
  return finish(W, justifiedRows(r, W))
}

function finish(width: number, tiles: AlbumTile[]): AlbumLayout {
  return { width, height: Math.max(...tiles.map(tile => tile.y + tile.height)), tiles }
}

/** Splits `total` pixels between parts in proportion to their weights, on whole pixels, gaps between them. */
function split(weights: readonly number[], total: number): Array<{ start: number; size: number }> {
  const free = total - ALBUM_GAP * (weights.length - 1)
  const sum = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  return weights.map((weight, index) => {
    const start = Math.round(acc / sum * free) + index * ALBUM_GAP
    acc += weight
    const end = Math.round(acc / sum * free) + index * ALBUM_GAP
    return { start, size: end - start }
  })
}

/** Two wide images, one above the other. */
function stack(r: readonly number[], W: number): AlbumTile[] {
  let y = 0
  return r.map(ratio => {
    const height = Math.round(Math.min(W / ratio, W * 0.6))
    const tile = { x: 0, y, width: W, height }
    y += height + ALBUM_GAP
    return tile
  })
}

/** A tall first image on the left, the others stacked on its right. */
function sideColumn(r: readonly number[], W: number): AlbumTile[] {
  const rest = r.slice(1)
  const inverse = rest.reduce((sum, ratio) => sum + 1 / ratio, 0)
  const ideal = ((W - ALBUM_GAP) / r[0] - ALBUM_GAP * (rest.length - 1)) / (1 / r[0] + inverse)
  const right = Math.round(Math.min(W * 0.5, Math.max(W * 0.33, ideal)))
  const left = W - ALBUM_GAP - right
  const height = Math.round(Math.min(W * 1.2, Math.max(W * 0.66, left / r[0])))
  const rows = split(rest.map(ratio => 1 / ratio), height)
  return [{ x: 0, y: 0, width: left, height }, ...rows.map(row => ({ x: left + ALBUM_GAP, y: row.start, width: right, height: row.size }))]
}

/** A wide first image across the top, the others in one row under it. */
function topThenRow(r: readonly number[], W: number): AlbumTile[] {
  const top = Math.round(Math.min(W / r[0], W * 0.66))
  const rest = r.slice(1)
  const rowHeight = Math.round(Math.min(W * 0.5, (W - ALBUM_GAP * (rest.length - 1)) / rest.reduce((a, b) => a + b, 0)))
  return [{ x: 0, y: 0, width: W, height: top }, ...split(rest, W).map(cell => ({ x: cell.start, y: top + ALBUM_GAP, width: cell.size, height: rowHeight }))]
}

/** Rows of one to four images, each row filling the width at one height; the split whose rows sit nearest a target height wins. */
function justifiedRows(r: readonly number[], W: number): AlbumTile[] {
  const target = W * 0.42
  const rowHeight = (from: number, to: number) => (W - ALBUM_GAP * (to - from - 1)) / r.slice(from, to).reduce((a, b) => a + b, 0)
  const best: Array<{ cost: number; cut: number }> = [{ cost: 0, cut: 0 }]
  for (let end = 1; end <= r.length; end += 1) {
    best[end] = { cost: Infinity, cut: 0 }
    for (let size = 1; size <= Math.min(4, end); size += 1) {
      const start = end - size
      const height = rowHeight(start, end)
      // A lone image on its own row breaks the album into pieces; only two images may sit one per row (handled by stack).
      const lone = size === 1 && r.length > 2 ? target * target : 0
      const cost = best[start].cost + (height - target) ** 2 + lone
      if (cost < best[end].cost) best[end] = { cost, cut: start }
    }
  }
  const rows: Array<[number, number]> = []
  for (let end = r.length; end > 0; end = best[end].cut) rows.unshift([best[end].cut, end])
  const tiles: AlbumTile[] = []
  let y = 0
  for (const [from, to] of rows) {
    const height = Math.round(Math.min(W * 0.75, rowHeight(from, to)))
    for (const cell of split(r.slice(from, to), W)) tiles.push({ x: cell.start, y, width: cell.size, height })
    y += height + ALBUM_GAP
  }
  return tiles
}
