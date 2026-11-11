#!/usr/bin/env python3
"""小尺寸应用图标的逐档画法 —— build-resources/icon-sources/small/ 的唯一出处,❌ 手改那些 PNG。

    uv run --with pillow --with numpy python scripts/build/draw-small-app-icons.py     # 需要 rsvg-convert(librsvg)

为什么有这一份:定稿是 1024 的画面,16 颗点的格距 72。缩到 64 像素以下,格距不再是整像素,点落在像素格中间,
缩出来每颗点深浅不一、点和点之间糊成灰(owner 2026-11-11:「有点糊了」「要不还是设计下」)。原生图标的小尺寸都是
逐档单独画的,这里也一样:还是同一只鸟、同一个轮廓、同一种排法(翅膀一串、尾巴一簇阶梯),只是每一档单独决定
  · 格距取几个整像素,点的中心都落在像素格上 —— 所以同一档里每颗点长得一样、缝一样宽;
  · 每颗点四周留一圈暗像素,不和实心粘在一起(实心边上的半透明像素让位,实心像素不动);
  · 放不下 16 颗的档按同一个排法减颗数,不连成块、不另造形状。

  边长   格距  点                         颗数
  64     4     圆点,直径 3.0 / 2.4 / 1.7     16
  40 48  3     2×2 白 / 2×2 浅 / 1 像素白     16
  32     2     1 像素,亮度 1 / 0.82 / 0.6    16
  24     2     同上                         14
  20     2     同上                         10
  16     2     同上                          8

产物(都是源图,提交进仓;gen-app-icons.py / gen-tray-icons.py 按边长取用,没有的边长才从 1024 缩):
  · small/app-{16,20,24,32,40,48,64}.png   应用图标,满幅墨底、不带圆角(圆角由生成器切)。
  · small/mark-{16,20,24,32,36,48}.png     单色标,灰度 = 不透明度,没有底板、鸟顶到画布边
    (托盘 / 菜单栏 / 安卓状态栏用;16、20、32 三张就是应用图标 20、24、40 那三张画挪到小画布上)。

改图形:先改母版 app-icon-dots.svg,再回来按新几何重排下面的点位表(每一档的点位是对着实心部分逐像素定的,
母版一变就得重排),跑完看输出里每一档是不是「点位干净」。
"""
from __future__ import annotations
import re, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'build-resources' / 'icon-sources'
OUT = SOURCES / 'small'
INK = np.array([26, 28, 31], float)

_svg = (SOURCES / 'app-icon-dots.svg').read_text()
_path = re.search(r'<path d="([^"]+)"', _svg).group(1)
SUBPATHS = ['M' + s for s in _path.split('M') if s.strip()]          # 0 = 近翅,1 = 头和身子
G_OUTER = re.search(r'<g fill="#ffffff" transform="([^"]+)">', _svg).group(1)
G_INNER = re.search(r'<g transform="(scale[^"]+)">', _svg).group(1)
# 定稿里尾巴 10 颗点在格子上的位置:(从右数第几列, 第几排) → 大 B / 中 M / 小 S
TAIL = {(0, 0): 'B', (1, 0): 'B', (0, 1): 'B', (1, 1): 'B', (2, 1): 'M', (3, 1): 'S', (1, 2): 'B', (2, 2): 'M', (3, 2): 'S', (4, 2): 'S'}
SUPERSAMPLE = 16


def body(size: int, k: float, ox: float, oy: float) -> np.ndarray:
    """实心部分(近翅、头和身子)在 size 像素画布上的像素覆盖率 0–1。"""
    out = np.zeros((size, size))
    with tempfile.TemporaryDirectory() as td:
        for sub in SUBPATHS:
            svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size * SUPERSAMPLE}" height="{size * SUPERSAMPLE}" viewBox="0 0 {size} {size}">'
                   f'<rect width="{size}" height="{size}" fill="#000"/><g fill="#fff" transform="translate({ox} {oy}) scale({k})">'
                   f'<g transform="{G_OUTER}"><g transform="{G_INNER}"><path d="{sub}"/></g></g></g></svg>')
            src, png = Path(td) / 'b.svg', Path(td) / 'b.png'
            src.write_text(svg)
            subprocess.run(['rsvg-convert', str(src), '-o', str(png)], check=True)
            cov = np.asarray(Image.open(png).convert('L').resize((size, size), Image.BOX)).astype(float) / 255
            out = np.maximum(out, cov)
    return out


def crisp(cov: np.ndarray, gain: float) -> np.ndarray:
    """边缘收紧:半透明像素往两头推,小尺寸的斜边不拖灰。"""
    return np.clip((cov - 0.5) * gain + 0.5, 0, 1)


def disc(a: np.ndarray, cx: float, cy: float, d: float, v: float) -> None:
    n, r = 8, d / 2
    s = (np.arange(n) + .5) / n
    for y in range(max(0, int(cy - r - 1)), min(a.shape[0], int(cy + r + 2))):
        for x in range(max(0, int(cx - r - 1)), min(a.shape[1], int(cx + r + 2))):
            xx, yy = np.meshgrid(x + s, y + s)
            a[y, x] = max(a[y, x], float((((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r).mean()) * v)


def tail(x0: int, y0: int, pitch: int, tiers: dict, keep: set | None = None, kind: str = 'b') -> list:
    """尾巴:正放的格子。(x0, y0) 是最靠身子那一颗(第一排最右),往左、往下每格 pitch 像素。"""
    return [(kind, x0 - i * pitch, y0 + j * pitch, *tiers[t]) for (i, j), t in TAIL.items() if keep is None or (i, j) in keep]


def string(x0: int, y0: int, steps: list, shapes: list, kind: str = 'b') -> list:
    """翅膀那一串:从最靠头的一颗起,按 steps 一颗颗往翼尖走。shapes 是每颗的 (边长或直径, 亮度)。"""
    out, x, y = [], x0, y0
    for n, (w, v) in enumerate(shapes):
        out.append((kind, x, y, w, v))
        if n < len(steps):
            x -= steps[n][0]
            y -= steps[n][1]
    return out


def cells(dot: tuple) -> list:
    kind, x, y, w, _ = dot
    if kind == 'b':                                  # 整像素方点,(x, y) 是左上角
        return [(x + i, y + j) for i in range(w) for j in range(w)]
    r = max(1, int(np.ceil(w / 2 - 0.55)))           # 圆点,圆心在像素 (x, y) 的中心;直径 3 以内占 3×3
    return [(x + i, y + j) for i in range(-r, r + 1) for j in range(-r, r + 1)]


def draw(spec: dict) -> tuple[np.ndarray, list]:
    size, k = spec['size'], spec['k']
    ox, oy = spec.get('off', (0, 0))
    solid = crisp(body(size, k, ox, oy), spec['gain'])
    a, owner = solid.copy(), {}
    for n, dot in enumerate(spec['dots']):
        kind, x, y, w, v = dot
        if kind == 'b':
            for cx, cy in cells(dot):
                a[cy, cx] = max(a[cy, cx], v)
        else:
            disc(a, x + 0.5, y + 0.5, w, v)
        for c in cells(dot):
            owner[c] = n
    problems = []
    for (x, y), n in owner.items():
        if solid[y, x] > 0.25:
            problems.append(f'点{n} 压在实心上 ({x},{y})')
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                q = (x + dx, y + dy)
                if q in owner:
                    if owner[q] != n and spec['dots'][n][0] == 'b':
                        problems.append(f'点{n} 和点{owner[q]} 挨着')
                    continue
                if not (0 <= q[0] < size and 0 <= q[1] < size):
                    continue
                # 点四周留暗:只压实心边上的半透明像素,实心像素不动
                if 'carve' in spec and solid[q[1], q[0]] < 0.7:
                    a[q[1], q[0]] = min(a[q[1], q[0]], spec['carve'])
                if a[q[1], q[0]] > 0.2:
                    problems.append(f'点{n} 旁边 ({q[0]},{q[1]}) 不够暗')
    return a, sorted(set(problems))


T2 = dict(B=(1, 1.0), M=(1, 0.82), S=(1, 0.6))
T3 = dict(B=(2, 1.0), M=(2, 0.7), S=(1, 1.0))
D4 = dict(B=(3.04, 1.0), M=(2.4, 1.0), S=(1.68, 1.0))
STRING2 = {3: [(1, 1.0), (1, 0.82), (1, 0.6)], 4: [(1, 1.0), (1, 0.82), (1, 0.82), (1, 0.6)], 5: [(1, 1.0), (1, 0.82), (1, 0.82), (1, 0.6), (1, 0.6)]}
STRING3 = [(2, 1.0), (2, 0.7), (2, 0.7)]
STRING4 = [D4['B'], D4['M'], D4['M'], D4['S'], D4['S']]


def app(size: int, **kw) -> dict:
    return dict(size=size, k=size / 1024, **kw)


def moved(spec: dict, size: int, dx: int, dy: int) -> dict:
    """同一张画换到 size 像素的画布上,整体挪 (dx, dy) 个整像素。"""
    ox, oy = spec.get('off', (0, 0))
    return {**spec, 'size': size, 'off': (ox + dx, oy + dy), 'dots': [(kind, x + dx, y + dy, w, v) for kind, x, y, w, v in spec['dots']]}


def centred(size: int, per_1024: int, **kw) -> dict:
    """鸟按「每 1024 单位 per_1024 像素」画在 size 像素画布正中(鸟连点的外框中心是 512.25, 518.75)。"""
    k = per_1024 / 1024
    return dict(size=size, k=k, off=(size / 2 - 512.25 * k, size / 2 - 518.75 * k), **kw)


APP = {
    16: app(16, gain=1.3, carve=0.1,
            dots=string(9, 5, [(2, 1)] * 2, STRING2[3]) + tail(6, 10, 2, T2, {(0, 0), (1, 0), (0, 1), (1, 1), (2, 1)})),
    20: app(20, gain=1.3, carve=0.1,
            dots=string(11, 7, [(2, 1)] * 2, STRING2[3]) + tail(8, 12, 2, T2, {(0, 0), (1, 0), (0, 1), (1, 1), (2, 1), (1, 2), (2, 2)})),
    24: app(24, gain=1.3, carve=0.1,
            dots=string(14, 9, [(2, 1)] * 3, STRING2[4]) + [('b', 14, 12, 1, 1.0)] + tail(10, 15, 2, T2, set(TAIL) - {(4, 2)})),
    32: app(32, gain=1.2, carve=0.1,
            dots=string(18, 12, [(2, 1)] * 4, STRING2[5]) + [('b', 19, 16, 1, 1.0)] + tail(14, 20, 2, T2)),
    40: app(40, gain=1.2, carve=0.1,
            dots=string(22, 15, [(3, 2), (3, 1)], STRING3) + [('b', 14, 11, 1, 1.0), ('b', 12, 10, 1, 1.0), ('b', 23, 19, 2, 1.0)] + tail(17, 24, 3, T3)),
    48: app(48, gain=1.2, carve=0.1,
            dots=string(27, 19, [(3, 2), (3, 1)], STRING3) + [('b', 19, 15, 1, 1.0), ('b', 17, 14, 1, 1.0), ('b', 28, 24, 2, 1.0)] + tail(22, 29, 3, T3)),
    64: app(64, gain=1.1,
            dots=string(36, 26, [(4, 2), (3, 2), (4, 2), (3, 2)], STRING4, 'd') + [('d', 38, 33, 3.04, 1.0)] + tail(30, 40, 4, D4, None, 'd')),
}
MARK = {
    16: moved(APP[20], 16, -2, -2),
    20: moved(APP[24], 20, -2, -2),
    24: centred(24, 30, gain=1.2, carve=0.1,
                dots=string(14, 8, [(2, 1)] * 4, STRING2[5]) + [('b', 14, 11, 1, 1.0)] + tail(10, 15, 2, T2)),
    32: moved(APP[40], 32, -4, -4),
    36: centred(36, 45, gain=1.2, carve=0.1,
                dots=string(20, 13, [(3, 2), (3, 2)], STRING3) + [('b', 12, 8, 1, 1.0), ('b', 10, 7, 1, 1.0), ('b', 22, 18, 2, 1.0)] + tail(15, 22, 3, T3)),
    48: centred(48, 60, gain=1.1,
                dots=string(29, 18, [(4, 2), (3, 2), (4, 2), (3, 2)], STRING4, 'd') + [('d', 30, 25, 3.04, 1.0)] + tail(22, 31, 4, D4, None, 'd')),
}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failed = False
    for name, table in (('app', APP), ('mark', MARK)):
        for size, spec in table.items():
            a, problems = draw(spec)
            if name == 'app':
                img = Image.fromarray((INK + (255 - INK) * a[..., None]).round().astype(np.uint8), 'RGB')
            else:
                img = Image.fromarray((a * 255).round().astype(np.uint8), 'L')
            img.save(OUT / f'{name}-{size}.png')
            print(f'small/{name}-{size}.png  {len(spec["dots"])} 颗  ' + ('；'.join(problems) or '点位干净'))
            failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
