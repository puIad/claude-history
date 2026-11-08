"""Copy the Claude desktop app's own typefaces from its local web cache into ui/fonts.

The viewer looks like the desktop app because it uses the same fonts. They are
Anthropic's, so they are never committed (ui/fonts is git-ignored): this script
pulls them from the cache the app already keeps on this machine. Without them the
UI falls back to Segoe UI / Cascadia, which still works.

Needs: pip install fonttools brotli
"""

import gzip
import os
import shutil
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

try:
    from compression import zstd  # Python 3.14+
except ImportError:  # pragma: no cover
    zstd = None
try:
    import brotli
except ImportError:  # pragma: no cover
    brotli = None

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui" / "fonts"

# family name in the font's name table -> (output file, wanted style)
WANT = {
    ("Anthropic Sans", "Regular"): "anthropic-sans.woff2",
    ("Anthropic Sans", "Italic"): "anthropic-sans-italic.woff2",
    ("Anthropic Serif", "Regular"): "anthropic-serif.woff2",
    ("Anthropic Mono", "Regular"): "anthropic-mono.woff2",
    ("Anthropic Mono", "Italic"): "anthropic-mono-italic.woff2",
}


def cache_dirs():
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    roots = list((local / "Claude-Data").glob("*/Cache/Cache_Data"))
    roots += list((local / "Packages").glob("Claude_*/LocalCache/Roaming/Claude*/Cache/Cache_Data"))
    roots += list(Path(os.environ.get("APPDATA", "")).glob("Claude*/Cache/Cache_Data"))
    return [r for r in roots if r.is_dir()]


def decode(raw: bytes) -> bytes:
    if raw[:4] == b"\x28\xb5\x2f\xfd" and zstd:
        return zstd.decompress(raw)
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    if raw[:4] != b"wOF2" and brotli:
        try:
            return brotli.decompress(raw)
        except Exception:
            pass
    return raw


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    best = {}  # key -> (mtime, glyph count, bytes)
    tmp = OUT / "_probe.woff2"
    for d in cache_dirs():
        for f in d.glob("f_*"):
            try:
                data = decode(f.read_bytes())
            except Exception:
                continue
            if data[:4] != b"wOF2":
                continue
            tmp.write_bytes(data)
            try:
                font = TTFont(str(tmp))
                fam = font["name"].getDebugName(1) or ""
                sub = font["name"].getDebugName(2) or ""
                glyphs = len(font.getBestCmap() or {})
                font.close()
            except Exception:
                continue
            for (want_fam, want_sub), name in WANT.items():
                # "Anthropic Sans Variable Text", "Anthropic Sans Beta 26-245-1 Text", "Anthropic Mono Web" ...
                if fam.startswith(want_fam) and "Display" not in fam and sub == want_sub:
                    score = (f.stat().st_mtime, glyphs)
                    if name not in best or score > best[name][0]:
                        best[name] = (score, data)
    tmp.unlink(missing_ok=True)
    for name, (_, data) in best.items():
        (OUT / name).write_bytes(data)
        print("wrote", name, len(data))
    missing = set(WANT.values()) - set(best)
    if missing:
        print("not found in cache (fallback fonts will be used):", ", ".join(sorted(missing)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
