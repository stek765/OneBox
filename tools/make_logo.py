"""Generates the Onebox logo: many things converging on a single point.
Usage: python3 tools/make_logo.py <style>-<palette> <size> <file.png>   (needs numpy)
Styles: cubovertice, cuboaperto, cuboflussi, archivio (and older ones: flussi, vortice, raggi, scatola, cornici, anello, rombo, orbita). Palettes: grafite, tramonto, crema."""
import math, struct, sys, zlib
import numpy as np

# bg: tile (top-left, bottom-right); ink: strokes; accent: the central dot
PALETTES = {
    'grafite':  dict(bg=((58, 62, 78), (18, 20, 30)), ink=(238, 241, 250), mid=(190, 196, 214), low=(138, 146, 170), dark=(22, 24, 34), accent=(255, 192, 64)),
    'tramonto': dict(bg=((255, 150, 60), (240, 70, 90)), ink=(255, 255, 255), mid=(255, 224, 206), low=(255, 186, 164), dark=(58, 22, 36), accent=(255, 214, 120)),
    'crema':    dict(bg=((250, 246, 238), (226, 218, 204)), ink=(40, 40, 48), mid=(92, 92, 104), low=(140, 140, 152), dark=(250, 246, 238), accent=(240, 110, 60)),
}

class Mask:
    """Boolean mask; coordinates are in N units (scaled for supersampling)."""
    def __init__(s, n, SS):
        s.m, s.SS, s.n = np.zeros((n, n), bool), SS, n
    def capsule(s, a, b, ra, rb):  # segmento con raggio che varia da ra a rb
        k = s.SS
        ax, ay, bx, by, ra, rb = a[0] * k, a[1] * k, b[0] * k, b[1] * k, ra * k, rb * k
        rm = max(ra, rb) + 1
        x0, x1 = int(max(min(ax, bx) - rm, 0)), int(min(max(ax, bx) + rm + 1, s.n))
        y0, y1 = int(max(min(ay, by) - rm, 0)), int(min(max(ay, by) + rm + 1, s.n))
        if x1 <= x0 or y1 <= y0:
            return
        ys, xs = np.mgrid[y0:y1, x0:x1]
        x, y = xs + .5, ys + .5
        dx, dy = bx - ax, by - ay
        t = np.clip(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy or 1e-9), 0, 1)
        s.m[y0:y1, x0:x1] |= np.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= ra + (rb - ra) * t
    def dot(s, c, r):
        s.capsule(c, c, r, r)
    def poly(s, pts, shrink=1.0):  # poligono convesso; shrink < 1 lo restringe verso il centro (fessura tra le facce)
        P = [(px * s.SS, py * s.SS) for px, py in pts]
        g = np.mean(P, axis=0)
        P = [(g[0] + (px - g[0]) * shrink, g[1] + (py - g[1]) * shrink) for px, py in P]
        x0, x1 = int(max(min(p[0] for p in P), 0)), int(min(max(p[0] for p in P) + 2, s.n))
        y0, y1 = int(max(min(p[1] for p in P), 0)), int(min(max(p[1] for p in P) + 2, s.n))
        ys, xs = np.mgrid[y0:y1, x0:x1]
        x, y = xs + .5, ys + .5
        cr = [(P[(i + 1) % len(P)][0] - P[i][0]) * (y - P[i][1]) - (P[(i + 1) % len(P)][1] - P[i][1]) * (x - P[i][0]) for i in range(len(P))]
        s.m[y0:y1, x0:x1] |= np.all([q >= 0 for q in cr], axis=0) | np.all([q <= 0 for q in cr], axis=0)
    def field(s, fn):  # shape defined by a function of (x, y) in N units, evaluated over the whole canvas
        ys, xs = np.mgrid[0:s.n, 0:s.n]
        s.m |= fn((xs + .5) / s.SS, (ys + .5) / s.SS)

def rsq(x, y, c, h, r):  # quadrato arrotondato di mezzo lato h e raggio r
    return np.hypot(np.maximum(np.abs(x - c) - (h - r), 0), np.maximum(np.abs(y - c) - (h - r), 0)) <= r

def polar(c, r, a):
    return (c + r * math.cos(a), c + r * math.sin(a))

def cube_layers(N, SS, style):
    """Boxes: returns [(mask, color name)] in drawing order."""
    c = N / 2
    M = lambda: Mask(N * SS, SS)
    if style == 'archivio':   # scatola vista di fronte (coperchio + corpo), il punto al centro del corpo
        lid, body, dot = M(), M(), M()
        lid.capsule((c - .22 * N, c - .20 * N), (c + .22 * N, c - .20 * N), .07 * N, .07 * N)
        body.field(lambda x, y: (np.maximum(np.abs(x - c) - (.20 * N - .05 * N), 0) ** 2 + np.maximum(np.abs(y - (c + .12 * N)) - (.17 * N - .05 * N), 0) ** 2) ** .5 <= .05 * N)
        dot.dot((c, c + .12 * N), .06 * N)
        return [(body.m, 'mid'), (lid.m, 'ink'), (dot.m, 'accent')]
    R = {'cubovertice': .30, 'cuboaperto': .27, 'cuboflussi': .27}[style] * N
    cy = c + (0 if style == 'cubovertice' else .06 * N)
    V = [(c + R * math.cos(a), cy + R * math.sin(a)) for a in map(math.radians, (-90, -30, 30, 90, 150, 210))]
    C = (c, cy)
    top, left, right = [V[0], V[1], C, V[5]], [V[5], C, V[3], V[4]], [V[1], V[2], V[3], C]
    mt, ml, mr, md = M(), M(), M(), M()
    ml.poly(left, .95); mr.poly(right, .95)
    if style == 'cubovertice':   # tre facce che convergono su un solo punto
        mt.poly(top, .95); md.dot(C, .07 * N)
        return [(mt.m, 'ink'), (ml.m, 'mid'), (mr.m, 'low'), (md.m, 'accent')]
    # scatola con l'apertura in alto: bordo chiaro, dentro scuro, il punto sul fondo
    rim, inner, dot, fl = M(), M(), M(), M()
    rim.poly(top, .97); inner.poly(top, .66)
    T = (c, cy - R / 2)
    dot.dot(T, .05 * N)
    if style == 'cuboaperto':   # tre puntini che cadono dentro
        for dx, dy, r in ((-.11, -.07, .02), (0, -.14, .028), (.11, -.07, .02)):
            fl.dot((c + dx * N, V[0][1] + dy * N), r * N)
    else:                       # scie che convergono dall'esterno
        for deg in (-165, -125, -55, -15):
            u = (math.cos(math.radians(deg)), math.sin(math.radians(deg)))
            fl.capsule((T[0] + .42 * N * u[0], T[1] + .42 * N * u[1]), (T[0] + .14 * N * u[0], T[1] + .14 * N * u[1]), .006 * N, .02 * N)
    return [(ml.m, 'mid'), (mr.m, 'low'), (rim.m, 'ink'), (inner.m, 'dark'), (fl.m, 'ink'), (dot.m, 'accent')]

def flows(N, SS, style):
    if style in ('cubovertice', 'cuboaperto', 'cuboflussi', 'archivio'):
        return cube_layers(N, SS, style)
    c = N / 2
    ink, acc = Mask(N * SS, SS), Mask(N * SS, SS)
    if style == 'flussi':   # punti che si ingrandiscono avvicinandosi al centro
        for k in range(8):
            a = math.radians(-90 + k * 45)
            for r, d in ((.37, .012), (.29, .018), (.22, .026), (.155, .036)):
                ink.dot(polar(c, r * N, a), d * N)
    elif style == 'vortice':  # tre bracci che si avvolgono e si ispessiscono verso il centro
        for k in range(3):
            a0 = math.radians(-90 + k * 120)
            pts = [(polar(c, (.40 * (1 - s) + .07 * s) * N, a0 + 2.3 * s), (.008 + .032 * s) * N) for s in (i / 70 for i in range(71))]
            for (p, rp), (q, rq) in zip(pts, pts[1:]):
                ink.capsule(p, q, rp, rq)
    elif style == 'raggi':    # raggi che si assottigliano verso l'esterno
        for k in range(8):
            a = math.radians(-67.5 + k * 45)
            ink.capsule(polar(c, .39 * N, a), polar(c, .11 * N, a), .005 * N, .027 * N)
    elif style == 'scatola':  # scatola aperta: ricevono dall'alto, il punto sta dentro
        o = .07 * N
        for a, b in (((c - .23 * N, c - .20 * N + o), (c - .23 * N, c + .20 * N + o)), ((c - .23 * N, c + .20 * N + o), (c + .23 * N, c + .20 * N + o)), ((c + .23 * N, c + .20 * N + o), (c + .23 * N, c - .20 * N + o))):
            ink.capsule(a, b, .036 * N, .036 * N)
        for dx, dy, r in ((-.13, -.31, .022), (0, -.35, .03), (.13, -.31, .022)):
            ink.dot((c + dx * N, c + dy * N + o), r * N)
    elif style == 'cornici':  # quattro angoli, come un mirino, e il punto al centro
        for sx in (-1, 1):
            for sy in (-1, 1):
                p = (c + sx * .26 * N, c + sy * .26 * N)
                ink.capsule(p, (p[0] - sx * .14 * N, p[1]), .03 * N, .03 * N)
                ink.capsule(p, (p[0], p[1] - sy * .14 * N), .03 * N, .03 * N)
    elif style == 'anello':   # quadrato con un varco per lato, da cui entrano i punti
        h, t, g = .27 * N, .05 * N, .07 * N
        def ring(x, y):
            r = rsq(x, y, c, h, .09 * N) & ~rsq(x, y, c, h - t, .04 * N)
            dx, dy = np.abs(x - c), np.abs(y - c)
            return r & ~((dx < g) & (dy > h - 1.5 * t)) & ~((dy < g) & (dx > h - 1.5 * t))
        ink.field(ring)
        for k in range(4):
            a = math.radians(-90 + k * 90)
            for r, d in ((.205, .018), (.15, .026)):
                ink.dot(polar(c, r * N, a), d * N)
    elif style == 'rombo':    # quadrato ruotato
        ink.field(lambda x, y: (np.abs(x - c) + np.abs(y - c) <= .30 * N) & (np.abs(x - c) + np.abs(y - c) >= .205 * N))
    elif style == 'orbita':   # cerchio con tre varchi
        def arcs(x, y):
            rr = np.hypot(x - c, y - c)
            ang = np.degrees(np.arctan2(y - c, x - c))
            gap = np.zeros_like(rr, bool)
            for a0 in (-90, 30, 150):
                gap |= np.abs((ang - a0 + 180) % 360 - 180) < 14
            return (np.abs(rr - .30 * N) <= .024 * N) & ~gap
        ink.field(arcs)
        for a0 in (-90, 30, 150):
            ink.dot(polar(c, .19 * N, math.radians(a0)), .025 * N)
    else:
        raise SystemExit(f'stile sconosciuto: {style}')
    cy = c + (.07 * N if style == 'scatola' else 0)
    acc.dot((c, cy), .08 * N * {'raggi': 1.15, 'scatola': 1.05, 'cornici': 1.1, 'rombo': .95}.get(style, 1))
    return [(ink.m, 'ink'), (acc.m, 'accent')]

def render(name, N=1024, SS=2):
    style, pal = name.split('-')
    p, n = PALETTES[pal], N * SS
    ys, xs = np.mgrid[0:n, 0:n]
    x, y = (xs + .5) / SS, (ys + .5) / SS
    dx, dy = np.maximum(np.abs(x - N / 2) - N * .26, 0), np.maximum(np.abs(y - N / 2) - N * .26, 0)
    alpha = (np.hypot(dx, dy) <= N * .2)[..., None].astype(float)  # tessera arrotondata
    c0, c1 = (np.array(v, float) for v in p['bg'])
    t = np.clip((x + y) / (2 * N), 0, 1)[..., None]
    rgb = c0 * (1 - t) + c1 * t
    for m, key in flows(N, SS, style):
        rgb = np.where(m[..., None], np.array(p[key], float), rgb)
    red = lambda z: z.reshape(N, SS, N, SS, -1).mean(axis=(1, 3))
    A, P = red(alpha), red(rgb * alpha)
    return np.concatenate([np.where(A > 0, P / np.maximum(A, 1e-6), 0), A * 255], axis=2).clip(0, 255).astype(np.uint8)

def save(img, path):
    N = img.shape[0]
    raw = b''.join(b'\x00' + img[i].tobytes() for i in range(N))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

if __name__ == '__main__':
    save(render(sys.argv[1], int(sys.argv[2])), sys.argv[3])
