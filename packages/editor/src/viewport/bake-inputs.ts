/**
 * What a bake of a scene's static objects needs, gathered from the Scene
 * view in world space: each object's meshes (with UV1: a lightmap target;
 * without: a shadow caster only), each static block layer's chunks (one
 * target per chunk, its lightmap UVs built for the bake), the other layers as
 * shadow casters, and the baked lights. Models use their most detailed level.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import type { BakeLightInput, BakeMeshInput, BlockLayerView } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';

export interface BakeInputHost {
  readonly projected: readonly ProjectedEntity[];
  /** A box's or model's drawn object (its most detailed level when it has levels), null otherwise; its meshes' world matrices are current. */
  rootOf(e: ProjectedEntity): THREE.Object3D | null;
  /** The node an entity is drawn at (a light's position and turn). */
  nodeOf(entityId: string): THREE.Object3D | undefined;
  readonly blockView: BlockLayerView | null;
}

export interface BakeTarget {
  /** An entity id, or `<layer>#<cx>,<cz>` for a block-layer chunk. */
  entityId: string;
  meshes: BakeMeshInput[];
  area: number;
  box: { size: readonly number[]; scale: readonly number[] } | null;
  /** A block-layer chunk target: the layer, the chunk, its lightmap layout and its slots per side. */
  chunk?: { entityId: string; cx: number; cz: number; layout: string; side: number };
}

export interface BakeInputs {
  targets: BakeTarget[];
  occluders: BakeMeshInput[];
  missingUv: string[];
  lights: (BakeLightInput & { entityId: string; mode: 'baked' | 'mixed' })[];
}

/** The objects' world matrices are current when this runs (the Scene view's adapter placed them). */
export function gatherBakeInputs(host: BakeInputHost, entityIds: ReadonlySet<string>): BakeInputs {
  const targets: BakeTarget[] = [];
  const occluders: BakeMeshInput[] = [];
  const missingUv: string[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const worldArea = (g: THREE.BufferGeometry, m: THREE.Matrix4): number => {
    const pos = g.getAttribute('position');
    const index = g.getIndex();
    const n = index !== null ? index.count : pos.count;
    let area = 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = index !== null ? index.getX(i) : i;
      const i1 = index !== null ? index.getX(i + 1) : i + 1;
      const i2 = index !== null ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    return area;
  };
  for (const e of host.projected) {
    if (!entityIds.has(e.id)) continue;
    const root = host.rootOf(e);
    if (root === null) continue;
    const meshes: BakeMeshInput[] = [];
    let noUv = false;
    let area = 0;
    const visit = (o: THREE.Object3D): void => {
      const owner = (o as { entityId?: string }).entityId;
      if (o !== root && owner !== undefined && owner !== e.id) return;
      // Only the most detailed level of a LOD takes part.
      if ((o as THREE.LOD).isLOD === true) {
        const first = (o as THREE.LOD).levels[0]?.object;
        if (first !== undefined) visit(first);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh === true && (mesh as THREE.SkinnedMesh).isSkinnedMesh !== true) {
        const m = { geometry: mesh.geometry, matrixWorld: mesh.matrixWorld.clone() };
        if (mesh.geometry.getAttribute('uv1') !== undefined) {
          meshes.push(m);
          area += worldArea(mesh.geometry, mesh.matrixWorld);
        } else {
          occluders.push(m);
          noUv = true;
        }
      }
      for (const ch of o.children) visit(ch);
    };
    visit(root);
    if (noUv && meshes.length === 0) missingUv.push(e.id);
    if (meshes.length > 0) targets.push({ entityId: e.id, meshes, area, box: e.kind === 'box' ? { size: e.box?.size ?? [1, 1, 1], scale: e.scale } : null });
  }
  // Block layers: a static one's chunks are targets (one lightmap per chunk, its UV1 the chunk's
  // layout); every other layer only shades the baked objects.
  const view = host.blockView;
  const layers = new Set(view?.layerIds().filter((id) => entityIds.has(id)) ?? []);
  if (view !== null) {
    for (const id of layers) view.setLightmapUv(id, true);
    view.update();
    for (const id of layers) {
      for (const t of view.lightmapTargets(id)) {
        targets.push({ entityId: `${id}#${t.cx},${t.cz}`, meshes: t.meshes.map((m) => ({ geometry: m.geometry, matrixWorld: m.matrixWorld.clone() })), area: t.area, box: null, chunk: { entityId: id, cx: t.cx, cz: t.cz, layout: t.layout, side: t.side } });
      }
    }
    for (const id of view.layerIds()) if (!layers.has(id)) for (const mesh of view.layerMeshes(id)) occluders.push({ geometry: mesh.geometry, matrixWorld: mesh.matrixWorld.clone() });
  }
  const lights: (BakeLightInput & { entityId: string; mode: 'baked' | 'mixed' })[] = [];
  for (const e of host.projected) {
    const l = e.light;
    if (l === undefined || e.active === false || (l.mode !== 'baked' && l.mode !== 'mixed')) continue;
    const node = host.nodeOf(e.id);
    const p = new THREE.Vector3();
    node?.getWorldPosition(p);
    let direction = l.direction as readonly [number, number, number] | undefined;
    if (l.type === 'spot' && node !== undefined && l.direction !== undefined) {
      const d = new THREE.Vector3(...l.direction).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize();
      direction = [d.x, d.y, d.z];
    }
    lights.push({
      entityId: e.id,
      mode: l.mode,
      type: l.type,
      color: l.color,
      intensity: l.intensity,
      position: [p.x, p.y, p.z],
      ...(direction !== undefined ? { direction } : {}),
      ...(l.range !== undefined ? { range: l.range } : {}),
      ...(l.decay !== undefined ? { decay: l.decay } : {}),
      ...(l.angle !== undefined ? { angle: l.angle } : {}),
      ...(l.penumbra !== undefined ? { penumbra: l.penumbra } : {}),
      ...(l.groundColor !== undefined ? { groundColor: l.groundColor } : {}),
    });
  }
  return { targets, occluders, missingUv, lights };
}
