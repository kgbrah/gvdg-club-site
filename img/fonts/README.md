# Local interface fonts

Archivo (variable weight 100–900) and Bebas Neue are bundled so interface typography works without an external font service, including offline scoring. Full glyph coverage is retained. Both include their SIL Open Font License files in this directory.

Source files: [Archivo](https://github.com/google/fonts/tree/main/ofl/archivo) and [Bebas Neue](https://github.com/google/fonts/tree/main/ofl/bebasneue), downloaded 2026-11-15. WOFF2 compression uses FontTools without subsetting or changing glyphs. Google Fonts TTF sources are named `Archivo[wdth,wght].ttf` and `BebasNeue-Regular.ttf`.

```json
[
  {
    "file": "archivo.woff2",
    "bytes": 189244,
    "sha256": "63504d593d425ec1bcf211f69e109c72efc4c344f210244913a15fdbe83986be"
  },
  {
    "file": "bebas-neue.woff2",
    "bytes": 21556,
    "sha256": "d8fffe1e9541f60fdeb7c8b9e4b67a6d458e05f761485f8eea202c1b37dbae2f"
  }
]
```
