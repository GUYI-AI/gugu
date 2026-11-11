#!/usr/bin/env python3
"""App 标识图标生成器 —— 唯一出处,❌ 手工导出。

    uv run --with pillow --with numpy python scripts/build/gen-app-icons.py
    uv run --with pillow --with numpy python scripts/build/gen-app-icons.py --check   # 只比对,不写(CI 用)

管的是**咕咕这个应用自己的图标**(Dock / 任务栏 / 桌面 / 启动器上那一个),不是界面里的图标库
(那是 Solar,见 scripts/build/gen-icons.mjs),也不是菜单栏托盘图(那是 scripts/build/gen-tray-icons.py)。

图形是「网点鸽」(owner 2026-11-11 定):墨底上一只向右飞的鸽子,头、身子、近翅是实心白,
远翅和尾巴散成 16 颗点(翅膀 6、尾巴 10,点径 55/43/30 三档,往翼尖、尾尖渐小),和登录页鸟群同一种网点画法。
只有这一只鸟、这一个画法(owner 2026-11-11:❌ 为小尺寸另造一个形状):
  · build-resources/icon-sources/app-icon-source-1024.png   由同目录矢量母版渲染:
    `rsvg-convert -w 1024 -h 1024 app-icon-dots.svg -o app-icon-source-1024.png`。要改图形就改母版再重渲,❌ 直接改 PNG。
  · tray-mark-source.png 是同一张画面换成白底黑形(托盘 / 菜单栏 / 安卓状态栏与主题图标用)。
  · build-resources/icon-sources/small/app-{16,20,24,32,40,48,64}.png   64 像素及以下逐档画好的同一只鸟:
    从 1024 缩下来点会糊成灰,所以这几档按像素格重排了点(格距取整像素、放不下就按同一个排法减颗数),
    由 scripts/build/draw-small-app-icons.py 画出。下面凡是边长正好有这张图的产物都直接用它,没有的才从 1024 缩。

产物:

  · macOS  build-resources/AppIcon.icon/      —— Icon Composer 三态包(浅色/深色/着色)。底色走
           icon.json 的 fill-specializations,图层只留主体、背景必须透明,否则深色态会被糊死。
           ⚠ `X-specializations` 数组不能与同名基础键 `X` 并存,并存时 actool **静默忽略**
           覆盖,包照样编得过、三态却没了 —— 所以这里只写 fill-specializations,不写 fill。
           ⚠ 出 mac 包的机器要 Xcode 26+(electron-builder 会先跑 `actool --version` 卡版本)。
           ⚠ 这个格式只认一张图,系统把它缩到所有尺寸 —— macOS 26 上本来就只能是同一张画面缩小。实测过(macOS 26.5):包里有 Assets.car 时系统
           完全不看 icon.icns。想让 macOS 26 也按尺寸换图,只能不用这个格式,同时丢掉玻璃质感和着色态(现在不需要换图)。
  · macOS  build-resources/icon.icns          —— 传统格式 10 档。满幅自带圆角,❌ 别用经典的 824/1024
           安全区:线上那份就是满幅,缩到 80% 会在 Dock 里比邻居小一圈。
           ⚠ 这份必须靠 electron-builder.cjs 的 afterPack 手动盖进包里:`mac.icon` 指向
           `.icon` 之后,electron-builder 改用 actool 现派生一份 icns,而那份**只有 16/128
           两档**,macOS 25 及更早会拿 256px 往上拉。
  · Windows build-resources/icon.ico          —— 9 档 16/20/24/32/40/48/64/128/256。
  · Linux   public/assets/app/gugu-icon-512.png —— AppImage 主图;同一张也是设置页/关于页
           显示的应用图标与默认头像(有 supabase 迁移与 e2e 钉着路径,❌ 别改文件名)。
  · 界面   public/assets/app/gugu-icon-small.png —— 同一张画面 128 像素,给界面里显示边长 ≤ 32 的地方
           (标签页图标、订阅行、出错页)用。这张是浏览器按显示尺寸现缩的,用不上逐档画好的那几张。
  · Android apps/mobile/android/app/src/main/res/ —— 自适应图标三层 × 五档密度:
           ic_launcher_foreground(彩色)、**ic_launcher_monochrome(Android 13+ 主题图标,
           系统只取 alpha 自己着色)**、以及 Android 7 及更早认的 ic_launcher / _round 方圆图。
           几何按规范:画布 108dp,遮罩后可见 72dp,保证安全区 66dp。前景层只有鸟(透明底),
           底色在背景层,所以整张 1024 画面铺 ADAPTIVE_FG_DP=68dp(不是 72)—— 最远的翼尖离画面中心 481px,
           铺 72dp 时 33.8dp 压出安全区半径 33dp,铺 68dp 时 31.9dp,圆形遮罩切不到。换图形后要重新算这个数。
           主题层复用单色标 build-resources/icon-sources/tray-mark-source.png,与托盘图同源。
"""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'build-resources' / 'icon-sources' / 'app-icon-source-1024.png'
SMALL = ROOT / 'build-resources' / 'icon-sources' / 'small'
MONO_SRC = ROOT / 'build-resources' / 'icon-sources' / 'tray-mark-source.png'
PACKAGING = ROOT / 'build-resources'
PUBLIC = ROOT / 'public'
ANDROID_RES = ROOT / 'apps' / 'mobile' / 'android' / 'app' / 'src' / 'main' / 'res'

INK = (26, 28, 31)              # 底色 = 界面品牌色 --primary(tokens.css 浅色主题的墨 #1a1c1f)
ICNS_SIZES = [16, 32, 128, 256, 512]
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
# mdpi 1× / hdpi 1.5× / xhdpi 2× / xxhdpi 3× / xxxhdpi 4×
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
ADAPTIVE_CANVAS_DP = 108
ADAPTIVE_SAFE_DP = 66           # 保证安全区,所有遮罩形状下都完整
ADAPTIVE_VISIBLE_DP = 72        # 遮罩后可见的范围
ADAPTIVE_FG_DP = 68             # 前景层鸟那一张铺多大:整张 1024 铺满 72dp 时翼尖离中心 33.8dp,压出安全区(33dp)0.8dp,缩到 68dp 后 31.9dp
LEGACY_DP = 48

CHECK = '--check' in sys.argv
_writes: list[tuple[Path, bytes]] = []


def emit(path: Path, data: bytes) -> None:
    _writes.append((path, data))


def emit_image(path: Path, img: Image.Image, **kw) -> None:
    import io
    buf = io.BytesIO()
    img.save(buf, format=kw.pop('format', 'PNG'), **kw)
    emit(path, buf.getvalue())


def squircle(size: int, radius_ratio: float = 0.2237, ss: int = 8) -> Image.Image:
    """Apple 连续圆角的近似:超采样画圆角矩形再缩回,边缘不毛。"""
    n = size * ss
    m = Image.new('L', (n, n), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * radius_ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle(size: int, ss: int = 8) -> Image.Image:
    n = size * ss
    m = Image.new('L', (n, n), 0)
    ImageDraw.Draw(m).ellipse([0, 0, n - 1, n - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


_art: dict[str, Image.Image] = {}


def art(size: int) -> Image.Image:
    """size 像素的满幅画面:有逐档画好的就用那张,没有才从 1024 缩。"""
    drawn = SMALL / f'app-{size}.png'
    if drawn.exists():
        im = Image.open(drawn).convert('RGB')
        if im.size != (size, size):
            raise SystemExit(f'{drawn} 应该是 {size}×{size},实际 {im.size}')
        return im
    return _art['full'].resize((size, size), Image.LANCZOS)


def rounded(size: int) -> Image.Image:
    im = art(size).convert('RGBA')
    im.putalpha(squircle(size))
    return im


def load_mono_alpha() -> Image.Image:
    """单色标 → alpha 方图,带 1/8 内边距(主题图标被系统裁得比彩色图更狠,不留白会顶格)。"""
    g = Image.open(MONO_SRC).convert('L')
    a = ImageOps.invert(g).point(lambda v: 0 if v < 40 else (255 if v > 215 else v))
    bb = a.getbbox()
    if not bb:
        raise SystemExit(f'单色标里没有暗像素: {MONO_SRC}')
    a = a.crop(bb)
    w, h = a.size
    s = max(w, h)
    sq = Image.new('L', (s, s), 0)
    sq.paste(a, ((s - w) // 2, (s - h) // 2))
    return ImageOps.expand(sq, s // 8, 0)


def adaptive_layer(src: Image.Image, canvas_px: int, content_dp: int) -> Image.Image:
    n = int(round(canvas_px * content_dp / ADAPTIVE_CANVAS_DP))
    im = src.resize((n, n), Image.LANCZOS)
    c = Image.new('RGBA', (canvas_px, canvas_px), (0, 0, 0, 0))
    o = (canvas_px - n) // 2
    c.paste(im, (o, o), im)
    return c


def srgb(rgb: tuple[int, int, int]) -> str:
    return 'extended-srgb:' + ','.join(f'{c / 255:.5f}' for c in rgb) + ',1.00000'


def build() -> None:
    full = Image.open(SRC).convert('RGB')
    if full.size != (1024, 1024):
        raise SystemExit(f'源图必须是 1024×1024,实际 {full.size}')
    _art.update(full=full)

    # --- macOS 三态包 ---
    import numpy as np
    lum = np.asarray(full.convert('L')).astype(float)
    # 图层只留鸟:白色 + 透明度。透明度按亮度从底色线性拉到纯白,保住点边缘的抗锯齿
    base = sum(INK) / 3
    alpha = np.clip((lum - base) / (255 - base), 0, 1)
    rgba = np.dstack([np.full(lum.shape + (3,), 255, np.uint8), (alpha * 255).round().astype(np.uint8)])
    layer = Image.fromarray(rgba, 'RGBA')
    emit_image(PACKAGING / 'AppIcon.icon' / 'Assets' / 'gugu.png', layer)
    emit(PACKAGING / 'AppIcon.icon' / 'icon.json', (json.dumps({
        # 图标本身就是深色,浅色态和深色态用同一个底色;两条都留着是因为这个写法实测编得过
        'fill-specializations': [
            {'value': {'solid': srgb(INK)}},
            {'appearance': 'dark', 'value': {'solid': srgb(INK)}},
        ],
        'groups': [{
            'layers': [{'image-name': 'gugu.png', 'name': 'gugu'}],
            'shadow': {'kind': 'neutral', 'opacity': 0.35},
        }],
        'supported-platforms': {'squares': 'shared'},
    }, indent=2) + '\n').encode())

    # --- macOS 传统 icns ---
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / 'gugu.iconset'
        iconset.mkdir()
        for base_px in ICNS_SIZES:
            rounded(base_px).save(iconset / f'icon_{base_px}x{base_px}.png')
            rounded(base_px * 2).save(iconset / f'icon_{base_px}x{base_px}@2x.png')
        out = Path(td) / 'icon.icns'
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(out)], check=True)
        emit(PACKAGING / 'icon.icns', out.read_bytes())

    # --- Windows ico ---
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'icon.ico'
        # 每一档自己出图,不能让 Pillow 拿最大那张往下缩
        frames = [rounded(s_) for s_ in ICO_SIZES]
        frames[-1].save(p, format='ICO', sizes=[(s_, s_) for s_ in ICO_SIZES], append_images=frames[:-1])
        ico = Image.open(p)
        got = sorted(ico.info.get('sizes', []))
        # Pillow 的 sizes= 会静默降级 —— 曾经出过「只有一个 16×16、828 字节」的 ico,必须当场断言
        if got != sorted([(s_, s_) for s_ in ICO_SIZES]):
            raise SystemExit(f'ico 尺寸不全: {[s_[0] for s_ in got]}')
        # 同样要当场断言每一档真是我们给的那张,而不是 Pillow 自己缩出来的
        for s_, want in zip(ICO_SIZES, frames):
            ico.size = (s_, s_)
            ico.load()
            if ico.convert('RGBA').tobytes() != want.tobytes():
                raise SystemExit(f'ico 的 {s_} 像素档不是指定的那张图')
        emit(PACKAGING / 'icon.ico', p.read_bytes())

    # --- Linux / 设置页 / 默认头像,以及界面里的小尺寸用图 ---
    emit_image(PUBLIC / 'assets' / 'app' / 'gugu-icon-512.png', rounded(512))
    small_128 = full.resize((128, 128), Image.LANCZOS).convert('RGBA')
    small_128.putalpha(squircle(128))
    emit_image(PUBLIC / 'assets' / 'app' / 'gugu-icon-small.png', small_128)

    # --- Android ---
    fg = layer
    mono_sq = load_mono_alpha()
    mono = Image.new('RGBA', mono_sq.size, (0, 0, 0, 0))
    mono.putalpha(mono_sq)
    for name, mult in DENSITIES.items():
        d = ANDROID_RES / f'mipmap-{name}'
        canvas = int(round(ADAPTIVE_CANVAS_DP * mult))
        emit_image(d / 'ic_launcher_foreground.png', adaptive_layer(fg, canvas, ADAPTIVE_FG_DP))
        emit_image(d / 'ic_launcher_monochrome.png', adaptive_layer(mono, canvas, ADAPTIVE_SAFE_DP))
        px = int(round(LEGACY_DP * mult))
        base = art(px).convert('RGBA')
        sq = base.copy(); sq.putalpha(squircle(px))
        emit_image(d / 'ic_launcher.png', sq)
        ci = base.copy(); ci.putalpha(circle(px))
        emit_image(d / 'ic_launcher_round.png', ci)

    adaptive_xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background"/>\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
        '</adaptive-icon>\n'
    )
    for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        emit(ANDROID_RES / 'mipmap-anydpi-v26' / f, adaptive_xml.encode())
    emit(ANDROID_RES / 'values' / 'ic_launcher_background.xml',
         ('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
          f'    <color name="ic_launcher_background">#{INK[0]:02X}{INK[1]:02X}{INK[2]:02X}</color>\n'
          '</resources>\n').encode())


def main() -> int:
    build()
    stale = []
    for path, data in _writes:
        old = path.read_bytes() if path.exists() else None
        if old == data:
            continue
        if CHECK:
            stale.append(path.relative_to(ROOT))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    if CHECK:
        if stale:
            print('以下产物与源图对不上,跑 `python scripts/build/gen-app-icons.py` 重生:', file=sys.stderr)
            for p in stale:
                print(f'  {p}', file=sys.stderr)
            return 1
        print(f'gen-app-icons: {len(_writes)} 个产物均与源图一致')
    else:
        print(f'gen-app-icons: 写入 {len(_writes)} 个产物')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
