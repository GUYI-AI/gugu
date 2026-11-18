"""Writes the pdf.js resource regression fixtures next to this script.

  python3 make-pdfjs-resource-fixtures.py   # needs Pillow built with OpenJPEG

standard-font-zapfdingbats.pdf: ZapfDingbats text with no embedded font program. In a browser
pdf.js substitutes system fonts for the standard 14 except Symbol and ZapfDingbats, whose glyphs
it reads from `standardFontDataUrl` (FoxitDingbats.pfb).

jpx-image.pdf: one JPXDecode (JPEG 2000) image, a red square on white. pdf.js decodes it with
OpenJPEG from `wasmUrl` (openjpeg.wasm, or openjpeg_nowasm_fallback.js).
"""
import io
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent


def pdf(objects: list[bytes]) -> bytes:
    out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    out += b''.join(b'%010d 00000 n \n' % offset for offset in offsets)
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
    return bytes(out)


def stream(dictionary: bytes, data: bytes) -> bytes:
    return b'<< ' + dictionary + b' /Length %d >>\nstream\n' % len(data) + data + b'\nendstream'


def page(resources: bytes, content: bytes) -> list[bytes]:
    return [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ' + resources + b' /Contents 4 0 R >>',
        stream(b'', content),
    ]


standard = page(
    b'<< /Font << /F1 5 0 R /F2 6 0 R >> >>',
    b'BT /F2 14 Tf 20 160 Td (Dingbats control) Tj ET\nBT /F1 72 Tf 20 60 Td (4444) Tj ET',
) + [
    b'<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
]
(HERE / 'standard-font-zapfdingbats.pdf').write_bytes(pdf(standard))

image = Image.new('RGB', (64, 64), 'white')
image.paste((255, 0, 0), (8, 8, 56, 56))
codestream = io.BytesIO()
image.save(codestream, format='JPEG2000', irreversible=False)
jpx = page(
    b'<< /Font << /F2 6 0 R >> /XObject << /Im1 5 0 R >> >>',
    b'BT /F2 14 Tf 20 170 Td (JPX control) Tj ET\nq 128 0 0 128 20 20 cm /Im1 Do Q',
) + [
    stream(b'/Type /XObject /Subtype /Image /Width 64 /Height 64 /Filter /JPXDecode', codestream.getvalue()),
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
]
(HERE / 'jpx-image.pdf').write_bytes(pdf(jpx))
