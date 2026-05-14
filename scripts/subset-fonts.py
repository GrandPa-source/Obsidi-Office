#!/usr/bin/env python3
"""
subset-fonts.py — produce metric-only TTF subsets for x2t.

x2t (the OnlyOffice docx <-> Editor.bin converter) reads font metric tables
during conversion to compute layout-precise widths. It does NOT need glyph
outlines. Stripping outlines + hinting + decorative tables shrinks each
font ~75% (Arial: 1016 KB -> 251 KB) without affecting Editor.bin output.

Replicates the empirical strategy validated in /tmp/font-poc/:
  KEEP : GDEF, GPOS, GSUB, OS/2, VDMX, cmap, hdmx, head, hhea, hmtx, maxp, name, post
  DROP : glyf, loca, fpgm, cvt, gasp, prep, LTSH, kern, meta, JSTF, PCLT, DSIG
  NAME : strip to platformID=3 records 0-6 (essential identification only)

For .ttc collections (e.g. cambria.ttc), each face is extracted as a
separate .ttf in the output directory.

Usage:
  python subset-fonts.py --src C:/Windows/Fonts --out ../assets/x2t-fonts
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from fontTools.ttLib import TTFont, TTCollection

DROP_TABLES = {
    "glyf", "loca",
    "fpgm", "cvt ", "gasp", "prep",
    "LTSH", "kern", "meta", "JSTF", "PCLT", "DSIG",
    "hdmx",  # also drop hdmx (PoC kept it but it is purely bitmap-rendering — x2t doesn't need it)
}

KEEP_NAME_IDS = set(range(7))  # 0..6 (copyright, family, subfamily, unique, full, version, postscript)

# Default font list — Latin core + symbol fonts that ship with Windows.
# Ordered roughly by use frequency in .docx documents.
DEFAULT_FONTS = [
    # Arial family (4 styles)
    "arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf",
    # Calibri family (default Office body — 4 styles + Light reg/italic)
    "calibri.ttf", "calibrib.ttf", "calibrii.ttf", "calibriz.ttf",
    "calibril.ttf", "calibrili.ttf",
    # Cambria (TTC has Regular + Math; Bold/Italic/BoldItalic are separate files)
    "cambria.ttc",
    "cambriab.ttf", "cambriai.ttf", "cambriaz.ttf",
    # Times New Roman
    "times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf",
    # Verdana
    "verdana.ttf", "verdanab.ttf", "verdanai.ttf", "verdanaz.ttf",
    # Tahoma
    "tahoma.ttf", "tahomabd.ttf",
    # Georgia
    "georgia.ttf", "georgiab.ttf", "georgiai.ttf", "georgiaz.ttf",
    # Courier New
    "cour.ttf", "courbd.ttf", "couri.ttf", "courbi.ttf",
    # Comic Sans MS
    "comic.ttf", "comicbd.ttf", "comici.ttf", "comicz.ttf",
    # Trebuchet MS
    "trebuc.ttf", "trebucbd.ttf", "trebucit.ttf", "trebucbi.ttf",
    # Impact
    "impact.ttf",
    # Symbol fonts
    "symbol.ttf",
    "webdings.ttf",
]


def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.2f} MB"


def strip_name_table(font: TTFont) -> int:
    """Keep only platformID=3 records with nameID in KEEP_NAME_IDS. Returns
    bytes saved (approximate)."""
    nt = font["name"]
    before = len(nt.names)
    nt.names = [
        rec for rec in nt.names
        if rec.platformID == 3 and rec.nameID in KEEP_NAME_IDS
    ]
    return before - len(nt.names)


def subset_font(font: TTFont) -> dict:
    """In-place: drop unwanted tables and trim name records. Returns a small
    summary dict for logging."""
    dropped = []
    for tag in list(font.keys()):
        # fontTools normalizes table tags to 4-char strings (sometimes with
        # trailing space, e.g. 'cvt '). Compare against the same form.
        norm = tag if len(tag) == 4 else tag.ljust(4)
        if norm in DROP_TABLES:
            del font[tag]
            dropped.append(tag.strip())
    name_records_dropped = strip_name_table(font)
    return {"tables_dropped": dropped, "name_records_dropped": name_records_dropped}


def get_font_basename(font: TTFont) -> str:
    """Extract a filesystem-safe basename from the font's name table:
    family + subfamily, e.g. 'Cambria-Bold'."""
    nt = font["name"]
    family = nt.getName(1, 3, 1, 1033) or nt.getName(1, 3, 1, 0)
    subfamily = nt.getName(2, 3, 1, 1033) or nt.getName(2, 3, 1, 0)
    fam = str(family) if family else "Unknown"
    sub = str(subfamily) if subfamily else "Regular"
    safe = (fam + "-" + sub).replace(" ", "")
    safe = "".join(c for c in safe if c.isalnum() or c in "-_")
    return safe


def process_ttf(src: Path, out_dir: Path) -> tuple[int, int]:
    src_size = src.stat().st_size
    font = TTFont(str(src), recalcTimestamp=False)
    summary = subset_font(font)
    out_path = out_dir / src.name
    font.save(str(out_path))
    out_size = out_path.stat().st_size
    print(f"  {src.name:24} {fmt_bytes(src_size):>10} -> {fmt_bytes(out_size):>10}  "
          f"(-{(1 - out_size / src_size) * 100:4.1f}%)  dropped: {','.join(summary['tables_dropped'])}")
    return src_size, out_size


def process_ttc(src: Path, out_dir: Path) -> tuple[int, int]:
    src_size = src.stat().st_size
    coll = TTCollection(str(src))
    total_out = 0
    print(f"  {src.name:24} (TTC, {len(coll.fonts)} faces)")
    for i, font in enumerate(coll.fonts):
        summary = subset_font(font)
        basename = get_font_basename(font)
        out_path = out_dir / (basename + ".ttf")
        # Avoid clobbering: if two faces produce the same name, append index
        if out_path.exists():
            out_path = out_dir / (basename + f"-{i}.ttf")
        # Convert TTCFont -> standalone TTF by saving (fontTools handles this)
        font.save(str(out_path))
        out_size = out_path.stat().st_size
        total_out += out_size
        print(f"      face[{i}] -> {out_path.name:30} {fmt_bytes(out_size):>10}  "
              f"dropped: {','.join(summary['tables_dropped'])}")
    print(f"      ttc total: {fmt_bytes(src_size)} -> {fmt_bytes(total_out)}  "
          f"(-{(1 - total_out / src_size) * 100:4.1f}%)")
    return src_size, total_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"C:\Windows\Fonts",
                    help="Source font directory (default: %(default)s)")
    ap.add_argument("--out", required=True,
                    help="Output directory for subsetted .ttf files")
    ap.add_argument("--fonts", nargs="*", default=None,
                    help="Specific font filenames to process (default: built-in core list)")
    ap.add_argument("--clean", action="store_true",
                    help="Remove existing files in --out before subsetting")
    args = ap.parse_args()

    src_dir = Path(args.src)
    out_dir = Path(args.out)
    fonts_list = args.fonts if args.fonts else DEFAULT_FONTS

    if not src_dir.is_dir():
        print(f"source dir not found: {src_dir}", file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    if args.clean:
        for f in out_dir.iterdir():
            if f.is_file():
                f.unlink()

    print(f"src:  {src_dir}")
    print(f"out:  {out_dir}")
    print(f"fonts: {len(fonts_list)} files in list")
    print()
    print("processing...")

    total_in = 0
    total_out = 0
    skipped = []
    processed = 0

    for filename in fonts_list:
        src = src_dir / filename
        if not src.is_file():
            skipped.append(filename)
            continue
        try:
            if filename.lower().endswith(".ttc"):
                a, b = process_ttc(src, out_dir)
            else:
                a, b = process_ttf(src, out_dir)
            total_in += a
            total_out += b
            processed += 1
        except Exception as exc:
            print(f"  {filename}: ERROR {exc}", file=sys.stderr)
            skipped.append(filename + " (error)")

    print()
    print(f"processed: {processed} files")
    print(f"skipped:   {len(skipped)} files: {', '.join(skipped) if skipped else '(none)'}")
    print(f"in:        {fmt_bytes(total_in)}")
    print(f"out:       {fmt_bytes(total_out)}  ({(1 - total_out / total_in) * 100:.1f}% reduction)")
    out_files = list(out_dir.glob("*.ttf"))
    print(f"output:    {len(out_files)} .ttf files in {out_dir}")


if __name__ == "__main__":
    main()
