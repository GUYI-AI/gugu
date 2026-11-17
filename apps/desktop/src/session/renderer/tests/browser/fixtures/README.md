# pdf.js resource regression fixtures

Used by `../pdfjs-resources.test.tsx`. Each one needs a different pdf.js resource directory that the
renderer build ships under `pdfjs/` (`scripts/build/pdfjs-resources.mts`). None contains user content.

## `cff-cjk-no-tounicode.pdf` — `cMapUrl`

Generated from the adjacent, original TeX source with XeLaTeX (TeX Live 2025):

```sh
xelatex -interaction=nonstopmode -halt-on-error cff-cjk-no-tounicode.tex
```

FandolSong-Regular is embedded as a subset CID Type 0C font with Identity-H encoding
and no ToUnicode map. PDF.js therefore needs the external Adobe-GB1-UCS2 CMap. The
Latin text provides a control: it remains readable even when the Chinese disappears.
Fandol's font embedding exception permits distributing documents created with the font.

## `standard-font-zapfdingbats.pdf` — `standardFontDataUrl`

## `jpx-image.pdf` — `wasmUrl`

Both are written by `make-pdfjs-resource-fixtures.py` (Python 3 with Pillow built with OpenJPEG):

```sh
python3 make-pdfjs-resource-fixtures.py
```

The first draws ZapfDingbats text without an embedded font program. In a browser pdf.js substitutes
system fonts for the other standard 14 fonts, but reads Symbol and ZapfDingbats from its bundled
Foxit fonts. The second holds one JPXDecode (JPEG 2000) image, a red square, which pdf.js decodes
with OpenJPEG. Each page also carries a Helvetica line as a control.
