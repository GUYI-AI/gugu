# PDF CMap regression fixture

`cff-cjk-no-tounicode.pdf` is generated from the adjacent, original TeX source with
XeLaTeX (TeX Live 2025):

```sh
xelatex -interaction=nonstopmode -halt-on-error cff-cjk-no-tounicode.tex
```

FandolSong-Regular is embedded as a subset CID Type 0C font with Identity-H encoding
and no ToUnicode map. PDF.js therefore needs the external Adobe-GB1-UCS2 CMap. The
Latin text provides a control: it remains readable even when the Chinese disappears.
The fixture contains no user document content. Fandol's font embedding exception
permits distributing documents created with the font.
