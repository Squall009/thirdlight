/**
 * The adapter's materials: the project material library (the host's, or one
 * of the adapter's own), the decal pages and projected decals the loaded
 * decals use, each object's mapping with the swap a running game put over it,
 * the values scripts set per object, and the material swaps themselves.
 *
 * Kept apart from the adapter so what objects wear is wired in one place.
 */
import type * as THREE from 'three';
import type { ResourceManager } from '@thirdlight/runtime';
import type { BlockType } from '@thirdlight/project-model';

import type { SceneAdapterOptions } from './adapter-types';
import { createDecalPages, type AdapterDecalPages } from './decal-pages';
import { createDecalProjectors, type DecalProjectors } from './decal-projectors';
import type { LightmapSet } from './lightmaps';
import { createMaterialLibrary, type MaterialLibrary } from './material-library';
import { MaterialSwapView, type MaterialMappingLike } from './material-swaps';
import { RuntimeMaterialView } from './runtime-materials';
import { textureHolds } from './texture-holds';
import { reportPaintStreamOverflow } from './vertex-paint-draw';
import { syncCellUv } from './block-cell-uv';
import { materialParamsOf } from './entity-refs';

type Mapping = Readonly<Record<string, string>>;

/** What a swap puts its materials on: the realized objects and the views that draw some of them. */
export interface MaterialSwapHost {
  /** A realized object's components (undefined: not realized). */
  components(entityId: string): object | undefined;
  readonly disposed: () => boolean;
  /** An asset's own material mapping (its import's). */
  assetMaterials(assetId: string | undefined): Mapping | undefined;
  /** The authored block types (their own mappings). */
  blockTypes(): readonly BlockType[];
  /** A spline's, an architecture's or a terrain's object: its view puts the materials on (true: it did). */
  restyleView(entityId: string, components: object): boolean;
  /** An object's node (undefined: it has none). */
  node(entityId: string): THREE.Object3D | undefined;
  lightmaps(): LightmapSet | null;
  /** A model's or instance set's materials put on again (its root; null: none realized). */
  reapplyModel(entityId: string): THREE.Object3D | null;
  regroup(entityId: string): void;
  /** The block types with the swaps over them. */
  setBlockTypes(types: BlockType[]): void;
}

export class AdapterMaterials {
  readonly library: MaterialLibrary | null;
  /** A library the host keeps (the editor's) is used as it is: the host sets its materials and wind and disposes it. */
  private readonly own: boolean;
  /** The decal pages the loaded decals' materials name, held per decal and uploaded as they arrive. */
  readonly decalPages: AdapterDecalPages | null;
  /** The projected decals the loaded decal entities lay over every lit surface (off: `projectedDecals: false`). */
  readonly projectors: DecalProjectors | null;
  /** Each object's undo of the shared material paths put on it. */
  readonly undo = new Map<string, () => void>();
  /** The material swaps the running game made, put on once their materials have loaded (`createSwaps`). */
  swaps: MaterialSwapView | null = null;
  /** The values scripts set per object (the simulation's material changes; `trackRuntime`). */
  runtime: RuntimeMaterialView | null = null;
  private readonly paintOverflow: (() => void) | null;
  private readonly stopDefinitions: (() => void) | undefined;
  private stopCellUv: (() => void) | undefined;
  private stopReassigned: (() => void) | undefined;

  constructor(scene: THREE.Scene, resources: ResourceManager, opts: SceneAdapterOptions, lightmaps: () => LightmapSet | null) {
    this.own = opts.materials !== undefined && opts.materials.library === undefined;
    const library: MaterialLibrary | null =
      opts.materials?.library ??
      (opts.materials !== undefined
        ? createMaterialLibrary({
            loadTexture: opts.materials.loadTexture,
            resources,
            // A project material changed in place (a texture arrived): lightmapped
            // copies made before are clones and follow it (else they keep the texture-less look).
            onChange: () => lightmaps()?.refresh(),
          })
        : null);
    this.library = library;
    if (library !== null && opts.materials !== undefined && this.own) {
      library.setMaterials(opts.materials.defs, opts.materials.functions ?? []);
      library.setWind(opts.materials.wind);
    }
    const decalPages = library?.decalPageOf !== undefined && opts.materials !== undefined ? createDecalPages({ holds: textureHolds(resources, opts.materials.loadTexture), pageOf: (id) => library.decalPageOf!(id), onChange: () => opts.onChange?.() }) : null;
    this.decalPages = decalPages;
    const decalOptions = typeof opts.projectedDecals === 'object' ? opts.projectedDecals : {};
    this.projectors =
      library?.projectedDecal !== undefined && opts.projectedDecals !== false
        ? createDecalProjectors({ scene, materialOf: (holder, id) => library.projectedDecal!(holder, id), holdPages: (holder, id) => (id === null ? decalPages?.remove(holder) : decalPages?.set(holder, id)), ...(decalOptions.onProblem !== undefined ? { onProblem: decalOptions.onProblem } : {}), onChange: () => opts.onChange?.() })
        : null;
    // A painted draw past the device's largest texture is drawn unpainted: the host's Problems say so.
    this.paintOverflow = typeof opts.vertexPaint === 'object' && opts.vertexPaint.onProblem !== undefined ? reportPaintStreamOverflow(opts.vertexPaint.onProblem) : null;
    // A library the host keeps (the editor's) outlives this adapter: its listener goes with the adapter.
    const projectors = this.projectors;
    this.stopDefinitions = library?.onDefinitions?.(() => {
      decalPages?.refresh();
      projectors?.refresh();
    });
  }

  /** An object's own mapping with the swap it wears over it (undefined: none of either). */
  readonly effective = (entityId: string, own: Mapping | undefined): Mapping | undefined => {
    const swap = this.swaps?.swapOf(entityId) ?? null;
    return swap === null ? own : { ...(own ?? {}), ...swap };
  };

  /** The values scripts set go on one object's own meshes. */
  trackRuntime(ownMeshes: (entityId: string) => THREE.Object3D[]): void {
    if (this.library !== null) this.runtime = new RuntimeMaterialView(this.library, ownMeshes);
  }

  /**
   * A redefined material is put on again: a block chunk's UVs follow the unit it reads (cells or metres) first,
   * then the meshes wearing it are grouped again (`regroup` absent: nothing is grouped).
   */
  listenReassigned(regroup: ((root: THREE.Object3D) => void) | null): void {
    this.stopCellUv = this.library?.onReassigned?.((root) => void ((root as THREE.Mesh).isMesh === true && syncCellUv(root as THREE.Mesh)));
    this.stopReassigned = regroup === null ? undefined : this.library?.onReassigned?.(regroup);
  }

  /** The material swaps a running game makes (none without a library). */
  createSwaps(host: MaterialSwapHost, textureRefs: ((materialId: string) => readonly string[]) | undefined): void {
    const library = this.library;
    if (library === null) return;
    this.swaps = new MaterialSwapView({
      entityMapping: (entityId, swap) => {
        const c = host.components(entityId) as { materials?: Record<string, string>; model?: { asset?: { assetId?: string } }; instances?: { asset?: { assetId?: string } } } | undefined;
        if (c === undefined) return null;
        const mapping = { ...(host.assetMaterials(c.model?.asset?.assetId ?? c.instances?.asset?.assetId) ?? {}), ...(c.materials ?? {}), ...(swap ?? {}) };
        return Object.keys(mapping).length === 0 ? null : mapping;
      },
      blockMapping: (blockId, swap) => {
        const own = host.blockTypes().find((t) => t.blockId === blockId)?.materials;
        const mapping = { ...(own ?? {}), ...(swap ?? {}) };
        return Object.keys(mapping).length === 0 ? null : mapping;
      },
      textureRefs: (materialId) => textureRefs?.(materialId) ?? [],
      ...(library.preloadTextures !== undefined ? { preload: (ids: readonly string[]) => library.preloadTextures!(ids) } : {}),
      applyEntity: (entityId) => this.applySwap(host, library, entityId),
      applyBlockTypes: () => {
        const swaps = this.swaps?.appliedBlocks() ?? new Map<string, MaterialMappingLike>();
        host.setBlockTypes(host.blockTypes().map((t) => {
          const swap = swaps.get(t.blockId);
          return swap === undefined ? t : { ...t, materials: { ...(t.materials ?? {}), ...swap } };
        }));
      },
    });
  }

  private applySwap(host: MaterialSwapHost, library: MaterialLibrary, entityId: string): void {
    const c = host.components(entityId);
    // A spline's, an architecture's or a terrain's object: its view's meshes wear it (no entity node of their own).
    if (c !== undefined && !host.disposed() && host.restyleView(entityId, c)) return;
    const obj = host.node(entityId);
    if (c === undefined || obj === undefined || host.disposed()) return;
    // The lightmapped copies are of the materials worn before: taken off, then made again over the new ones.
    host.lightmaps()?.release(entityId);
    let root: THREE.Object3D | null = null;
    if ((c as { box?: unknown }).box !== undefined) {
      const mapping = this.effective(entityId, (c as { materials?: Record<string, string> }).materials);
      this.undo.set(entityId, library.apply(obj, mapping ?? null, materialParamsOf(c)));
      root = obj;
    } else root = host.reapplyModel(entityId);
    if (root !== null) host.lightmaps()?.apply(entityId, root);
    // Values a script set on its graph materials go on the new ones.
    this.runtime?.reapply(entityId);
    host.regroup(entityId);
  }

  dispose(): void {
    this.paintOverflow?.();
    this.decalPages?.dispose();
    this.projectors?.dispose();
    this.runtime?.dispose();
    this.swaps?.dispose();
    if (this.own) this.library?.dispose();
    this.stopReassigned?.();
    this.stopDefinitions?.();
    this.stopCellUv?.();
  }
}
