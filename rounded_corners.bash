convert app-icon.png -resize 512x512 dummy.png
convert dummy.png \
  -alpha set \
  \( -size 512x512 xc:none \
    -fill white \
    -draw "roundrectangle 20,20 491,491, 75,75" \
  \) \
  -compose DstIn -composite icon-512.png
convert icon-512.png -resize 192x192 icon-192.png
rm dummy.png
