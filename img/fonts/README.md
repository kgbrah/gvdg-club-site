# Local interface fonts

Archivo (variable weight 100–900) and Bebas Neue are bundled so interface typography works without an external font service, including offline scoring. Full glyph coverage is retained. Both include their SIL Open Font License files in this directory.

`archivo-latin.woff2` is a FontTools subset of `archivo.woff2` holding only the basic Latin range (the same
range Google Fonts calls "latin": U+0000-00FF, common punctuation, €, ™ and a few others), with every glyph,
layout feature and variation axis unchanged; text set in it renders byte-for-byte the same as with the full
file. `tokens.css` declares the two as one family with disjoint `unicode-range`s, so pages download the
smaller file and fetch the full one only when they show a character outside that range. Command:
`pyftsubset archivo.woff2 --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" --layout-features='*' --name-IDs='*' --name-languages='*' --notdef-glyph --notdef-outline --glyph-names --symbol-cmap --legacy-cmap --flavor=woff2 --output-file=archivo-latin.woff2`.

Source files: [Archivo](https://github.com/google/fonts/tree/main/ofl/archivo) and [Bebas Neue](https://github.com/google/fonts/tree/main/ofl/bebasneue), downloaded 2026-11-15. WOFF2 compression uses FontTools without subsetting or changing glyphs. Google Fonts TTF sources are named `Archivo[wdth,wght].ttf` and `BebasNeue-Regular.ttf`.

```json
[
  {
    "file": "archivo.woff2",
    "bytes": 189244,
    "sha256": "63504d593d425ec1bcf211f69e109c72efc4c344f210244913a15fdbe83986be"
  },
  {
    "file": "archivo-latin.woff2",
    "bytes": 96456,
    "sha256": "93e617d129e2e58c1dbdf6e8ded820bc1021485f03beaf6678a1f819b17ac06d"
  },
  {
    "file": "bebas-neue.woff2",
    "bytes": 21556,
    "sha256": "d8fffe1e9541f60fdeb7c8b9e4b67a6d458e05f761485f8eea202c1b37dbae2f"
  }
]
```
