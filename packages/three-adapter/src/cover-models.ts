/**
 * Ground cover on placed models: a model object's cover rules (`model.scatter`)
 * grow on the faces of its model that look up, baked into point sets like a
 * block layer's (`cover-view.ts`, the mesh source).
 *
 * The faces are read from the model's most detailed level (its `_COL`,
 * `_OCC` and other levels left out) in the object's world place, once the
 * model has loaded and the object has stood still for {@link SETTLE_FRAMES}
 * frames: an object dragged in the editor or moved by a script is baked
 * again where it comes to rest, never while it moves.
 */
import * as THREE from 'three';

import { coverScatterRules, type ScatterRule } from '@thirdlight/runtime';

import { isCollisionNode, isOccluderNode, lodLevel } from './pieces';
import type { ModelInstance } from './visual';

/** Frames an object's world place must hold before its faces are read (a drag bakes once, where it ends). */
const SETTLE_FRAMES = 10;

/** A model component as cover reads it. */
export interface CoverModelLike {
  readonly asset: { readonly assetId: string };
  readonly piece?: string;
  readonly scatter?: readonly ScatterRule[];
}

export interface CoverModelsDeps {
  /** A model instance of the asset (null while it loads). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** An object's world matrix (false: not placed). */
  worldMatrix(id: string, out: THREE.Matrix4): boolean;
  /** Hand an object's faces over (null: none). */
  setMesh(id: string, rules: readonly ScatterRule[], origin: readonly number[], triangles: Float32Array | null): void;
  changed?(): void;
}

interface Tracked {
  model: CoverModelLike;
  rules: ScatterRule[];
  /** The world matrix seen last frame, how many frames it has held, and the one baked (null: none yet). */
  seen: Float64Array;
  still: number;
  baked: Float64Array | null;
  /** Released: let go at the next update unless set again first (an object realized again keeps its cover). */
  leaving: boolean;
}

/** The model objects with cover rules, and their faces handed over once each settles. */
export class CoverModels {
  private readonly tracked = new Map<string, Tracked>();
  private readonly m = new THREE.Matrix4();

  constructor(private readonly deps: CoverModelsDeps) {}

  /** Object `id`'s model (null or no cover rules: none). */
  set(id: string, model: CoverModelLike | null): void {
    const rules = coverScatterRules(model?.scatter);
    if (model === null || rules.length === 0) {
      this.remove(id);
      return;
    }
    const was = this.tracked.get(id);
    if (was !== undefined) was.leaving = false;
    const same = was !== undefined && was.model.asset.assetId === model.asset.assetId && was.model.piece === model.piece && JSON.stringify(was.rules) === JSON.stringify(rules);
    if (same) return;
    // A new model: baked once it stands still (the old faces' cover is drawn until then).
    this.tracked.set(id, { model, rules, seen: new Float64Array(16).fill(NaN), still: 0, baked: null, leaving: false });
  }

  /** Object `id` was released: its cover goes at the next update unless it is set again first. */
  remove(id: string): void {
    const t = this.tracked.get(id);
    if (t !== undefined) t.leaving = true;
  }

  /** Read the faces of the objects that settled somewhere new (once a frame). */
  update(): void {
    for (const [id, t] of this.tracked) {
      if (t.leaving) {
        this.tracked.delete(id);
        this.deps.setMesh(id, [], [0, 0, 0], null);
        continue;
      }
      if (!this.deps.worldMatrix(id, this.m)) continue;
      const e = this.m.elements;
      let moved = false;
      for (let k = 0; k < 16; k++) if (t.seen[k] !== e[k]) moved = true;
      if (moved) {
        t.seen.set(e);
        t.still = 0;
        continue;
      }
      if (t.still < SETTLE_FRAMES) {
        t.still += 1;
        continue;
      }
      if (t.baked !== null && t.baked.every((v, k) => v === e[k])) continue;
      const inst = this.deps.template(t.model.asset.assetId, t.model.piece, () => this.deps.changed?.());
      if (inst === null) continue;
      t.baked = Float64Array.from(e);
      const origin = [e[12]!, e[13]!, e[14]!];
      this.deps.setMesh(id, t.rules, origin, modelTriangles(inst.glbRoot, this.m, origin));
    }
  }
}

/**
 * The faces of a model's most detailed level placed by `world` (the
 * model's hierarchy under it), less `origin`: 9 floats a triangle, wound
 * counter-clockwise seen from the front.
 */
export function modelTriangles(root: THREE.Object3D, world: THREE.Matrix4, origin: readonly number[]): Float32Array {
  const out: number[] = [];
  const v = new THREE.Vector3();
  const visit = (o: THREE.Object3D, parent: THREE.Matrix4): void => {
    if (!o.visible || isCollisionNode(o) || isOccluderNode(o) || (lodLevel(o.name) ?? 0) > 0) return;
    const m = parent.clone().multiply(new THREE.Matrix4().compose(o.position, o.quaternion, o.scale));
    const mesh = o as THREE.Mesh;
    const pos = mesh.isMesh === true ? mesh.geometry.getAttribute('position') : undefined;
    if (pos !== undefined) {
      const index = mesh.geometry.getIndex();
      const n = index !== null ? index.count : pos.count;
      // A mirrored placement turns the faces over: the winding follows.
      const flip = m.determinant() < 0;
      for (let i = 0; i + 2 < n; i += 3) {
        for (const k of flip ? [0, 2, 1] : [0, 1, 2]) {
          const vi = index !== null ? index.getX(i + k) : i + k;
          v.fromBufferAttribute(pos, vi).applyMatrix4(m);
          out.push(v.x - origin[0]!, v.y - origin[1]!, v.z - origin[2]!);
        }
      }
    }
    // A level group: its most detailed level only.
    const lod = o as THREE.LOD;
    const kids = lod.isLOD === true ? (lod.levels[0] !== undefined ? [lod.levels[0].object] : []) : o.children;
    for (const c of kids) visit(c, m);
  };
  visit(root, world);
  return Float32Array.from(out);
}
