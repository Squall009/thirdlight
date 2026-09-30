/**
 * Line shapes the Scene view draws for what has no mesh: a camera's real
 * frustum and a light's reach (a point light's circles, a spot light's cone).
 * Drawn only: they never take a click meant for what is behind them.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

import type { ProjectedEntity } from '../session/projection';

/**
 * A camera's real frustum in its own space (it looks down −Z):
 * the near and far rectangles and the edges from the eye, from its fovY,
 * near and far and the game's aspect.
 */
export function cameraFrustum(e: ProjectedEntity, aspect: number): THREE.LineSegments {
  const c = (e.components['camera'] ?? {}) as { fovY?: number; near?: number; far?: number };
  const fov = ((c.fovY ?? 60) * Math.PI) / 180;
  const near = c.near ?? 0.1;
  const far = c.far ?? 100;
  const rectAt = (d: number): THREE.Vector3[] => {
    const h = Math.tan(fov / 2) * d;
    const w = h * aspect;
    return [new THREE.Vector3(-w, -h, -d), new THREE.Vector3(w, -h, -d), new THREE.Vector3(w, h, -d), new THREE.Vector3(-w, h, -d)];
  };
  const n = rectAt(near);
  const f = rectAt(far);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(n[i]!, n[(i + 1) % 4]!, f[i]!, f[(i + 1) % 4]!, new THREE.Vector3(0, 0, 0), f[i]!);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf2b544, transparent: true, opacity: 0.6 }));
  lines.name = `camera-frustum:${e.id}`;
  lines.userData['cameraFrustum'] = { fovY: c.fovY ?? 60, near, far, aspect };
  // Drawn only: its long lines never take a click meant for what is behind them.
  lines.raycast = () => undefined;
  return lines;
}

/** A point light's reach (three circles) or a spot light's cone, as lines. */
export function lightGizmo(e: ProjectedEntity): THREE.LineSegments {
  const l = e.light!;
  const pts: THREE.Vector3[] = [];
  const reach = l.range !== undefined && l.range > 0 ? l.range : 3;
  if (l.type === 'point') {
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
