"""
The two placeholder voxel kits, log (wood) and stone: engine-owned test data
the kit pipeline is measured with, never game art. Writes one GLB a kit (a
node a mesh: <case>_v<k>, all at the file's origin) and its kit record
(kitFormat 1, slots) beside it.

    blender --background --python tools/voxel-bench/kits/make_placeholder_kits.py [-- --out DIR]
    python3 tools/voxel-bench/kits/make_placeholder_kits.py --dry-run   # geometry and checks only, no Blender

Why it is built this way:
- Pieces only where voxel faces meet (the edge catalogue's slots): outer and
  inner edges, outer corners, roof edges (ridge, eave, verge, hip, valley),
  and the damage pieces on a face toward a hole (damage stages 2 and 3: small
  fragments the engine spreads over the face, several a face, more of the
  smaller stage-2 ones). Walls, floors and flat roofs are
  plain voxel faces: no slot here dresses a flat face. Slots left out draw
  nothing (every slot is optional).
- One mesh fills several slots, each with one of the 24 cube rotations: the
  bottom edge is the top edge's mesh turned under, the inner edges one cove
  turned. The verge is authored rising toward +x; the gable's other verge is
  drawn mirrored by the engine.
- One texture set a kit: every mesh of a kit uses the kit's one material
  (the kit check's rule).
- Pieces are written in metres, centred on their cell (the cell is 0.5 m,
  -0.25 .. 0.25 on each axis), in their first slot's case orientation: the open
  side toward +z, a run along +x, up +y (glTF axes; the Blender scene holds
  them turned to Blender's Z-up and the exporter turns them back). Roof-edge
  pieces follow the roof mesher's planes, which run up to a cell above their
  voxel's top.
- Only faces that can show are made: a member's faces inside the voxel body
  or under a roof plane are left out. Where two strips of one edge meet end
  to end their end faces touch (they close a run's end or a staggered step).
- UVs follow the trim layout DRAFT (docs/architecture/voxel-trim-layout.md,
  `detail-trim`): square texels at 1024 px/m on a 4096 sheet; on every face
  along the run, U is the distance along the run, 0.25 a metre from the
  cell's -x face (the kit check's T4); other faces map their own plane at
  real size in their region; end faces in the cap cell `a` of their size.
- One mesh a piece: pieces are drawn in the near ring only (level 0); from
  level 1 out the edges are plain voxel faces, so no lower-detail mesh is
  made.
- Normals: smooth round members, flat cut faces; no normal bakes (a
  placeholder: the shape carries no fine detail to bake). No textures.
- Collision, navigation and light never read these meshes: they come from
  the voxels (roof planes from the roof mesher).

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
# Faces and members off the run axis: planar polygons with UVs by the same rules as the extrusions above.

def neg(a):
    return (-a[0], -a[1], -a[2])


def add3(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def scale3(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def poly(pts, out, rid, normals=None):
    """
    A flat polygon (a fan from its first corner: convex, or star-shaped from it), wound toward `out`. UVs: an end face
    (`rid` any cap) maps whole at real size into the cap cell of its size; a face along the run (normal across x) takes U from x and V across it at
    real size; any other face takes both from its own plane at real size (U along its longest side), centred in the
    region's band.
    """
    p = Piece()
    n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])))
    if dot(n, out) < 0:
        n = neg(n)
    c = tuple(sum(q[k] for q in pts) / len(pts) for k in range(3))
    kind = REGIONS[rid][0]
    if kind == 'cap' or abs(n[0]) >= 0.05:
        # U along the polygon's longest side (a long face runs along the sheet), V across it.
        edges = [sub(pts[(i + 1) % len(pts)], pts[i]) for i in range(len(pts))]
        a = norm(max(edges, key=lambda e: dot(e, e)))
        b = cross(n, a)
        sa = [dot(sub(q, c), a) for q in pts]
        sb = [dot(sub(q, c), b) for q in pts]
        if kind == 'cap':
            # The cap cell of the end's size, as the check measures it (its box), large enough for its plane extents.
            box_ext = max(max(q[k] for q in pts) - min(q[k] for q in pts) for k in range(3))
            rid = cap_for(max(box_ext, max(sa) - min(sa), max(sb) - min(sb)))
            ma, mb = (max(sa) + min(sa)) / 2, (max(sb) + min(sb)) / 2
            uv = lambda q: cap_uv(rid, dot(sub(q, c), a) - ma, dot(sub(q, c), b) - mb)
        else:
            fit(rid, max(sb) - min(sb))
            ma, mb = (max(sa) + min(sa)) / 2, (max(sb) + min(sb)) / 2
            uv = lambda q: (0.5 + PERM * (dot(sub(q, c), a) - ma), band_centre(rid) - PERM * (dot(sub(q, c), b) - mb))
    else:
        vd = norm(cross(n, (1.0, 0.0, 0.0)))
        sv = [dot(q, vd) for q in pts]
        fit(rid, max(sv) - min(sv))
        mv = (max(sv) + min(sv)) / 2
        uv = lambda q: (run_u(q[0]), band_centre(rid) - PERM * (dot(q, vd) - mv))
    corner = [(q, normals[i] if normals is not None else n, uv(q)) for i, q in enumerate(pts)]
    for k in range(1, len(pts) - 1):
        p.tri(corner[0], corner[k], corner[k + 1], n)
    return p


def loft(a, b, segs, rid, caps=(), cap_rid=None, radial=None):
    """
    A member between two corresponding end sections `a`, `b` (points, metres): side faces `segs` [(i, j, out)] in
    region `rid`, end caps `caps` (index polygons, convex: the first end's facing away from b, the second's from a)
    in `cap_rid`. `radial` (an axis point at each end) gives smooth normals out from the axis.
    """
    p = Piece()
    along = norm(sub(tuple(sum(q[k] for q in b) / len(b) for k in range(3)), tuple(sum(q[k] for q in a) / len(a) for k in range(3))))
    for i, j, out in segs:
        quad = [a[i], b[i], b[j], a[j]]
        nrm = None
        if radial is not None:
            def rn(q, axis):
                d = sub(q, axis)
                d = sub(d, scale3(along, dot(d, along)))
                return norm(d)
            nrm = [rn(a[i], radial[0]), rn(b[i], radial[1]), rn(b[j], radial[1]), rn(a[j], radial[0])]
        p.add(poly(quad, out, rid, nrm))
    for poly_ix in caps:
        p.add(poly([a[k] for k in poly_ix], neg(along), cap_rid))
        p.add(poly([b[k] for k in poly_ix], along, cap_rid))
    return p


def frame(axis):
    """Two unit vectors square to `axis` and to each other (the first level where it can be)."""
    u = cross(axis, (0.0, 1.0, 0.0))
    if math.sqrt(dot(u, u)) < 1e-6:
        u = cross(axis, (1.0, 0.0, 0.0))
    u = norm(u)
    return u, norm(cross(u, axis))


def tube(p0, p1, r, sides, rid, cap_rid, caps=True, start=0.0, ring_axes=None):
    """A round member from p0 to p1 (radius r, `sides` faces, smooth), its ends square to it and capped."""
    axis = norm(sub(p1, p0))
    u, w = ring_axes if ring_axes is not None else frame(axis)
    ring = lambda c: [add3(c, add3(scale3(u, r * math.cos(start + 2 * math.pi * k / sides)), scale3(w, r * math.sin(start + 2 * math.pi * k / sides)))) for k in range(sides)]
    a, b = ring(p0), ring(p1)
    segs = []
    for k in range(sides):
        j = (k + 1) % sides
        mid = add3(scale3(add3(a[k], a[j]), 0.5), neg(p0))
        segs.append((k, j, mid))
    return loft(a, b, segs, rid, caps=[list(range(sides))] if caps else (), cap_rid=cap_rid, radial=(p0, p1))


def line_cap(l0, l1, lateral, dy, rise, rid='F1', cap_rid='C12a'):
    """
    A cap where two 45° roof planes meet along the line l0 → l1: it covers both planes `lateral` either side of the
    line (the planes `dy` below a convex line, above a concave one, at that offset), standing `rise` above them, with
    a lip down to each plane and its ends closed.
    """
    def section(l):
        pa = add3(l, (lateral[0], dy, lateral[2]))
        pb = add3(l, (-lateral[0], dy, -lateral[2]))
        up = (0.0, rise, 0.0)
        return [pa, add3(pa, up), add3(l, up), add3(pb, up), pb, l]
    a, b = section(l0), section(l1)
    up = (0.0, 1.0, 0.0)
    segs = [(1, 2, up), (2, 3, up), (0, 1, lateral), (3, 4, neg(lateral))]
    # Each end one face, fanned from the lifted line point (every corner is in sight of it).
    return loft(a, b, segs, rid, caps=[[2, 3, 4, 5, 0, 1]], cap_rid=cap_rid)


def arc_angles(r, inset):
    """Where a circle of radius r centred `inset` in from both faces of an outer edge meets the front and the top face."""
    return -math.acos(inset / r), math.pi - math.asin(inset / r)


# Roof planes in a roof-edge case's own orientation (roof-mesher.ts roofEdgesOf): a ridge on the cell's +z side at
# y 0.75 (the plane one cell above the voxel's top), an eave's low edge at z 0.25, y 0.25, a verge on the +z face
# rising toward +x from y 0.25 at x -0.25 to 0.75 at +0.25, a hip or valley line from the low corner (0.25, 0.25,
# 0.25) up to (-0.25, 0.75, -0.25).
RIDGE_Y = 0.75
VERGE_N = norm((-1.0, 1.0, 0.0))
SLOPE = norm((1.0, 1.0, 0.0))
HIP_LOW = (HALF, HALF, HALF)
HIP_HIGH = (-HALF, 0.75, -HALF)


def verge_point(x, s, t):
    """A point by the verge: x along the slope's run, s out of the gable face (+z), t off the plane along its normal."""
    return add3(add3((x, 0.5 + x, HALF + s), scale3(VERGE_N, t)), (0.0, 0.0, 0.0))


def square_to_slope(p, x):
    """Point p moved along the slope onto the plane square to it through the plane's edge at run x (a verge's cut end)."""
    anchor = (x, 0.5 + x, HALF)
    return add3(p, scale3(SLOPE, -dot(sub(p, anchor), SLOPE)))


def hip_caps():
    # 7 cm each side of the line: its ends are the 0.25 m cap cell's size (over 0.125 m across).
    w = 0.07
    return line_cap(HIP_LOW, HIP_HIGH, (w, 0.0, -w), -w, 0.025), line_cap(HIP_LOW, HIP_HIGH, (w, 0.0, -w), w, 0.02)


# ---------------------------------------------------------------------------------------------------------------------
# The log kit (wood): round logs over the outer edges, log ends at vertical edges and crossing at corners, a pole in
# inner edges, ridge, eave and barge logs on roofs, splinters and broken log ends as damage pieces. Flat faces get nothing.

def log_pieces():
    k = {}

    def edge_log(r, inset, sides):
        a0, a1 = arc_angles(r, inset)
        cz = cy = HALF - inset
        return ext_x(arc(r, sides, cz, cy, a0, a1), 'F1', -HALF, HALF, (cz, cy), smooth=True)

    # Two variants of the edge log (a little thinner, set a little deeper), weights 1 : 1.
    k['edge-out-top'] = [edge_log(0.09, 0.05, 8), edge_log(0.08, 0.042, 8)]

    def stub_x(cz, cy, r, sides, x0, x1):
        # A log end out of +x past the cell (its side faces from the face plane out), end grain capped.
        pts = circle(r, sides, cz, cy)
        p = ext_x(pts, 'F1', x0, x1, (cz, cy), closed=True, smooth=True)
        return p.add(poly([(x1, y, z) for z, y in pts], (1.0, 0.0, 0.0), 'C25a'))

    def stub_z(cx, cy, r, sides, z0, z1):
        pts = [(cx + r * math.sin(2 * math.pi * k / sides), cy - r * math.cos(2 * math.pi * k / sides)) for k in range(sides)]
        p = ext_z(pts, 'F1', z0, z1, (cx, cy), smooth=True)
        return p.add(poly([(x, y, z1) for x, y in pts], (0.0, 0.0, 1.0), 'C25a'))

    def log_ends(sides):
        # The vertical edge: one log end a 0.25 m course, crossing in turn (the lower out of the front, the upper out
        # of the side), as a notched log corner stacks them.
        return stub_z(0.16, -0.125, 0.1, sides, HALF, HALF + 0.12).add(stub_x(0.16, 0.125, 0.1, sides, HALF, HALF + 0.12))

    k['edge-out-vertical'] = [log_ends(8)]

    def corner(sides):
        # The top logs of both sides run on past the corner and cross there (a notched corner's last course).
        return stub_x(HALF - 0.05, HALF - 0.05, 0.09, sides, HALF, HALF + 0.12).add(stub_z(HALF - 0.05, HALF - 0.05, 0.09, sides, HALF, HALF + 0.12))

    k['corner-out-top'] = [corner(8)]

    def cove(sides):
        # A pole in the inner edge, touching both faces (the open quadrant y > 0.25, z > 0.25).
        r = 0.05
        return ext_x(arc(r, sides, HALF + r, HALF + r, -math.pi / 2, math.pi), 'S25', -HALF, HALF, (HALF + r, HALF + r), smooth=True)

    k['edge-in-bottom'] = [cove(6)]

    def ridge(sides):
        # The ridge log on both planes, its part under them not made: the arc from one plane round the top to the other.
        r, lift = 0.07, 0.02
        t = math.asin(-lift / r / math.sqrt(2)) - math.pi / 4
        pts = arc(r, sides, HALF, RIDGE_Y + lift, t, math.pi - t)
        p = ext_x(pts, 'F1', -HALF, HALF, (HALF, RIDGE_Y + lift), smooth=True)
        for x, out in ((-HALF, (-1.0, 0.0, 0.0)), (HALF, (1.0, 0.0, 0.0))):
            p.add(poly([(x, y, z) for z, y in pts], out, 'C25a'))
        return p

    k['roof-ridge'] = [ridge(10)]

    def eave(sides):
        # A fascia log under the plane's low edge, its front half out of the slab's side face.
        r = 0.08
        pts = arc(r, sides, HALF, HALF - r, -math.pi / 2, math.pi / 2)
        p = ext_x(pts, 'F1', -HALF, HALF, (HALF, HALF - r), smooth=True)
        for x, out in ((-HALF, (-1.0, 0.0, 0.0)), (HALF, (1.0, 0.0, 0.0))):
            p.add(poly([(x, y, z) for z, y in pts], out, 'C25a'))
        return p

    k['roof-eave'] = [eave(6)]

    def barge(sides):
        # The barge log up the gable edge: along the slope, tangent to the gable face, ends cut square to the slope
        # so the logs of a gable's cells meet end to end (the other gable side draws this mirrored).
        r = 0.07
        off = (0.0, 0.0, r)
        p0 = add3(verge_point(-HALF, 0.0, -0.02), off)
        p1 = add3(verge_point(HALF, 0.0, -0.02), off)
        return tube(p0, p1, r, sides, 'F1', 'C25a', ring_axes=(VERGE_N, (0.0, 0.0, 1.0)))

    k['roof-gable'] = [barge(8)]
    hip, valley = hip_caps()
    k['roof-hip'] = [hip]
    k['roof-valley'] = [valley]

    # Damage pieces: one fragment out of the middle of the face toward the hole (+z); the engine spreads several over
    # the face and spins each, so a piece is one splinter, never a cluster.
    def splinter(r, ln, sides):
        return stub_z(0.0, 0.0, r, sides, HALF - 0.01, HALF + ln)

    # Stage 2 (many a face): thin splinters, two lengths. Stage 3 (fewer): stout broken log ends.
    k['damage-stage-2'] = [splinter(0.018, 0.07, 4), splinter(0.022, 0.045, 4)]
    k['damage-stage-3'] = [splinter(0.045, 0.09, 6), splinter(0.04, 0.06, 6)]

    return k


# ---------------------------------------------------------------------------------------------------------------------
# The stone kit (dressed stone): a chamfered or chipped block edge proud of both faces, a chamfer fillet in inner
# edges, a block at outer corners, ridge and hip tiles, a drip lip at eaves, a verge board, chips and broken stones as damage pieces.

def stone_pieces():
    k = {}
    # How far an edge stands proud of its faces: more than its stagger sinks it (up to 1/32 cell in, and a 2° twist
    # over half a cell), so a staggered strip never sinks under its faces in places.
    P = 0.035

    def edge(chip):
        # The block edge's profile from the top face round to the front face (z, y), fanned shut from the edge line.
        back = HALF - 0.12
        pts = [(back, HALF), (back, HALF + P), (HALF + P - chip, HALF + P), (HALF + P, HALF + P - chip), (HALF + P, back), (HALF, back)]
        p = ext_x(pts, 'S50', -HALF, HALF, (HALF, HALF))
        for x, out in ((-HALF, (-1.0, 0.0, 0.0)), (HALF, (1.0, 0.0, 0.0))):
            p.add(poly([(x, HALF, HALF)] + [(x, y, z) for z, y in pts], out, 'C12a'))
        return p

    # Two variants: a fine chamfer and a deeper chipped one.
    k['edge-out-top'] = [edge(0.03), edge(0.055)]

    def cove():
        # A chamfer fillet filling the inner edge (the open quadrant y > 0.25, z > 0.25), ends closed.
        f = 0.05
        p = poly([(-HALF, HALF + f, HALF), (HALF, HALF + f, HALF), (HALF, HALF, HALF + f), (-HALF, HALF, HALF + f)], (0.0, 1.0, 1.0), 'S12')
        for x, out in ((-HALF, (-1.0, 0.0, 0.0)), (HALF, (1.0, 0.0, 0.0))):
            p.add(poly([(x, HALF, HALF), (x, HALF + f, HALF), (x, HALF, HALF + f)], out, 'C12a'))
        return p

    k['edge-in-bottom'] = [cove()]

    def corner():
        # A corner block standing a little prouder than the edges meeting there, its three outer faces.
        a, b = HALF - 0.12, HALF + P + 0.004
        p = Piece()
        p.add(poly([(b, a, a), (b, b, a), (b, b, b), (b, a, b)], (1.0, 0.0, 0.0), 'C12a'))
        p.add(poly([(a, b, a), (b, b, a), (b, b, b), (a, b, b)], (0.0, 1.0, 0.0), 'S25'))
        p.add(poly([(a, a, b), (b, a, b), (b, b, b), (a, b, b)], (0.0, 0.0, 1.0), 'S25'))
        return p

    k['corner-out-top'] = [corner()]

    def ridge():
        w = 0.07
        return line_cap((-HALF, RIDGE_Y, HALF), (HALF, RIDGE_Y, HALF), (0.0, 0.0, w), -w, 0.03)

    k['roof-ridge'] = [ridge()]

    def eave():
        # A drip lip under the plane's low edge: its top level with the edge, its front 4 cm out, 10 cm deep.
        pts = [(HALF, HALF), (HALF, HALF + 0.02), (HALF + 0.04, HALF + 0.02), (HALF + 0.04, HALF - 0.08), (HALF, HALF - 0.08)]
        return ext_x(pts, 'S25', -HALF, HALF, (HALF + 0.02, HALF - 0.03), cap0=True, cap1=True)

    k['roof-eave'] = [eave()]

    def verge():
        # A verge board up the gable edge along the slope, 3 cm out of the face, 10 cm under the plane's edge and 2 cm
        # over it, its ends cut square to the slope.
        sec = lambda x: [square_to_slope(verge_point(x, s, t), x) for s, t in ((0.0, 0.0), (0.0, 0.02), (0.03, 0.02), (0.03, -0.1), (0.0, -0.1))]
        a, b = sec(-HALF), sec(HALF)
        segs = [(1, 2, VERGE_N), (2, 3, (0.0, 0.0, 1.0)), (3, 4, neg(VERGE_N)), (0, 1, (0.0, 0.0, -1.0))]
        return loft(a, b, segs, 'F1', caps=[[0, 1, 2, 3, 4]], cap_rid='C12a')

    k['roof-gable'] = [verge()]
    hip, valley = hip_caps()
    k['roof-hip'] = [hip]
    k['roof-valley'] = [valley]

    # Damage pieces: one broken stone out of the middle of the face toward the hole (+z), its back sunk 1 cm into the
    # face; the engine spreads several over the face and spins each.
    def chip(w, h, d):
        return box(-w / 2, w / 2, -h / 2, h / 2, HALF - 0.01, HALF + d, {'+z': 'S12', '+x': 'S12', '-x': 'S12', '+y': 'S12', '-y': 'S12'})

    # Stage 2 (many a face): small chips, two shapes. Stage 3 (fewer): bigger broken blocks.
    k['damage-stage-2'] = [chip(0.06, 0.04, 0.025), chip(0.045, 0.05, 0.035)]
    k['damage-stage-3'] = [chip(0.11, 0.08, 0.05), chip(0.09, 0.1, 0.04)]

    return k


# ---------------------------------------------------------------------------------------------------------------------

# Cube rotations (cube-rotations.ts numbering): a quarter turn about +x (+y to +z) and one about -z (+y to +x).
X90 = 5
ZM90 = 9

KITS = {
    'log': {
        'name': 'Log (placeholder)', 'materialType': 'wood', 'materials': [11, 14], 'pieces': log_pieces,
        'weights': {},
        # Slots filled with another slot's meshes turned: the bottom edge and corner are the top's turned under; inner
        # edges the floor pole turned up the corner and under the ceiling. Vertical edges have their own mesh (log
        # ends, not a log).
        'aliases': {'edge-out-bottom': ('edge-out-top', X90), 'corner-out-bottom': ('corner-out-top', X90), 'edge-in-top': ('edge-in-bottom', X90), 'edge-in-vertical': ('edge-in-bottom', ZM90)},
        'gameData': {'placeholder': True, 'break': 'splinter', 'sound': 'wood'},
    },
    'stone': {
        'name': 'Stone (placeholder)', 'materialType': 'stone', 'materials': [10, 15], 'pieces': stone_pieces,
        'weights': {},
        # One edge mesh serves all three outer edges, one fillet all three inner, one block both outer corners.
        'aliases': {'edge-out-vertical': ('edge-out-top', ZM90), 'edge-out-bottom': ('edge-out-top', X90), 'corner-out-bottom': ('corner-out-top', X90), 'edge-in-top': ('edge-in-bottom', X90), 'edge-in-vertical': ('edge-in-bottom', ZM90)},
        'gameData': {'placeholder': True, 'break': 'crumble', 'sound': 'stone'},
    },
}


def node_name(case, k):
    # Letters, digits, - and _ only: three's loader strips '.', ':' and '/' from node names, the project model reads them raw.
    return f'{case}_v{k}'


def build(kit_id):
    spec = KITS[kit_id]
    return spec, spec['pieces']()


def kit_record(kit_id, spec, pieces, asset_id, digest):
    def meshes(case, rotation):
        out = []
        for k, _ in enumerate(pieces[case]):
            m = {'mesh': {'assetId': asset_id, 'digest': digest, 'node': node_name(case, k)}}
            if rotation != 0:
                m['rotation'] = rotation
            w = spec['weights'].get(case)
            if w is not None and w[k] != 1:
                m['weight'] = w[k]
            out.append(m)
        return out

    slots = {case: {'meshes': meshes(case, 0)} for case in pieces}
    for case, (source, rotation) in spec['aliases'].items():
        slots[case] = {'meshes': meshes(source, rotation)}
    return {
        'kitFormat': 1, 'voxelKitId': kit_id, 'name': spec['name'], 'version': 1, 'materialType': spec['materialType'],
        'materials': spec['materials'], 'slots': dict(sorted(slots.items())), 'trimLayout': 'detail-trim', 'gameData': spec['gameData'],
    }


def stats(pieces):
    return [(case, k, len(piece.tris)) for case, variants in pieces.items() for k, piece in enumerate(variants)]


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
    # One material for every mesh: a kit draws all its pieces with one texture set.
    mat = bpy.data.materials.new(f'{kit_id}-standin')
    for case, variants in pieces.items():
        for k, piece in enumerate(variants):
            name = node_name(case, k)
            ob = bpy.data.objects.new(name, blender_mesh(bpy, name, piece, mat))
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
        print(f'[{kit_id}] {len(rows)} meshes, {sum(r[2] for r in rows)} triangles, {len(pieces) + len(spec["aliases"])} slots filled')
        for r in rows:
            print(f'  {r[0]:18} v{r[1]}  {r[2]:4} tris')
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
