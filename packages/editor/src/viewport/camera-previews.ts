/**
 * Virtual camera previews in the Scene view: where each camera's rig puts it
 * (the runtime's camera brain, as Play starts it) drawn as a frustum out to
 * the pivot it looks at — for every virtual camera (the selected one shows),
 * and for the timeline's scrub preview (one camera at a key's rail progress,
 * with the objects where the timeline puts them).
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { CameraBrain, type CameraPose } from '@thirdlight/runtime';

import type { ProjectedEntity } from '../session/projection';

const N = (v: number | undefined): number => v ?? 0;

type Pose = { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] };

/**
 * The frustums of these virtual cameras (all when `only` is absent), their
 * world poses computed with the objects at `transforms` where given.
 */
export function virtualCameraPreviews(
  entities: readonly ProjectedEntity[],
  aspect: number,
  only?: { entityId: string; progress: number | null },
  transforms?: ReadonlyMap<string, Pose>,
): { id: string; pose: CameraPose; lines: THREE.LineSegments }[] {
  const cams = entities.filter((e) => e.components['virtualCamera'] !== undefined && (only === undefined || e.id === only.entityId));
  if (cams.length === 0) return [];
  const sceneCam = entities.find((e) => e.kind === 'camera')?.components['camera'] as { fovY?: number; near?: number; far?: number } | undefined;
  const brain = new CameraBrain(120, { fovY: sceneCam?.fovY ?? 60, near: sceneCam?.near ?? 0.1, far: sceneCam?.far ?? 100 });
  brain.add(entities.map((e) => ({ id: e.id, components: e.components })));
  if (only !== undefined && only.progress !== null) brain.set(only.entityId, { progress: only.progress });
  const byId = new Map(entities.map((e) => [e.id, e]));
  const world = {
    worldOf: (id: string, out: number[], rot: number[]): boolean => {
      const e = byId.get(id);
      if (e === undefined) return false;
      const m = new THREE.Matrix4();
      for (let cur: ProjectedEntity | undefined = e, depth = 0; cur !== undefined && depth < 64; cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined, depth += 1) {
        // A previewed object is where the timeline puts it.
        const pv = transforms?.get(cur.id);
        const pos = pv?.position ?? cur.position;
        const q = pv?.rotation ?? cur.rotation;
        const sc = pv?.scale ?? cur.scale;
        m.premultiply(new THREE.Matrix4().compose(new THREE.Vector3(N(pos[0]), N(pos[1]), N(pos[2])), new THREE.Quaternion(N(q[0]), N(q[1]), N(q[2]), q[3] ?? 1), new THREE.Vector3(sc[0] ?? 1, sc[1] ?? 1, sc[2] ?? 1)));
      }
      const v = new THREE.Vector3();
      const r = new THREE.Quaternion();
      m.decompose(v, r, new THREE.Vector3());
      out[0] = v.x;
      out[1] = v.y;
      out[2] = v.z;
      rot[0] = r.x;
      rot[1] = r.y;
      rot[2] = r.z;
      rot[3] = r.w;
      return true;
    },
  };
  const out: { id: string; pose: CameraPose; lines: THREE.LineSegments }[] = [];
  for (const e of cams) {
    const pose = brain.previewPose(e.id, world);
    if (pose === null) continue;
    const vc = e.components['virtualCamera'] as { rig?: string; distance?: number };
    const reach = vc.rig === 'follow' || vc.rig === 'orbitPoint' || vc.rig === 'topDown' ? (vc.distance ?? 5) : 3;
    out.push({ id: e.id, pose, lines: virtualCameraFrustum(e.id, pose, aspect, reach) });
  }
  return out;
}

/**
 * A virtual camera's preview in world space — the frustum where
 * its rig puts it (drawn out to the pivot it looks at, at most its far plane)
 * and a line to that pivot.
 */
export function virtualCameraFrustum(id: string, pose: CameraPose, aspect: number, reach: number): THREE.LineSegments {
  const fov = (pose.fovY * Math.PI) / 180;
  const q = new THREE.Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  const eye = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
  const d = Math.max(0.5, Math.min(pose.far, reach));
  const h = Math.tan(fov / 2) * d;
  const w = h * aspect;
  const corner = (x: number, y: number): THREE.Vector3 => new THREE.Vector3(x, y, -d).applyQuaternion(q).add(eye);
  const c = [corner(-w, -h), corner(w, -h), corner(w, h), corner(-w, h)];
  const centre = new THREE.Vector3(0, 0, -d).applyQuaternion(q).add(eye);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(eye, c[i]!, c[i]!, c[(i + 1) % 4]!);
  pts.push(eye, centre);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.85, depthTest: false }));
  lines.name = `virtual-camera-frustum:${id}`;
  lines.userData['virtualCameraFrustum'] = { id, position: [...pose.position], rotation: [...pose.rotation], fovY: pose.fovY, aspect };
  lines.renderOrder = 10;
  lines.raycast = () => undefined;
  return lines;
}
