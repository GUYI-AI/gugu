#!/usr/bin/env python3
"""托盘 / 菜单栏图标生成器 —— 唯一出处,❌ 手工导出。

    uv run --with pillow python scripts/build/gen-tray-icons.py

源图 build-resources/icon-sources/tray-mark-source.png:白底黑标,就是应用图标「网点鸽」那一张画面
(同目录 app-icon-dots.svg 换成白底黑形渲染;图形来历见 scripts/build/gen-app-icons.py)。
48 像素及以下用 build-resources/icon-sources/small/mark-{16,20,24,32,36,48}.png:同一只鸟按像素格逐档画好的版本
(灰度 = 不透明度,由 scripts/build/draw-small-app-icons.py 画出;从大图缩下来点会糊成灰)。没有对应边长的才从源图缩。
产物全部落在 build-resources/,规格按 Electron Tray 文档:
  · macOS  tray-iconTemplate.png 16×16 + tray-iconTemplate@2x.png 32×32 —— 模板图(黑 + 透明),
           文件名以 Template 结尾,系统按亮/暗/毛玻璃自己着色;别让打包把文件名 hash 掉。
  · Windows tray-icon-light.ico / tray-icon-dark.ico —— 多尺寸 ICO;light=黑字形(浅色任务栏),
           dark=白字形(深色任务栏),主进程按 nativeTheme 切换。
  · Linux  tray-icon-light.png / tray-icon-dark.png —— 32×32,同上两套。
  · Android apps/mobile/android/app/src/main/res/drawable-*/ic_stat_gugu.png —— 通知状态栏小图标,
           白字形 + 透明(系统只取 alpha 自己着色),24dp 按五档密度出。
"""
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'build-resources' / 'icon-sources' / 'tray-mark-source.png'
SMALL = ROOT / 'build-resources' / 'icon-sources' / 'small'
OUT = ROOT / 'build-resources'
ICO_SIZES = [16, 20, 24, 32, 48]
ANDROID_RES = ROOT / 'apps' / 'mobile' / 'android' / 'app' / 'src' / 'main' / 'res'
# 24dp × 密度倍数(mdpi 1× / hdpi 1.5× / xhdpi 2× / xxhdpi 3× / xxxhdpi 4×)
ANDROID_NOTIFICATION_ICON_SIZES = {'mdpi': 24, 'hdpi': 36, 'xhdpi': 48, 'xxhdpi': 72, 'xxxhdpi': 96}


def load_alpha_mark() -> Image.Image:
    g = Image.open(SRC).convert('L')
    a = ImageOps.invert(g).point(lambda v: 0 if v < 40 else (255 if v > 215 else v))
    bb = a.getbbox()
    if not bb:
        raise SystemExit(f'source has no dark pixels: {SRC}')
    a = a.crop(bb)
    w, h = a.size
    s = max(w, h)
    sq = Image.new('L', (s, s), 0)
    sq.paste(a, ((s - w) // 2, (s - h) // 2))
    # 1/16 留白:菜单栏里与邻居同高不顶格
    pad = s // 16
    sq = ImageOps.expand(sq, pad, 0)
    return sq


def tinted(alpha: Image.Image, size: int, rgb: tuple[int, int, int]) -> Image.Image:
    drawn = SMALL / f'mark-{size}.png'
    if drawn.exists():
        a = Image.open(drawn).convert('L')
        if a.size != (size, size):
            raise SystemExit(f'{drawn} should be {size}x{size}, got {a.size}')
    else:
        a = alpha.resize((size, size), Image.LANCZOS)
    im = Image.new('RGBA', (size, size), rgb + (0,))
    im.putalpha(a)
    return im


def main() -> None:
    alpha = load_alpha_mark()
    black, white = (0, 0, 0), (255, 255, 255)
    tinted(alpha, 16, black).save(OUT / 'tray-iconTemplate.png')
    tinted(alpha, 32, black).save(OUT / 'tray-iconTemplate@2x.png')
    for tone, rgb in (('light', black), ('dark', white)):
        frames = [tinted(alpha, s, rgb) for s in ICO_SIZES]
        frames[-1].save(OUT / f'tray-icon-{tone}.ico', format='ICO', sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
        tinted(alpha, 32, rgb).save(OUT / f'tray-icon-{tone}.png')
    for f in sorted(OUT.glob('tray-icon*')):
        print(f.relative_to(ROOT), f.stat().st_size, 'bytes')
    # 安卓状态栏通知小图标:同一个字形,白 + 透明(系统只取 alpha 再自己着色),24dp 按五档密度出。
    # capacitor.config.ts 的 LocalNotifications.smallIcon 引用它(product spec)。
    for density, size in ANDROID_NOTIFICATION_ICON_SIZES.items():
        target = ANDROID_RES / f'drawable-{density}' / 'ic_stat_gugu.png'
        target.parent.mkdir(parents=True, exist_ok=True)
        tinted(alpha, size, white).save(target)
        print(target.relative_to(ROOT), target.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
