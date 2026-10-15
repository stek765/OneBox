"""Generates the menu bar icons (black on transparent: macOS tints them itself).
Opacity is part of the drawing: the cube faces use 100%, 60% and 35%.
Usage: python3 tools/make_tray.py   -> writes assets/<name>Template@2x.png"""
import math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from make_logo import Mask, save

N, SS = 44, 8  # 22 pt at 2x: standard menu bar icon height

def geometry():
    c, R = N / 2, .49 * N
    V = [(c + R * math.cos(a), c + R * math.sin(a)) for a in map(math.radians, (-90, -30, 30, 90, 150, 210))]
    return c, R, V, (c, c)

def down(mask):  # supersampled mask -> coverage 0..1
    return mask.reshape(N, SS, N, SS).mean(axis=(1, 3))

def parts():
    """The four cube parts as 0..1 coverage: top, left, right, dot."""
    c, R, V, C = geometry()
    top, left, right = [V[0], V[1], C, V[5]], [V[5], C, V[3], V[4]], [V[1], V[2], V[3], C]
    halo = Mask(N * SS, SS); halo.dot(C, .30 * R)
    out = []
    for f in (top, left, right):
        m = Mask(N * SS, SS); m.poly(f, .88)
        out.append(down(m.m & ~halo.m))
    d = Mask(N * SS, SS); d.dot(C, .19 * R)
    out.append(down(d.m))
    return out

def frame(weights, parts_):
    a = sum(w * p for w, p in zip(weights, parts_))
    img = np.zeros((N, N, 4), np.uint8)
    img[..., 3] = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    return img

def shapes(kind):
    c, R, V, C = geometry()
    top, left, right = [V[0], V[1], C, V[5]], [V[5], C, V[3], V[4]], [V[1], V[2], V[3], C]
    M = lambda: Mask(N * SS, SS)
    def faces(shrink):
        m = M()
        for f in (top, left, right):
            m.poly(f, shrink)
        return m.m
    def disc(r):
        m = M(); m.dot(C, r); return m.m
    if kind == 'pieno':       # full silhouette, the dot is a hole
        out = faces(1.02) & ~disc(.19 * R)
    elif kind == 'contorno':  # solo gli spigoli del cubo e il punto
        m = M()
        for v in (V[1], V[3], V[5]):
            m.capsule(C, v, .055 * R, .055 * R)
        inner = M(); inner.poly(V, .72)
        out = (faces(1.02) & ~inner.m) | m.m | disc(.17 * R)
    elif kind == 'aperto':    # scatola con l'apertura in alto, il punto dentro
        rim, hole, side, t = M(), M(), M(), M()
        rim.poly(top, .96); hole.poly(top, .6)
        side.poly(left, .92); side.poly(right, .92)
        t.dot((c, c - R / 2), .13 * R)
        out = side.m | (rim.m & ~hole.m) | t.m
    else:
        raise SystemExit(kind)
    img = np.zeros((N, N, 4), np.uint8)
    img[..., 3] = (down(out) * 255).astype(np.uint8)
    return img

REST = (1, .6, .35, 1)
# startup: the cube builds face by face, then the dot, and ends exactly as at rest
START = [(.15, .15, .15, .15), (1, .15, .15, .15), (1, .6, .15, .15), (1, .6, .35, .15)]
# message arrived: the dot goes off, then blinks
PULSE = [(1, .6, .35, .1), (1, 1, 1, 1)]

if __name__ == '__main__':
    here = os.path.join(os.path.dirname(__file__), '..', 'assets')
    for f in os.listdir(here):
        if f.endswith('Template@2x.png'):
            os.remove(os.path.join(here, f))
    P = parts()
    save(frame(REST, P), os.path.join(here, 'cuboTemplate@2x.png'))
    for i, w in enumerate(START):
        save(frame(w, P), os.path.join(here, f'start-{i}Template@2x.png'))
    for i, w in enumerate(PULSE):
        save(frame(w, P), os.path.join(here, f'pulse-{i}Template@2x.png'))
    for k in ('pieno', 'contorno', 'aperto'):
        save(shapes(k), os.path.join(here, f'{k}Template@2x.png'))
    # update available: same shapes in a soft orange. No "Template" suffix, so macOS keeps the colour
    for k, img in (('cubo', frame(REST, P)), *((k, shapes(k)) for k in ('pieno', 'contorno', 'aperto'))):
        img[..., :3] = (255, 176, 102)
        save(img, os.path.join(here, f'{k}-orange@2x.png'))
    print(sorted(os.listdir(here)))
