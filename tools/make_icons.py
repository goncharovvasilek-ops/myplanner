"""Генерирует иконки LinkBoard (нужен Pillow): python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 1024
BG = (21, 23, 27)
CARD = (255, 253, 248)
THREAD = (255, 90, 82)
INK = (120, 115, 105)


def quad(p0, c, p1, n=60):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
                    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]))
    return pts


def draw(size_scale=1.0, rounded=True):
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)
    # содержимое ужимаем к центру (для maskable — сильнее)
    def T(x, y):
        return (S / 2 + (x - S / 2) * size_scale, S / 2 + (y - S / 2) * size_scale)

    cards = [(170, 190, 470, 420), (560, 300, 860, 530), (300, 600, 600, 840)]
    centers = [((a + c) / 2, (b + e) / 2) for a, b, c, e in cards]
    w = int(22 * size_scale)
    for (i, j) in [(0, 1), (0, 2), (1, 2)]:
        p0, p1 = centers[i], centers[j]
        mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 + 90)
        d.line([T(*p) for p in quad(p0, mid, p1)], fill=THREAD, width=w, joint="curve")
    for (a, b, c, e) in cards:
        x0, y0 = T(a, b)
        x1, y1 = T(c, e)
        d.rounded_rectangle([x0, y0, x1, y1], radius=int(26 * size_scale), fill=CARD)
        # «строки текста» моноширинной подписи
        lh = (y1 - y0) / 6
        for k in range(3):
            yy = y0 + lh * (2 + k * 1.2)
            d.rounded_rectangle([x0 + lh, yy, x1 - lh * (1.5 + k), yy + lh * 0.45],
                                radius=int(lh * 0.2), fill=INK)
    for (a, b, c, e) in cards:
        x, y = T(c, (b + e) / 2)
        r = 34 * size_scale
        d.ellipse([x - r, y - r, x + r, y + r], fill=THREAD, outline=CARD, width=int(10 * size_scale))
    return img


def main():
    OUT.mkdir(exist_ok=True)
    base = draw(1.0)
    base.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    base.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png")
    base.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png")
    draw(0.78).resize((512, 512), Image.LANCZOS).save(OUT / "icon-512-maskable.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
