/**
 * World transforms over the scene hierarchy (phase 12), for moves that keep
 * an entity where it is in the world.
 *
 * Folders have no transform (identity). A world-keeping move sets the new
 * local transform to `inverse(newParentWorld) * world`, decomposed back into
 * position / rotation / scale. Like any TRS editor, a parent with rotation
 * and non-uniform scale can produce shear that TRS cannot hold; the
 * decomposition then keeps the closest TRS. Results are rounded to 1e-9 so
 * float noise does not show up in the scene file.
 *
 * Column-major 4x4 matrices (the three.js convention). Pure.
 */

import type { TransformComponent } from '@thirdlight/project-model';

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function compose(t: TransformComponent): Mat4 {
  const [x, y, z, w] = t.rotation;
  const [sx, sy, sz] = t.scale;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t.position[0], t.position[1], t.position[2], 1,
  ];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = v;
    }
  }
  return out;
}

/** Inverse of an affine matrix (null when singular). */
export function invert(m: Mat4): Mat4 | null {
  const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22, , tx, ty, tz] = m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-12) return null;
  const d = 1 / det;
  const r00 = b01 * d;
  const r01 = (-a22 * a01 + a02 * a21) * d;
  const r02 = (a12 * a01 - a02 * a11) * d;
  const r10 = b11 * d;
  const r11 = (a22 * a00 - a02 * a20) * d;
  const r12 = (-a12 * a00 + a02 * a10) * d;
  const r20 = b21 * d;
  const r21 = (-a21 * a00 + a01 * a20) * d;
  const r22 = (a11 * a00 - a01 * a10) * d;
  return [
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    -(r00 * tx + r10 * ty + r20 * tz), -(r01 * tx + r11 * ty + r21 * tz), -(r02 * tx + r12 * ty + r22 * tz), 1,
  ];
}

const round = (v: number): number => {
  const r = Math.round(v * 1e9) / 1e9;
  return r === 0 ? 0 : r; // no -0
};

export function decompose(m: Mat4): TransformComponent {
  let sx = Math.hypot(m[0] as number, m[1] as number, m[2] as number);
  const sy = Math.hypot(m[4] as number, m[5] as number, m[6] as number);
  const sz = Math.hypot(m[8] as number, m[9] as number, m[10] as number);
  const det = invertDet(m);
  if (det < 0) sx = -sx;
  const r = [
    (m[0] as number) / sx, (m[1] as number) / sx, (m[2] as number) / sx,
    (m[4] as number) / sy, (m[5] as number) / sy, (m[6] as number) / sy,
    (m[8] as number) / sz, (m[9] as number) / sz, (m[10] as number) / sz,
  ] as [number, number, number, number, number, number, number, number, number];
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  // One sign convention (w >= 0) so the same rotation always reads the same.
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const n = Math.hypot(x, y, z, w);
  return {
    position: [round(m[12] as number), round(m[13] as number), round(m[14] as number)],
    rotation: [round(x / n), round(y / n), round(z / n), round(w / n)],
    scale: [round(sx), round(sy), round(sz)],
  };
}

function invertDet(m: Mat4): number {
  const [a00, a01, a02, , a10, a11, a12, , a20, a21, a22] = m as [number, number, number, number, number, number, number, number, number, number, number];
  return a00 * (a22 * a11 - a12 * a21) + a01 * (-a22 * a10 + a12 * a20) + a02 * (a21 * a10 - a11 * a20);
}

/** Minimal entity view: id, parent, optional transform (absent = folder). */
export interface HierarchyNode {
  id: string;
  parentId?: string;
  components: { transform?: TransformComponent };
}

/** The world matrix of `id` (identity for the root or a folder chain). */
export function worldMatrix(byId: ReadonlyMap<string, HierarchyNode>, id: string | null): Mat4 {
  const chain: TransformComponent[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const e = byId.get(cur);
    if (e === undefined) break;
    if (e.components.transform !== undefined) chain.push(e.components.transform);
    cur = e.parentId ?? null;
  }
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, compose(chain[i] as TransformComponent));
  return m;
}

function isIdentity(m: Mat4): boolean {
  return m.every((v, i) => Math.abs(v - (IDENTITY[i] as number)) < 1e-12);
}

/**
 * The local transform that keeps `id` where it is in the world under
 * `newParentId`. Returns the current local transform unchanged when both
 * parents have the same world matrix (for example moving between folders),
 * and null for a folder (no transform) or a singular new parent.
 */
export function worldKeepingLocal(
  byId: ReadonlyMap<string, HierarchyNode>,
  id: string,
  newParentId: string | null,
): TransformComponent | null {
  const e = byId.get(id);
  const local = e?.components.transform;
  if (e === undefined || local === undefined) return null;
  const oldParent = worldMatrix(byId, e.parentId ?? null);
  const newParent = worldMatrix(byId, newParentId);
  if (oldParent.every((v, i) => Math.abs(v - (newParent[i] as number)) < 1e-12)) return local;
  const inv = invert(newParent);
  if (inv === null) return null;
  const world = multiply(oldParent, compose(local));
  return decompose(isIdentity(inv) ? world : multiply(inv, world));
}
