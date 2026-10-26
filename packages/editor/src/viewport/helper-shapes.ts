/**
 * Line shapes the Scene view draws for what has no mesh: a light's reach (a
 * point light's circles, a spot light's cone) or an area light's outline.
 * Drawn only: they never take a click meant for what is behind them.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

import { AREA_LIGHT_DEFAULTS } from '@thirdlight/project-model/limits';
import type { ProjectedEntity } from '../session/projection';

/** A point light's reach (three circles), a spot light's cone or an area light's outline, as lines. */
export function lightGizmo(e: ProjectedEntity): THREE.LineSegments {
  const l = e.light!;
  const pts: THREE.Vector3[] = [];
  const reach = l.range !== undefined && l.range > 0 ? l.range : 3;
  if (l.type === 'area') {
    // The emitter itself in the object's frame (a rect in local XZ, a line along local X) and a
    // tick toward local −Y, where it shines (both ways when two-sided); its range is not drawn,
    // a shape that large would hide the room it lights.
    const hw = (l.width ?? AREA_LIGHT_DEFAULTS.width) / 2;
    const tick = Math.max(0.25, Math.min(hw, 1));
    if (l.shape === 'line') {
      pts.push(new THREE.Vector3(-hw, 0, 0), new THREE.Vector3(hw, 0, 0));
    } else {
      const hd = (l.height ?? AREA_LIGHT_DEFAULTS.height) / 2;
      const c = [new THREE.Vector3(-hw, 0, -hd), new THREE.Vector3(hw, 0, -hd), new THREE.Vector3(hw, 0, hd), new THREE.Vector3(-hw, 0, hd)];
      for (let i = 0; i < 4; i += 1) pts.push(c[i]!, c[(i + 1) % 4]!);
      pts.push(c[0]!, c[2]!, c[1]!, c[3]!);
    }
    pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -tick, 0));
    if (l.twoSided === true) pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, tick, 0));
  } else if (l.type === 'point') {
    const n = 32;
    for (const axis of [0, 1, 2]) {
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2;
        const b = ((i + 1) / n) * Math.PI * 2;
        const at = (t: number): THREE.Vector3 => (axis === 0 ? new THREE.Vector3(0, Math.cos(t), Math.sin(t)) : axis === 1 ? new THREE.Vector3(Math.cos(t), 0, Math.sin(t)) : new THREE.Vector3(Math.cos(t), Math.sin(t), 0)).multiplyScalar(reach);
        pts.push(at(a), at(b));
      }
    }
  } else {
    const d = new THREE.Vector3(...(l.direction ?? [0, -1, 0])).normalize();
    const half = THREE.MathUtils.degToRad(l.angle ?? 30);
    const r = Math.tan(half) * reach;
    const side = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(d, side).normalize();
    const v = new THREE.Vector3().crossVectors(d, u).normalize();
    const centre = d.clone().multiplyScalar(reach);
    const n = 24;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const b = ((i + 1) / n) * Math.PI * 2;
      const p = (t: number): THREE.Vector3 => centre.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r);
      pts.push(p(a), p(b));
      if (i % 6 === 0) pts.push(new THREE.Vector3(0, 0, 0), p(a));
    }
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.55 }));
  lines.name = e.id;
  (lines as { entityId?: string }).entityId = e.id;
  lines.userData = { lightKind: l.type };
  return lines;
}

/**
 * A unit circle as a closed line strip (its first point repeated at the end), in the XY plane
 * (a ring facing +Z) or the XZ plane (a ring lying on the ground). Every tool ring is drawn from
 * this: three's renderer refuses `LineLoop` on both backends (it logs an error each frame and
 * draws nothing), so a loop must be a `Line` that closes itself.
 */
export function ringGeometry(plane: 'xy' | 'xz', segments = 48): THREE.BufferGeometry {
  const pos = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = ((i % segments) / segments) * Math.PI * 2;
    pos[i * 3] = Math.cos(t);
    if (plane === 'xy') pos[i * 3 + 1] = Math.sin(t);
    else pos[i * 3 + 2] = Math.sin(t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

/** A tool ring: a closed `Line` over `ringGeometry` that never takes a click. */
export function ringLine(geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial): THREE.Line {
  const line = new THREE.Line(geometry, material);
  line.raycast = () => undefined;
  return line;
}
