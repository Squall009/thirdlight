/**
 * The preview pane's material and model subjects (the effect's is in
 * `preview-effect.ts`).
 *
 * - Material: one graph material on a sphere, a plane, a cube or a model of
 *   the project, compiled by the stage's material library (the one
 *   three-adapter path the Scene view, Play and exports compile with).
 * - Model: an object the caller realizes into the stage (a model with its
 *   animator controller running, or a model asset with its clips), framed
 *   once it is there and released when the subject goes.
 *
 * Browser-only.
 */
import { previewFrameSeconds } from '@thirdlight/runtime';
import { disposeObjectTree, type GraphProblem, type MaterialDefLike, type MaterialFunctionLike } from '@thirdlight/three-adapter';
import * as THREE from 'three';

import type { PreviewStage, PreviewSubject } from './preview-renderer';

export type PreviewShape = 'sphere' | 'plane' | 'cube' | 'model';

export class MaterialSubject implements PreviewSubject {
  readonly key: string;
  private stage: PreviewStage | null = null;
  private readonly holder = new THREE.Group();
  private undo: (() => void) | null = null;
  private materialId: string | null = null;
  private shapeObject: THREE.Object3D | null = null;
  /** The primitive's own geometry and material (released with its shape); null for a model. */
  private owned: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;
  /** The materials last given (the stage's library takes them again when the subject attaches). */
  private pending: { defs: readonly MaterialDefLike[]; functions: readonly MaterialFunctionLike[] } | null = null;
  private pendingShape: { shape: PreviewShape; model: THREE.Object3D | null } = { shape: 'sphere', model: null };
  private disposed = false;

  constructor(materialId: string) {
    this.key = `material:${materialId}`;
  }

  attach(stage: PreviewStage): void {
    this.stage = stage;
    stage.scene.add(this.holder);
    this.setShape(this.pendingShape.shape, this.pendingShape.model);
  }

  /** The project materials and functions, and which material the shape wears. */
  setMaterial(defs: readonly MaterialDefLike[], functions: readonly MaterialFunctionLike[], materialId: string): void {
    this.stage?.library.setMaterials(defs, functions);
    this.pending = { defs, functions };
    if (this.materialId !== materialId) {
      this.materialId = materialId;
      this.applyMaterial();
    }
  }

  /** The compile problems of the previewed graph (null until it compiled). */
  problems(): readonly GraphProblem[] | null {
    return this.materialId === null || this.stage === null ? null : this.stage.library.graphProblems(this.materialId);
  }

  /** A primitive, or a model's root (`model`; the caller keeps ownership of it). */
  setShape(shape: PreviewShape, model?: THREE.Object3D | null): void {
    // A React cleanup may reset the shape after the subject was released (effects clean up in order).
    if (this.disposed) return;
    this.pendingShape = { shape, model: model ?? null };
    const stage = this.stage;
    if (stage === null) return;
    if (this.pending !== null) stage.library.setMaterials(this.pending.defs, this.pending.functions);
    this.clearShape();
    let obj: THREE.Object3D;
    if (shape === 'model' && model !== undefined && model !== null) obj = model;
    else {
      const g = shape === 'plane' ? new THREE.PlaneGeometry(2, 2) : shape === 'cube' ? new THREE.BoxGeometry(1.3, 1.3, 1.3) : new THREE.SphereGeometry(0.9, 64, 32);
      if (shape === 'plane') g.rotateX(-Math.PI / 3);
      const material = new THREE.MeshStandardMaterial({ color: 0xc8c8c8 });
      this.owned = { geometry: g, material };
      obj = new THREE.Mesh(g, material);
    }
    this.shapeObject = obj;
    this.holder.add(obj);
    stage.frame(new THREE.Box3().setFromObject(obj));
    this.applyMaterial();
  }

  private applyMaterial(): void {
    this.undo?.();
    this.undo = this.stage !== null && this.shapeObject !== null && this.materialId !== null ? this.stage.library.apply(this.shapeObject, { '*': this.materialId }) : null;
  }

  private clearShape(): void {
    this.undo?.();
    this.undo = null;
    if (this.shapeObject !== null) {
      this.holder.remove(this.shapeObject);
      // The primitive's render objects (it wore the library's material, which stays).
      if (this.owned !== null) disposeObjectTree(this.shapeObject);
    }
    this.shapeObject = null;
    this.owned?.geometry.dispose();
    this.owned?.material.dispose();
    this.owned = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearShape();
    this.disposed = true;
    this.holder.removeFromParent();
    this.stage = null;
  }
}

/** A realized object in the stage and how to let go of it. */
export interface PreviewObject {
  readonly root: THREE.Object3D;
  /** Before each frame (an animator steps here). */
  step?(dtSeconds: number): void;
  dispose(): void;
}

/**
 * A model the caller realizes into the stage: `realize(parent)` adds it under
 * `parent` (or says why it cannot); the subject frames it, steps it each
 * frame and releases it when it goes — also when the realization finishes
 * after the subject was replaced.
 */
export class ModelSubject implements PreviewSubject {
  private stage: PreviewStage | null = null;
  private readonly holder = new THREE.Group();
  private object: PreviewObject | null = null;
  private last: number | null = null;
  private disposed = false;

  constructor(
    readonly key: string,
    private readonly realize: (parent: THREE.Object3D) => Promise<PreviewObject | string>,
    private readonly onResult?: (result: PreviewObject | string) => void,
  ) {}

  attach(stage: PreviewStage): void {
    this.stage = stage;
    stage.scene.add(this.holder);
    stage.setGrid(true);
    void this.realize(this.holder).then(
      (r) => {
        if (typeof r !== 'string' && this.disposed) {
          r.dispose();
          return;
        }
        if (this.disposed) return;
        if (typeof r !== 'string') {
          this.object = r;
          stage.frame(new THREE.Box3().setFromObject(r.root), new THREE.Vector3(1, 0.6, 1.2));
        }
        this.onResult?.(r);
      },
      (e: unknown) => {
        if (!this.disposed) this.onResult?.(e instanceof Error ? e.message : String(e));
      },
    );
  }

  update(_stage: PreviewStage, now: number): void {
    const dt = this.last === null ? 0 : previewFrameSeconds(now, this.last);
    this.last = now;
    this.object?.step?.(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object?.dispose();
    this.object = null;
    this.holder.removeFromParent();
    this.stage?.setGrid(false);
    this.stage = null;
  }
}
