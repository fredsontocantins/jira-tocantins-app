import sys
from PIL import Image

for f in sys.argv[1:]:
    im = Image.open(f).convert("L")
    w, h = im.size
    dark = sum(
        1 for x in range(0, w, 4) for y in range(0, h, 4) if im.getpixel((x, y)) < 120
    )
    total = (w // 4) * (h // 4)
    print(f, w, h, "dark_ratio", round(dark / total, 4))
