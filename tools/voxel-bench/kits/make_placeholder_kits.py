"""
The two placeholder voxel kits, log (wood) and stone: engine-owned test data
the kit pipeline is measured with, never game art. Writes one GLB a kit (a
node a piece: <case>_<section>_v<k>_<high|low>, all at the file's origin)
and its kit record (kitFormat 1) beside it.

    blender --background --python tools/voxel-bench/kits/make_placeholder_kits.py [-- --out DIR]
    python3 tools/voxel-bench/kits/make_placeholder_kits.py --dry-run   # geometry and checks only, no Blender

Why it is built this way:
- Pieces are written in metres, centred on their cell (the cell is 0.5 m,
  -0.25 .. 0.25 on each axis), in their case's own orientation: the exposed
  face toward +z, a run along +x, up +y (glTF axes; the Blender scene holds
  them turned to Blender's Z-up and the exporter turns them back).
- Only faces that can show are made. Faces against the voxel body behind a
  piece (the wall a half-log lies on, the end face of a log stub against the
  wall) are left out, so no hidden geometry ships.
- UVs follow the trim layout DRAFT (docs/architecture/voxel-trim-layout.md,
  `detail-trim`): square texels at 1024 px/m on a 4096 sheet; on every face
  that is not end-on to the run, U is the distance along the run, 0.25 a
  metre from the cell's -x face (the kit check's T4); V by region at real
  size, a group of faces wrapping one region centred in its band, profiled
  strips only on faces of exactly the strip's height; end faces in the cap
  cell `a` of the next size up. Every UV keeps half a texel inside its region.
- Members are extrusions along one axis of a small profile, so every side
  face is exactly parallel to its run and caps are flat. High and low of a
  piece use the same regions for the same faces (a round member's low is
  the same profile with fewer sides; a flat-faced piece's low is its high),
  so a level switch never jumps the texture.
- Normals: smooth round members, flat hewn and cut faces; no normal bakes
  (a placeholder: the shape carries no fine detail to bake).
- Collision, navigation and light never read these meshes: they come from
  each case's declared shape in the case catalogue.

Everything is a pure function of the tables below: the same script gives
the same bytes (Blender's glTF exporter is deterministic for a scene).
"""
import hashlib
import json
import math
import os
import sys

HALF = 0.25  # half a cell, metres
SHEET = 4096  # authored sheet side, px
PX_M = 1024  # authored px a metre
PERM = PX_M / SHEET  # sheet units a metre
EPS_PX = 0.5  # UVs stay half a texel inside a region

# The draft layout's regions: id -> (kind, metres, y0, y1[, x0, x1]) in px of the authored sheet (glTF v from the top).
REGIONS = {
    'F1': ('field', 1.0, 32, 1056),
    'S50': ('strip', 0.5, 1120, 1632),
    'S50p': ('profiled', 0.5, 1696, 2208),
    'S25': ('strip', 0.25, 2272, 2528),
    'S25p': ('profiled', 0.25, 2592, 2848),
    'S12': ('strip', 0.125, 2912, 3040),
    'S12p': ('profiled', 0.125, 3104, 3232),
    'C50a': ('cap', 0.5, 3296, 3808, 32, 544),
    'C25a': ('cap', 0.25, 3296, 3552, 2336, 2592),
    'C12a': ('cap', 0.125, 3616, 3744, 2336, 2464),
}


class LayoutError(Exception):
    pass


def band(rid):
    r = REGIONS[rid]
    return r[2] / SHEET, r[3] / SHEET


def band_centre(rid):
    y0, y1 = band(rid)
    return (y0 + y1) / 2


def usable_m(rid):
    r = REGIONS[rid]
    return (r[3] - r[2] - 2 * EPS_PX) / PX_M


def fit(rid, length):
    """A face group of `length` metres across fits its region (profiled: exactly the strip's height, the check's ±2 %)."""
    kind, metres = REGIONS[rid][0], REGIONS[rid][1]
    if length > usable_m(rid) + 1e-9:
        raise LayoutError(f'{length:.4f} m does not fit {rid} ({usable_m(rid):.4f} m usable)')
    if kind == 'profiled' and abs(length / metres - 1) > 0.02:
        raise LayoutError(f'{length:.4f} m on profiled {rid} ({metres} m)')


def cap_for(extent):
    for rid in ('C12a', 'C25a', 'C50a'):
        if extent <= usable_m(rid) + 1e-9:
            return rid
    raise LayoutError(f'an end {extent:.3f} m across has no cap cell')


def cap_uv(rid, a, b):
    """UV of a point a, b metres from an end face's centre in its cap cell (real size)."""
    r = REGIONS[rid]
    cu = (r[4] + r[5]) / 2 / SHEET
    cv = (r[2] + r[3]) / 2 / SHEET
    return cu + PERM * a, cv - PERM * b


def run_u(x):
    return PERM * (x + HALF)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a):
    n = math.sqrt(dot(a, a))
    return (a[0] / n, a[1] / n, a[2] / n)


class Piece:
    """One mesh: triangles of (position, normal, uv) corners, glTF axes, wound outward."""

    def __init__(self):
        self.tris = []

    def tri(self, a, b, c, out):
        g = cross(sub(b[0], a[0]), sub(c[0], a[0]))
        if dot(g, out) < 0:
            b, c = c, b
        self.tris.append((a, b, c))

    def quad(self, a, b, c, d, out):
        self.tri(a, b, c, out)
        self.tri(a, c, d, out)

    def add(self, other):
        self.tris.extend(other.tris)
        return self


def mirror_z(piece):
    """The piece mirrored front to back (z negated): the same faces on the back of a one-cell-thick wall, U unchanged."""
    p = Piece()
    flip = lambda c: ((c[0][0], c[0][1], -c[0][2]), (c[1][0], c[1][1], -c[1][2]), c[2])
    for a, b, c in piece.tris:
        # Mirroring turns the winding over; swapping two corners keeps the fronts outward.
        p.tris.append((flip(a), flip(c), flip(b)))
    return p


def circle(r, n, cz=0.0, cy=0.0, start=0.0):
    """An n-gon of radius r round (cz, cy), points counter-clockwise from angle `start` (0: toward -y, the seam down)."""
    return [(cz + r * math.sin(start + 2 * math.pi * k / n), cy - r * math.cos(start + 2 * math.pi * k / n)) for k in range(n)]


def arc(r, n, cz, cy, a0, a1):
    """n segments of a circular arc from angle a0 to a1 (radians from +z, counter-clockwise toward +y)."""
    return [(cz + r * math.cos(a0 + (a1 - a0) * k / n), cy + r * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n + 1)]


def ext_x(pts, regs, x0, x1, centre, closed=False, smooth=False, cap0=False, cap1=False, sides=True):
    """
    A member along x: the profile `pts` [(z, y)] swept from x0 to x1. `regs` is a region a segment (or one for all);
    consecutive segments of one region wrap it as one group, centred in its band. Caps close the ends (flat, convex);
    `sides=False` makes only the caps (an end face closing a member made by another call).
    """
    p = Piece()
    n = len(pts)
    segs = [(i, i + 1) for i in range(n - 1)] + ([(n - 1, 0)] if closed else [])
    if isinstance(regs, str):
        regs = [regs] * len(segs)
    lens = [math.dist(pts[i], pts[j]) for i, j in segs]
    # Groups of consecutive segments in one region: each wraps its region centred.
    vstart = [0.0] * len(segs)
    vstep = [1.0] * len(segs)
    k = 0
    while k < len(segs):
        e = k
        while e + 1 < len(segs) and regs[e + 1] == regs[k]:
            e += 1
        total = sum(lens[k:e + 1])
        fit(regs[k], total)
        # The sheet's top (glTF v 0) toward the member's top, or toward its back on a level face, so the debug
        # labels read upright and every strip's top edge is the face's top edge.
        (z0, y0), (z1, y1) = pts[segs[k][0]], pts[segs[e][1]]
        down = (y1 < y0 - 1e-9) or (abs(y1 - y0) <= 1e-9 and z1 > z0)
        v = band_centre(regs[k]) + (-1 if down else 1) * PERM * total / 2
        for s in range(k, e + 1):
            vstart[s] = v
            vstep[s] = 1.0 if down else -1.0
            v += vstep[s] * PERM * lens[s]
        k = e + 1
    cz, cy = centre

    def seg_normal(s):
        (az, ay), (bz, by) = pts[segs[s][0]], pts[segs[s][1]]
        nz, ny = (by - ay), -(bz - az)
        mz, my = (az + bz) / 2 - cz, (ay + by) / 2 - cy
        if nz * mz + ny * my < 0:
            nz, ny = -nz, -ny
        ln = math.hypot(nz, ny)
        return (0.0, ny / ln, nz / ln)

    normals = [seg_normal(s) for s in range(len(segs))]

    def point_normal(i, s):
        if not smooth:
            return normals[s]
        around = [t for t, (a, b) in enumerate(segs) if a == i or b == i]
        acc = [0.0, 0.0, 0.0]
        for t in around:
            for q in range(3):
                acc[q] += normals[t][q]
        return norm(tuple(acc))

    for s, (i, j) in enumerate(segs if sides else []):
        (az, ay), (bz, by) = pts[i], pts[j]
        va, vb = vstart[s], vstart[s] + vstep[s] * PERM * lens[s]
        ni, nj = point_normal(i, s), point_normal(j, s)
        c = lambda x, z, y, nn, v: ((x, y, z), nn, (run_u(x), v))
        p.quad(c(x0, az, ay, ni, va), c(x1, az, ay, ni, va), c(x1, bz, by, nj, vb), c(x0, bz, by, nj, vb), normals[s])
    for at, want, sign in ((x0, cap0, -1.0), (x1, cap1, 1.0)):
        if not want:
            continue
        zs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        mz, my = (min(zs) + max(zs)) / 2, (min(ys) + max(ys)) / 2
        rid = cap_for(max(max(zs) - min(zs), max(ys) - min(ys)))
        out = (sign, 0.0, 0.0)
        gz, gy = sum(zs) / n, sum(ys) / n
        corner = lambda z, y: ((at, y, z), out, cap_uv(rid, (z - mz) * -sign, y - my))
        for i in range(n):
            j = (i + 1) % n
            p.tri(corner(gz, gy), corner(*pts[i]), corner(*pts[j]), out)
    return p


def ext_y(pts, rid, y0, y1, centre, smooth=False, top=False):
    """A vertical member: the closed profile `pts` [(x, z)] swept from y0 to y1, its sides wrapping `rid` up the member; `top` caps it."""
    fit(rid, y1 - y0)
    p = Piece()
    n = len(pts)
    cx, cz = centre
    vmid = band_centre(rid)
    normals = []
    for i in range(n):
        (ax, az), (bx, bz) = pts[i], pts[(i + 1) % n]
        nx, nz = (bz - az), -(bx - ax)
        if nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0:
            nx, nz = -nx, -nz
        ln = math.hypot(nx, nz)
        normals.append((nx / ln, 0.0, nz / ln))
    for i in range(n):
        j = (i + 1) % n
        (ax, az), (bx, bz) = pts[i], pts[j]
        f = normals[i]
        na = norm(tuple(normals[i][q] + normals[i - 1][q] for q in range(3))) if smooth else f
        nb = norm(tuple(normals[i][q] + normals[j][q] for q in range(3))) if smooth else f
        # Faces end-on to x (the run the check reads) take U across them from z; the rest U from x.
        u = (lambda x, z: run_u(x)) if abs(f[0]) < 0.05 else (lambda x, z: run_u(z))
        c = lambda x, z, y, nn: ((x, y, z), nn, (u(x, z), vmid + PERM * ((y0 + y1) / 2 - y)))
        p.quad(c(ax, az, y0, na), c(bx, bz, y0, nb), c(bx, bz, y1, nb), c(ax, az, y1, na), f)
    if top:
        xs = [q[0] for q in pts]
        zs = [q[1] for q in pts]
        mx, mz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        crid = cap_for(max(max(xs) - min(xs), max(zs) - min(zs)))
        out = (0.0, 1.0, 0.0)
        gx, gz = sum(xs) / n, sum(zs) / n
        corner = lambda x, z: ((x, y1, z), out, cap_uv(crid, x - mx, z - mz))
        for i in range(n):
            p.tri(corner(gx, gz), corner(*pts[i]), corner(*pts[(i + 1) % n]), out)
    return p


def ext_z(pts, rid, z0, z1, centre, smooth=False, cap1=False):
    """A member along z (a log stub out of a corner): the closed profile `pts` [(x, y)] swept from z0 to z1; `cap1` closes its +z end."""
    fit(rid, z1 - z0)
    p = Piece()
    n = len(pts)
    cx, cy = centre
    vmid = band_centre(rid)
    normals = []
    for i in range(n):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
        nx, ny = (by - ay), -(bx - ax)
        if nx * ((ax + bx) / 2 - cx) + ny * ((ay + by) / 2 - cy) < 0:
            nx, ny = -nx, -ny
        ln = math.hypot(nx, ny)
        normals.append((nx / ln, ny / ln, 0.0))
    for i in range(n):
        j = (i + 1) % n
        (ax, ay), (bx, by) = pts[i], pts[j]
        f = normals[i]
        na = norm(tuple(normals[i][q] + normals[i - 1][q] for q in range(3))) if smooth else f
        nb = norm(tuple(normals[i][q] + normals[j][q] for q in range(3))) if smooth else f
        u = (lambda x, y: run_u(x)) if abs(f[0]) < 0.05 else (lambda x, y: run_u(y))
        c = lambda x, y, z, nn: ((x, y, z), nn, (u(x, y), vmid + PERM * (z - (z0 + z1) / 2)))
        p.quad(c(ax, ay, z0, na), c(bx, by, z0, nb), c(bx, by, z1, nb), c(ax, ay, z1, na), f)
    if cap1:
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        mx, my = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        crid = cap_for(max(max(xs) - min(xs), max(ys) - min(ys)))
        out = (0.0, 0.0, 1.0)
        gx, gy = sum(xs) / n, sum(ys) / n
        corner = lambda x, y: ((x, y, z1), out, cap_uv(crid, x - mx, y - my))
        for i in range(n):
            p.tri(corner(gx, gy), corner(*pts[i]), corner(*pts[(i + 1) % n]), out)
    return p


def box(x0, x1, y0, y1, z0, z1, faces):
    """
    A box with only the faces named (`faces`: '+x' ... '-z' -> region). Faces toward ±z and ±y take U from x (the run);
    faces toward ±x take U from z. V at real size centred in the region's band; a cap region maps the face whole.
    """
    p = Piece()
    xm, ym, zm = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    for f, rid in faces.items():
        axis, sign = f[1], (1.0 if f[0] == '+' else -1.0)
        out = {'x': (sign, 0.0, 0.0), 'y': (0.0, sign, 0.0), 'z': (0.0, 0.0, sign)}[axis]
        if axis == 'z':
            z = z1 if sign > 0 else z0
            pts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
            extent = (x1 - x0, y1 - y0)
            uvf = lambda q: (run_u(q[0]), band_centre(rid) + PERM * (ym - q[1]))
            capf = lambda q: cap_uv(rid, (q[0] - xm) * sign, q[1] - ym)
            across = y1 - y0
        elif axis == 'y':
            y = y1 if sign > 0 else y0
            pts = [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]
            extent = (x1 - x0, z1 - z0)
            uvf = lambda q: (run_u(q[0]), band_centre(rid) + PERM * (q[2] - zm))
            capf = lambda q: cap_uv(rid, q[0] - xm, (q[2] - zm) * -sign)
            across = z1 - z0
        else:
            x = x1 if sign > 0 else x0
            pts = [(x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0)]
            extent = (z1 - z0, y1 - y0)
            uvf = lambda q: (run_u(q[2]), band_centre(rid) + PERM * (ym - q[1]))
            capf = lambda q: cap_uv(rid, (q[2] - zm) * -sign, q[1] - ym)
            across = y1 - y0
        if REGIONS[rid][0] == 'cap':
            if cap_for(max(extent)) != rid:
                raise LayoutError(f'a {max(extent):.3f} m end in {rid}')
            uv = capf
        else:
            fit(rid, across)
            uv = uvf
        c = [(q, out, uv(q)) for q in pts]
        p.quad(c[0], c[1], c[2], c[3], out)
    return p


# ---------------------------------------------------------------------------------------------------------------------
# The log kit (wood): round logs, F1/S50/S25 wraps, caps for end grain, hewn S12p boards.

def log_pieces():
    """case -> section -> [variants], each (high, low); plus the join profile a section's ends name."""
    k = {}

    def half_logs(sides, x0=-HALF, x1=HALF):
        # Two half-logs laid on the wall's face (z = 0.25), one a course of 0.25 m: the flat back against the wall is not made.
        p = Piece()
        for cy in (-0.125, 0.125):
            p.add(ext_x(arc(0.12, sides, HALF, cy, -math.pi / 2, math.pi / 2), 'S50', x0, x1, (HALF, cy), smooth=True))
        return p

    k['wall-plain'] = {'body': [(half_logs(8), half_logs(3))]}
    # A one-cell-thick wall: half-logs on both faces, so the wall reads as whole logs from either side.
    k['wall-thin'] = {'body': [(half_logs(8).add(mirror_z(half_logs(8))), half_logs(3).add(mirror_z(half_logs(3))))]}

    def top(r, sides, which):
        x0 = -HALF - (0.07 if which in ('start', 'single') else 0.0)
        x1 = HALF + (0.07 if which in ('end', 'single') else 0.0)
        body = ext_x(arc(r, sides, 0.0, HALF, 0.0, math.pi), 'F1', x0, x1, (0.0, HALF), smooth=True)
        if which in ('start', 'single'):
            body.add(ext_x(arc(r, sides, 0.0, HALF, 0.0, math.pi), 'F1', x0, x0, (0.0, HALF), cap0=True, sides=False))
        if which in ('end', 'single'):
            body.add(ext_x(arc(r, sides, 0.0, HALF, 0.0, math.pi), 'F1', x1, x1, (0.0, HALF), cap1=True, sides=False))
        return body

    # Two variants of the top log (a little thinner, a little thicker), weights 2 : 1.
    k['wall-top'] = {s: [(top(0.2, 8, s), top(0.2, 3, s)), (top(0.18, 8, s), top(0.18, 3, s))] for s in ('body', 'start', 'end', 'single')}

    def stubs(sides, along_z_top):
        # Log ends crossing out of the wall: one a course, 0.15 m proud of the end (+x), end grain capped.
        p = Piece()
        for cy in (-0.125, 0.125):
            if along_z_top and cy > 0:
                p.add(ext_z(circle(0.11, sides, 0.125, cy), 'F1', HALF, HALF + 0.15, (0.125, cy), smooth=True, cap1=True))
            else:
                p.add(ext_x(circle(0.11, sides, 0.0 if not along_z_top else 0.125, cy), 'F1', HALF, HALF + 0.15, (0.0 if not along_z_top else 0.125, cy), closed=True, smooth=True, cap1=True))
        return p

    # A free end of a one-cell-thick wall: the courses on both faces, their log ends out of the end (+x).
    k['wall-end'] = {'body': [(stubs(10, False).add(half_logs(8)).add(mirror_z(half_logs(8))), stubs(5, False).add(half_logs(3)).add(mirror_z(half_logs(3))))]}
    k['wall-corner'] = {'body': [(stubs(10, True), stubs(5, True))]}

    def beam(sides, which):
        x0 = -HALF - (0.08 if which in ('start', 'single') else 0.0)
        x1 = HALF + (0.08 if which in ('end', 'single') else 0.0)
        return ext_x(circle(0.16, sides), 'F1', x0, x1, (0.0, 0.0), closed=True, smooth=True, cap0=which in ('start', 'single'), cap1=which in ('end', 'single'))

    k['beam'] = {s: [(beam(12, s), beam(6, s))] for s in ('body', 'start', 'end', 'single')}

    def rail(sides, which):
        # A pole on top (Ø 0.08 m) and one lower, the panel's thickness: wraps S25, end grain in C12.
        p = Piece()
        for cy in (0.17, -0.1):
            p.add(ext_x(circle(0.04, sides, 0.0, cy), 'S25', -HALF, HALF, (0.0, cy), closed=True, smooth=True, cap0=which in ('start', 'single'), cap1=which in ('end', 'single')))
        return p

    k['banister-rail'] = {s: [(rail(8, s), rail(4, s))] for s in ('body', 'start', 'end', 'single')}

    def post(sides):
        # A turned post the cell's height, Ø 0.14 m, its top capped (C25: high and low both just over the small cap).
        return ext_y([(0.07 * math.sin(2 * math.pi * k / sides), 0.07 * math.cos(2 * math.pi * k / sides)) for k in range(sides)], 'F1', -HALF, HALF, (0.0, 0.0), smooth=True, top=True)

    k['banister-post'] = {'body': [(post(10), post(5))]}

    def board(y0, y1, out, which, top=True):
        # A hewn board on the face: front a profiled strip of its height, top and bottom edges plain; back against the
        # wall (and, for a moulding, top against the ceiling: not made).
        pts = [(HALF, y0), (HALF + out, y0), (HALF + out, y1)] + ([(HALF, y1)] if top else [])
        h = y1 - y0
        front = 'S12p' if abs(h - 0.124) < 1e-6 else 'S25p'
        p = ext_x(pts, ['S12', front, 'S12'][:len(pts) - 1], -HALF, HALF, (HALF, (y0 + y1) / 2))
        if which in ('start', 'end'):
            # The exposed end of the board: a small cut end face (U across it from z, the check reads U along x only).
            x = -HALF if which == 'start' else HALF
            p.add(box(x, x, y0, y1, HALF, HALF + out, {('-x' if which == 'start' else '+x'): 'S12' if h <= 0.124 else 'S25'}))
        return p

    # Flat boards have nothing to reduce: their low is the high (the same mesh as a second node).
    k['running-board'] = {s: [(board(-0.062, 0.062, 0.04, s),) * 2] for s in ('body', 'start', 'end')}
    k['moulding'] = {s: [(board(HALF - 0.124, HALF, 0.05, s, top=False),) * 2] for s in ('body', 'start', 'end')}
    k['foundation-skirt'] = {'body': [(board(-HALF + 0.001, -HALF + 0.249, 0.05, 'body'),) * 2]}

    def soffit():
        # Boards under the raised slab (y 0): underside 0.24 m deep plain S25, the front edge S12; the top is against the slab.
        return ext_x([(0.0, 0.0), (0.0, -0.02), (0.24, -0.02), (0.24, 0.0)], ['S12', 'S25', 'S12'], -HALF, HALF, (0.12, -0.01))

    k['soffit'] = {'body': [(soffit(),) * 2]}
    return k


# ---------------------------------------------------------------------------------------------------------------------
# The stone kit (dressed stone): ashlar courses, coping, quoins, moulding, plinth, opening frames.

def stone_pieces():
    k = {}

    def course(y0, out, split, low):
        # One ashlar course on the face, 0.248 m high (a 2 mm joint above and below), split into two blocks or whole.
        y1 = y0 + 0.248
        pts = [(HALF, y0), (HALF + out, y0), (HALF + out, y1), (HALF, y1)]
        regs = ['S12', 'S25p', 'S12']
        if not split:
            return ext_x(pts, regs, -HALF, HALF, (HALF, (y0 + y1) / 2))
        p = ext_x(pts, regs, -HALF, -0.002, (HALF, (y0 + y1) / 2)).add(ext_x(pts, regs, 0.002, HALF, (HALF, (y0 + y1) / 2)))
        if not low:
            # The vertical joint's two cut faces.
            p.add(box(-0.002, -0.002, y0, y1, HALF, HALF + out, {'+x': 'S25'})).add(box(0.002, 0.002, y0, y1, HALF, HALF + out, {'-x': 'S25'}))
        return p

    def ashlar(flip, low):
        return course(-HALF + 0.001, 0.02, flip, low).add(course(0.001, 0.02, not flip, low))

    # Two variants: the joint in the lower course or in the upper (the bond staggers cell to cell).
    k['wall-plain'] = {'body': [(ashlar(False, False), ashlar(False, True)), (ashlar(True, False), ashlar(True, True))]}
    # A one-cell-thick wall: ashlar on both faces (the back's joints mirror the front's).
    k['wall-thin'] = {'body': [(ashlar(f, False).add(mirror_z(ashlar(f, False))), ashlar(f, True).add(mirror_z(ashlar(f, True)))) for f in (False, True)]}

    def coping(which, low):
        # A coping on the wall top: drip faces front and back (S12p), the weathered top (S50), small chamfers (S12).
        h = 0.124
        pts = [(-0.245, HALF), (-0.245, HALF + h), (-0.215, HALF + h + 0.03), (0.215, HALF + h + 0.03), (0.245, HALF + h), (0.245, HALF)]
        regs = ['S12p', 'S12', 'S50', 'S12', 'S12p'] if not low else ['S12p', 'S12', 'S50', 'S12', 'S12p']
        return ext_x(pts, regs, -HALF, HALF, (0.0, HALF), cap0=which in ('start', 'single'), cap1=which in ('end', 'single'))

    k['wall-top'] = {s: [(coping(s, False), coping(s, True))] for s in ('body', 'start', 'end', 'single')}

    def quoins(end, low):
        # Quoin blocks standing 2 cm proud up the corner, long and short in turn a course; only faces that show.
        p = Piece()
        o = 0.02
        for i, y0 in enumerate((-HALF + 0.001, 0.001)):
            y1 = y0 + 0.248
            long_front = (i % 2 == 0)
            if end:
                # A free wall end (+x): the end face slab, with returns on the front and back faces.
                p.add(box(HALF, HALF + o, y0, y1, -HALF - o, HALF + o, {'+x': 'S25p', '+y': 'F1', '-y': 'F1'}))
                for zs, face in ((HALF, '+z'), (-HALF - o, '-z')):
                    x0 = 0.0 if long_front else 0.125
                    faces = {face: 'S25p', '-x': 'S25', '+y': 'F1', '-y': 'F1'}
                    p.add(box(x0, HALF, y0, y1, zs, zs + o, faces))
            else:
                # The outside corner (+x, +z): a block on the front face and its return on the side face.
                x0 = 0.0 if long_front else 0.125
                z0 = 0.0 if not long_front else 0.125
                p.add(box(x0, HALF + o, y0, y1, HALF, HALF + o, {'+z': 'S25p', '+x': 'S25p', '-x': 'S25', '+y': 'F1', '-y': 'F1'}))
                p.add(box(HALF, HALF + o, y0, y1, z0, HALF, {'+x': 'S25p', '+y': 'F1', '-y': 'F1'}))
        return p

    k['wall-corner'] = {'body': [(quoins(False, False), quoins(False, True))]}
    k['wall-end'] = {'body': [(quoins(True, False), quoins(True, True))]}

    def cornice(which, low):
        # A moulding under the ceiling: a 0.124 m face (S12p) over a chamfer and a soffit (S12); its top is against the ceiling.
        pts = [(HALF, HALF), (HALF + 0.06, HALF), (HALF + 0.06, HALF - 0.124), (HALF + 0.03, HALF - 0.154), (HALF, HALF - 0.154)]
        p = ext_x(pts, ['S12', 'S12p', 'S12', 'S12'], -HALF, HALF, (HALF, HALF - 0.07))
        if which != 'body' and not low:
            x = -HALF if which == 'start' else HALF
            p.add(box(x, x, HALF - 0.124, HALF, HALF, HALF + 0.06, {('-x' if which == 'start' else '+x'): 'S12'}))
        return p

    k['moulding'] = {s: [(cornice(s, False), cornice(s, True))] for s in ('body', 'start', 'end')}

    def plinth(low):
        # A plinth course the cell's height at the foot of the face (S50p, chamfered top as S12): stands 4 cm proud.
        pts = [(HALF, -HALF), (HALF + 0.04, -HALF), (HALF + 0.04, -HALF + 0.498), (HALF, -HALF + 0.498)]
        return ext_x(pts, ['S12', 'S50p', 'S12'], -HALF, HALF, (HALF, 0.0))

    k['wall-base'] = {'body': [(plinth(False), plinth(True))]}
    k['foundation-skirt'] = {'body': [(plinth(False), plinth(True))]}

    # Opening frames: dressed stone surrounds inside the open cell, against the solid round it.
    def jamb(low):
        # Beside the opening (+x solid): the reveal faces into the opening (-x), the surround's face front and back.
        faces = {'-x': 'F1', '+z': 'F1', '-z': 'F1'}
        return box(0.125, HALF, -HALF, HALF, -0.125, 0.125, faces)

    def head(low):
        # Over the opening (+y solid): underside S25 (0.248 deep), front and back S12p.
        return ext_x([(-0.124, HALF), (-0.124, HALF - 0.124), (0.124, HALF - 0.124), (0.124, HALF)], ['S12p', 'S25', 'S12p'], -HALF, HALF, (0.0, HALF))

    def sill(low, threshold):
        # Under the opening: the top a profiled 0.248 m strip, the nose front and back plain.
        h = 0.03 if threshold else 0.1
        return ext_x([(-0.124, -HALF), (-0.124, -HALF + h), (0.124, -HALF + h), (0.124, -HALF)], ['S12', 'S25p', 'S12'], -HALF, HALF, (0.0, -HALF))

    k['opening-jamb'] = {'body': [(jamb(False), jamb(True))]}
    k['opening-head'] = {'body': [(head(False), head(True))]}
    k['opening-sill'] = {'body': [(sill(False, False), sill(True, False))]}
    k['opening-threshold'] = {'body': [(sill(False, True), sill(True, True))]}

    def single(low):
        # A one-cell opening framed on four sides: head, sill and both jambs (the -x jamb is the +x one mirrored).
        p = Piece().add(head(low)).add(sill(low, False))
        side = box(0.125, HALF, -HALF + 0.1, HALF - 0.124, -0.125, 0.125, {'-x': 'S50', '+z': 'S50', '-z': 'S50'})
        other = box(-HALF, -0.125, -HALF + 0.1, HALF - 0.124, -0.125, 0.125, {'+x': 'S50', '+z': 'S50', '-z': 'S50'})
        return p.add(side).add(other)

    k['opening-single'] = {'body': [(single(False), single(True))]}
    # Cut stone is flat faces only: there is nothing a low mesh could drop without changing the regions a face uses
    # (the kit check's T7), so each piece's low is its high, shipped as a second node.
    return {case: {s: [(hi, hi) for hi, _ in vs] for s, vs in secs.items()} for case, secs in k.items()}


# ---------------------------------------------------------------------------------------------------------------------

KITS = {
    'log': {
        'name': 'Log (placeholder)', 'materialType': 'wood', 'materials': [11, 14], 'pieces': log_pieces,
        'weights': {'wall-top': [2, 1]},
        # Outlines in sixteenths of the end plane (u from -z, v from -y; parts past the cell clamped to its edge).
        'profiles': {
            'log-top': [[2, 16], [8, 16], [14, 16], [8, 15]],
            'log-beam': [[8, 3], [13, 5], [13, 11], [8, 13], [3, 11], [3, 5]],
            'log-rail': [[7, 3], [9, 3], [9, 14], [7, 14]],
            'log-board': [[16, 6], [16, 10], [15, 10], [15, 6]],
            'log-moulding': [[16, 12], [16, 16], [15, 16]],
        },
        'ends': {'wall-top': 'log-top', 'beam': 'log-beam', 'banister-rail': 'log-rail', 'running-board': 'log-board', 'moulding': 'log-moulding'},
        'gameData': {'placeholder': True, 'break': 'splinter', 'sound': 'wood'},
    },
    'stone': {
        'name': 'Stone (placeholder)', 'materialType': 'stone', 'materials': [10, 15], 'pieces': stone_pieces,
        'weights': {'wall-plain': [1, 1], 'wall-thin': [1, 1]},
        'profiles': {
            'stone-coping': [[0, 16], [16, 16], [16, 15], [0, 15]],
            'stone-cornice': [[16, 11], [16, 16], [15, 16], [15, 12]],
        },
        'ends': {'wall-top': 'stone-coping', 'moulding': 'stone-cornice'},
        'gameData': {'placeholder': True, 'break': 'crumble', 'sound': 'stone'},
    },
}


def node_name(case, section, k, level):
    # Letters, digits, - and _ only: three's loader strips '.', ':' and '/' from node names, the project model reads them raw.
    return f'{case}_{section}_v{k}_{level}'


def build(kit_id):
    spec = KITS[kit_id]
    return spec, spec['pieces']()


def kit_record(kit_id, spec, pieces, asset_id, digest):
    cases = {}
    for case, sections in pieces.items():
        out = {}
        for section, variants in sections.items():
            vs = []
            for k, _ in enumerate(variants):
                v = {'high': {'assetId': asset_id, 'digest': digest, 'node': node_name(case, section, k, 'high')},
                     'low': {'assetId': asset_id, 'digest': digest, 'node': node_name(case, section, k, 'low')}}
                w = spec['weights'].get(case)
                if w is not None and w[k] != 1:
                    v['weight'] = w[k]
                vs.append(v)
            s = {'variants': vs}
            prof = spec['ends'].get(case)
            if prof is not None:
                ends = {'body': {'start': prof, 'end': prof}, 'start': {'end': prof}, 'end': {'start': prof}}.get(section)
                if ends is not None:
                    s['ends'] = ends
            out[section] = s
        cases[case] = {'sections': out}
    return {
        'kitFormat': 1, 'voxelKitId': kit_id, 'name': spec['name'], 'version': 1, 'materialType': spec['materialType'],
        'materials': spec['materials'], 'cases': cases, 'joinProfiles': {k: {'outline': v} for k, v in spec['profiles'].items()},
        'trimLayout': 'detail-trim', 'gameData': spec['gameData'],
    }


def stats(pieces):
    rows = []
    for case, sections in pieces.items():
        for section, variants in sections.items():
            for k, (hi, lo) in enumerate(variants):
                rows.append((case, section, k, len(hi.tris), len(lo.tris)))
    return rows


def blender_mesh(bpy, name, piece, mat):
    """A Blender mesh of a piece: corners equal in position, normal and UV shared, custom split normals, one UV map."""
    verts, normals, uvs, faces, index = [], [], [], [], {}
    for tri in piece.tris:
        face = []
        for (x, y, z), (nx, ny, nz), (u, v) in tri:
            key = (round(x, 6), round(y, 6), round(z, 6), round(nx, 5), round(ny, 5), round(nz, 5), round(u, 7), round(v, 7))
            at = index.get(key)
            if at is None:
                at = index[key] = len(verts)
                # glTF (x, y, z) -> Blender (x, -z, y); the exporter turns it back (+Y up).
                verts.append((x, -z, y))
                normals.append((nx, -nz, ny))
                uvs.append((u, 1.0 - v))
            face.append(at)
        faces.append(tuple(face))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for li, loop in enumerate(me.loops):
        uv.data[li].uv = uvs[loop.vertex_index]
    me.normals_split_custom_set([normals[loop.vertex_index] for loop in me.loops])
    me.materials.append(mat)
    return me


def write_blender(kit_id, pieces, path):
    import bpy  # noqa: only inside Blender

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    mat = bpy.data.materials.new(f'{kit_id}-standin')
    meshes = {}
    for case, sections in pieces.items():
        for section, variants in sections.items():
            for k, pair in enumerate(variants):
                for level, piece in zip(('high', 'low'), pair):
                    name = node_name(case, section, k, level)
                    # A low that is its high shares the mesh: one mesh in the file, two nodes.
                    me = meshes.get(id(piece))
                    if me is None:
                        me = meshes[id(piece)] = blender_mesh(bpy, name, piece, mat)
                    ob = bpy.data.objects.new(name, me)
                    scene.collection.objects.link(ob)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_yup=True, export_texcoords=True, export_normals=True,
        export_tangents=False, export_materials='PLACEHOLDER', export_cameras=False, export_lights=False,
        export_apply=False, export_animations=False, export_skins=False, export_morph=False, export_extras=False,
    )


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    dry = '--dry-run' in argv
    out = os.path.dirname(os.path.abspath(__file__))
    if '--out' in argv:
        out = argv[argv.index('--out') + 1]
    for kit_id in KITS:
        spec, pieces = build(kit_id)
        rows = stats(pieces)
        hi = sum(r[3] for r in rows)
        lo = sum(r[4] for r in rows)
        print(f'[{kit_id}] {len(rows)} pieces, {hi} triangles high, {lo} low')
        for r in rows:
            print(f'  {r[0]:18} {r[1]:7} v{r[2]}  high {r[3]:4}  low {r[4]:4}')
        if dry:
            continue
        glb = os.path.join(out, f'voxel-kit-{kit_id}.glb')
        write_blender(kit_id, pieces, glb)
        with open(glb, 'rb') as f:
            data = f.read()
        digest = hashlib.sha256(data).hexdigest()
        record = kit_record(kit_id, spec, pieces, f'voxel-kit-{kit_id}', digest)
        with open(os.path.join(out, f'{kit_id}.voxelkit.json'), 'w') as f:
            json.dump(record, f, indent=1)
            f.write('\n')
        print(f'[{kit_id}] {glb}: {len(data)} bytes, sha256 {digest}')


if __name__ == '__main__':
    main()
