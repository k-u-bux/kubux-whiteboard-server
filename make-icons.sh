#!/usr/bin/env bash
# Derive the web-app icon set from app-icon.svg.
# Requires rsvg-convert (nixpkgs#librsvg) and magick (nixpkgs#imagemagick).
#
# Output files (same names the manifest/index.html already reference):
#   icon-512.png, icon-192.png, apple-touch-icon.png, favicon.ico
#
# Note: rsvg-convert keeps the SVG's transparent corners transparent
# (magick renders SVGs on an opaque white canvas — do not use it to rasterize).

set -euo pipefail

SRC="app-icon.svg"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (nix shell nixpkgs#librsvg)" >&2; exit 1; }
command -v magick >/dev/null || { echo "magick not found (nix shell nixpkgs#imagemagick)" >&2; exit 1; }

[ -f "$SRC" ] || { echo "$SRC not found in $(pwd)" >&2; exit 1; }

# PWA / manifest icons
rsvg-convert -w 512 -h 512 -o icon-512.png  "$SRC"
rsvg-convert -w 192 -h 192 -o icon-192.png  "$SRC"

# iOS home-screen icon (Apple flattens transparency to black, so composite
# onto the tile color to avoid black corners on the device)
magick icon-512.png -resize 180x180 -background '#0078D7' -alpha remove -alpha off apple-touch-icon.png

# favicon, multi-resolution
magick icon-512.png \
    \( -clone 0 -resize 16x16 \) \
    \( -clone 0 -resize 32x32 \) \
    \( -clone 0 -resize 48x48 \) \
    -delete 0 favicon.ico

echo "generated: icon-512.png icon-192.png apple-touch-icon.png favicon.ico"
