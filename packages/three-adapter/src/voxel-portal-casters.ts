/**
 * The sun's shadow over a structure grid's shut openings that stop light (a door leaf, a shutter; never glass).
 *
 * A shut door's light is stopped in the light volume by its opening's cells (runtime `voxel-portals.ts`), but the
 * sun's direct light comes from the shadow map, where only the prop's own model casts: a leaf a tenth of a metre
 * thick is thinner than a low-tier shadow texel and its bias, so a strip of sun stays on the floor inside the door.
 * Here each shut opening casts over exactly its cells: one mesh of the cells' outer faces, drawn by the shadow cameras
 * only ({@link OFF_VIEW_LAYER}), never in the colour pass, a static caster of the key light's cached map, so a flip
 * draws the map again only where the opening stands. Its thickness is the wall's, whatever the prop's.
 *
 * The meshes sit under the grid's view root (placed and turned with it), placed from their integer corner against
 * the view's floating origin as the chunks are.
 */
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { VOXEL_SIZE_M, type FloatingOrigin, type ShutOpeningWire } from '@thirdlight/voxel';

import { STATIC_CASTER_KEY } from './shadow-casters';
import { OFF_VIEW_LAYER } from './view-hidden';

/** Where the casters report a change of the static shadow map: within a sphere (world metres), or anywhere. */
export interface PortalCasterChanges {
  changedWithin(x: number, y: number, z: number, radius: number): void;
  bump(): void;
}

/** `mesh.userData[PORTAL_CASTER_KEY]`: a shut opening's shadow caster (its prop's id). */
export const PORTAL_CASTER_KEY = '__tlPortalCaster';

/** The six faces of a cell: the step to the neighbour and the face's four corners (cell units, counter-clockwise seen from outside). */
const FACES: readonly { readonly n: readonly [number, number, number]; readonly c: readonly (readonly [number, number, number])[] }[] = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

/**
 * The outer faces of a set of cells (x y z each), positions in metres from the set's lowest corner `lo`: a closed
 * surface round them, so the shadow pass (which draws the back faces of front-sided surfaces) meets it however the
 * sun stands. Null: no cells.
 */
export function openingCasterGeometry(cells: readonly number[]): { geometry: THREE.BufferGeometry; lo: [number, number, number] } | null {
  if (cells.length < 3) return null;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let i = 0; i + 2 < cells.length; i += 3) for (let a = 0; a < 3; a++) lo[a] = Math.min(lo[a]!, cells[i + a]!);
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const held = new Set<string>();
  for (let i = 0; i + 2 < cells.length; i += 3) held.add(key(cells[i]!, cells[i + 1]!, cells[i + 2]!));
  const pos: number[] = [];
  const idx: number[] = [];
  for (const k of held) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    for (const f of FACES) {
      if (held.has(key(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
      const b = pos.length / 3;
      for (const c of f.c) pos.push((x - lo[0] + c[0]) * VOXEL_SIZE_M, (y - lo[1] + c[1]) * VOXEL_SIZE_M, (z - lo[2] + c[2]) * VOXEL_SIZE_M);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  geometry.computeBoundingSphere();
  return { geometry, lo };
}

interface Caster {
  readonly mesh: THREE.Mesh;
  readonly lo: readonly [number, number, number];
  /** The cells it was built from (a change of them builds it again). */
  readonly key: string;
}

export class VoxelPortalCasters {
  /** The casters' parent (under the view's root; hidden with the near field). */
  readonly root = new THREE.Group();
  private readonly casters = new Map<string, Caster>();
  private material: THREE.Material | null = null;
  private readonly at = new THREE.Vector3();

  constructor(
    private readonly origin: FloatingOrigin,
    private readonly changes: PortalCasterChanges | null,
  ) {
    this.root.name = 'voxel portal casters';
  }

  /** Shut openings standing now (how many). */
  get count(): number {
    return this.casters.size;
  }

  /** The grid's shut openings that stop light, the whole set: casters made for new ones, gone for those not in it. */
  set(openings: readonly ShutOpeningWire[]): void {
    const now = new Map(openings.map((o) => [o.id, o]));
    for (const [id, c] of [...this.casters]) {
      const o = now.get(id);
      if (o !== undefined && o.cells.join(',') === c.key) continue;
      this.remove(id);
    }
    for (const o of openings) {
      if (this.casters.has(o.id)) continue;
      const made = openingCasterGeometry(o.cells);
      if (made === null) continue;
      const mesh = new THREE.Mesh(made.geometry, (this.material ??= casterMaterial()));
      mesh.name = 'voxel portal caster';
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(OFF_VIEW_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData[PORTAL_CASTER_KEY] = o.id;
      if (this.changes !== null) mesh.userData[STATIC_CASTER_KEY] = true;
      const c: Caster = { mesh, lo: made.lo, key: o.cells.join(',') };
      this.place(c);
      this.root.add(mesh);
      this.casters.set(o.id, c);
      this.report(mesh);
    }
  }

  dispose(): void {
    for (const id of [...this.casters.keys()]) this.remove(id);
    this.material?.dispose();
    this.material = null;
  }

  private remove(id: string): void {
    const c = this.casters.get(id);
    if (c === undefined) return;
    this.report(c.mesh);
    this.root.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.casters.delete(id);
  }

  private place(c: Caster): void {
    const o = this.origin.origin;
    c.mesh.position.set((c.lo[0] - o.x) * VOXEL_SIZE_M, (c.lo[1] - o.y) * VOXEL_SIZE_M, (c.lo[2] - o.z) * VOXEL_SIZE_M);
    c.mesh.updateMatrix();
  }

  /** The static map is drawn again where the caster stands (its sphere in the world), or everywhere when the root is not placed yet. */
  private report(mesh: THREE.Mesh): void {
    if (this.changes === null) return;
    const s = mesh.geometry.boundingSphere;
    if (s === null || mesh.parent === null) {
      this.changes.bump();
      return;
    }
    mesh.updateWorldMatrix(true, false, true);
    const c = this.at.copy(s.center).applyMatrix4(mesh.matrixWorld);
    this.changes.changedWithin(c.x, c.y, c.z, s.radius);
  }
}

/** Nothing but depth is read from a caster (no colour, grid or texture is shaded for its shadow pixels). */
function casterMaterial(): THREE.Material {
  const m = new MeshBasicNodeMaterial();
  m.name = 'voxel portal caster';
  return m;
}
