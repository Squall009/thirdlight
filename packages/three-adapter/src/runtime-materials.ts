/**
 * Phase 23.12 (E9): the renderer's side of `ctx.materials` — the material
 * parameter changes the simulation sends each frame (runtime
 * `takeMaterialChanges`, through the worker frame in threaded Play) put on
 * the objects' meshes through the material library:
 *
 * - a number, vector or colour becomes the object's per-object uniform value
 *   (the shared compiled material is untouched: no recompile, no new program);
 * - a texture chooses the compiled variant (the texture-override path);
 * - a data parameter's grid is the object's own data texture, made on its
 *   first change and updated in place after that (three uploads it once per
 *   change). An object keeps its texture until it leaves (a reset writes the
 *   starting cells into it), so its texture binding never switches back.
 *
 * The values are kept per object so meshes that arrive later (a model still
 * loading) get them when they attach.
 */
import * as THREE from 'three';

import { makeDataTexture } from './material-graph';
import type { MaterialLibrary } from './material-library';

/** The adapter's structural copy of a runtime `MaterialRenderChange`. */
export type MaterialRenderChangeLike =
  | { readonly op: 'set'; readonly entityId: string; readonly materialId: string; readonly key: string; readonly value: number | readonly number[] | string }
  | { readonly op: 'clear'; readonly entityId: string; readonly materialId: string; readonly key: string }
  | { readonly op: 'data'; readonly entityId: string; readonly materialId: string; readonly key: string; readonly size: readonly number[]; readonly bytes: Uint8Array };

interface ObjectValues {
  readonly values: Map<string, { materialId: string; key: string; value: number | readonly number[] | string }>;
  readonly data: Map<string, { materialId: string; key: string; texture: THREE.DataTexture }>;
}

export interface RuntimeMaterialsDiagnostics {
  /** Objects carrying values a script set. */
  readonly objects: number;
  /** Their data textures. */
  readonly dataTextures: number;
}

export class RuntimeMaterialView {
  private readonly byEntity = new Map<string, ObjectValues>();

  constructor(
    private readonly library: MaterialLibrary,
    /** One object's own meshes (not its child objects'). */
    private readonly meshesOf: (entityId: string) => THREE.Object3D[],
  ) {}

  /** Apply the simulation's changes (in order). */
  apply(changes: readonly MaterialRenderChangeLike[]): void {
    for (const c of changes) {
      const k = `${c.materialId}\u0000${c.key}`;
      let o = this.byEntity.get(c.entityId);
      if (o === undefined) this.byEntity.set(c.entityId, (o = { values: new Map(), data: new Map() }));
      const meshes = this.meshesOf(c.entityId);
      if (c.op === 'set') {
        o.values.set(k, { materialId: c.materialId, key: c.key, value: c.value });
        this.library.setRuntimeValue(meshes, c.materialId, c.key, c.value);
      } else if (c.op === 'clear') {
        o.values.delete(k);
        this.library.setRuntimeValue(meshes, c.materialId, c.key, undefined);
      } else {
        const [w, h] = [Math.max(1, c.size[0] ?? 1), Math.max(1, c.size[1] ?? 1)];
        let d = o.data.get(k);
        const image = d?.texture.image as { data: Uint8Array; width: number; height: number } | undefined;
        if (d === undefined || image === undefined || image.width !== w || image.height !== h) {
          d?.texture.dispose();
          const texture = makeDataTexture(new Uint8Array(c.bytes), w, h);
          // One more version than a fresh placeholder (1): the first swap from the placeholder always rebinds.
          texture.needsUpdate = true;
          d = { materialId: c.materialId, key: c.key, texture };
          o.data.set(k, d);
        } else {
          image.data.set(c.bytes.subarray(0, image.data.length));
          d.texture.needsUpdate = true;
        }
        this.library.setRuntimeData(meshes, c.materialId, c.key, d.texture);
      }
      if (o.values.size === 0 && o.data.size === 0) this.byEntity.delete(c.entityId);
    }
  }

  /** Put an object's values on its meshes again (a model attached after the values arrived). */
  reapply(entityId: string): void {
    const o = this.byEntity.get(entityId);
    if (o === undefined) return;
    const meshes = this.meshesOf(entityId);
    for (const v of o.values.values()) this.library.setRuntimeValue(meshes, v.materialId, v.key, v.value);
    for (const d of o.data.values()) this.library.setRuntimeData(meshes, d.materialId, d.key, d.texture);
  }

  /** An object left the game: its data textures are released. */
  release(entityId: string): void {
    const o = this.byEntity.get(entityId);
    if (o === undefined) return;
    for (const d of o.data.values()) d.texture.dispose();
    this.byEntity.delete(entityId);
  }

  diagnostics(): RuntimeMaterialsDiagnostics {
    let dataTextures = 0;
    for (const o of this.byEntity.values()) dataTextures += o.data.size;
    return { objects: this.byEntity.size, dataTextures };
  }

  dispose(): void {
    for (const id of [...this.byEntity.keys()]) this.release(id);
  }
}
