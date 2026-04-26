convert app-icon.png -resize 512x512 dummy.png
convert dummy.png \
  -alpha set \
  \( -size 512x512 xc:none \
    -fill white \
    -draw "roundrectangle 20,20 491,491, 75,75" \
  \) \
  -compose DstIn -composite icon-512.png

convert icon-512.png -resize 192x192 icon-192.png
convert icon-512.png -resize 180x180 apple-touch-icon.png

convert icon-512.png \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  -delete 0 favicon.ico

rm dummy.png
