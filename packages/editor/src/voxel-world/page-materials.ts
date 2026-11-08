/**
 * The voxel world page's materials: the project's material records (read
 * through the command route with the kits), the voxel materials among them
 * in a picker (only materials with a voxel use: a mesh-only, decal or graph
 * material cannot be put in voxels), and the surface's material table built
 * from them. Shift-click adds the picked material; with no voxel material in
 * the project the brush adds voxel id 2 (its stand-in look), as before
 * material records.
 *
 * The records' surface texture sets draw from texture arrays the backend
 * assembles (the route the editor's views use), loaded once the sets change
 * and handed to the surface with each id's layers; until they arrive the
 * surfaces draw their flat colours.
 *
 * The page has no change feed: it reads the records again when the window
 * gets the focus back (a material edited in the editor meanwhile) and on
 * the hook's `readMaterials`; a change rewrites the table only (and loads
 * the arrays when the sets changed).
 */
import { isVoxelMaterial } from '@thirdlight/project-model/voxel-materials';
import type { MaterialDef } from '@thirdlight/project-model';
import { textureSlotSetKey, type TextureSlotSet } from '@thirdlight/project-model/texture-slots';
import { VOXEL_TEXTURE_MAPS } from '@thirdlight/project-model/voxel-materials';
import { decodeTexture, resolveMaterialInstancesLike, setKtx2DecoderBase, voxelLooksKey, voxelRecordLooks, voxelRecordTextures, type MaterialDefLike, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceTextureArrays } from '@thirdlight/three-adapter';
import type * as THREE from 'three';

/** The voxel id the brush adds when the project has no voxel material. */
const STAND_IN_MATERIAL = 2;

/** A picker entry: a voxel material's id, name and use. */
export interface PickerMaterial {
  readonly id: number;
  readonly materialId: string;
  readonly name: string;
  readonly use: string;
}

/** The voxel materials of a record list (instances resolved), by voxel id. */
export function voxelPickerMaterials(materials: readonly MaterialDef[]): PickerMaterial[] {
  const resolved = resolveMaterialInstancesLike(materials as unknown as MaterialDefLike[]) as unknown as MaterialDef[];
  return resolved
    .filter((m) => isVoxelMaterial(m))
    .map((m) => ({ id: m.voxel!.id, materialId: m.materialId, name: m.name, use: m.voxel!.use! }))
    .sort((a, b) => a.id - b.id);
}

/**
 * A slot list's texture array from the backend's slot assembly (the route the editor's views use); KTX2 transcodes
 * with three's Basis files next to the page.
 */
export function backendArrays(api: string, headers: Readonly<Record<string, string>>): (set: TextureSlotSet) => Promise<THREE.Texture> {
  setKtx2DecoderBase('./decoders/');
  return async (set) => {
    const res = await fetch(`${api}/content/textures/slots`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ layers: set.layers, mode: set.mode, ...(set.height === true ? { height: true } : {}) }) });
    if (!res.ok) throw new Error(`texture array (${set.mode}, ${set.layers.length} layers): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return decodeTexture(new Uint8Array(await res.arrayBuffer()));
  };
}

export class PageMaterials {
  private records: readonly MaterialDef[] = [];
  private key = '';
  private surface: VoxelSurface | null = null;
  private list: PickerMaterial[] = [];
  private picked: number | null = null;
  readonly select = document.createElement('select');
  /** The arrays drawn and the key of the sets they are; the sets asked for last. */
  private arrays: THREE.Texture[] = [];
  private arraysKey = '';
  private arraysWanted = '';
  /** Texture array loads (and the ms the last took, its layers), failures and their last message: the hook reads them. */
  readonly textures = { loads: 0, ms: 0, layers: 0, failures: 0, problem: '' };

  constructor(
    private readonly read: () => Promise<readonly MaterialDef[]>,
    private readonly base: (material: number) => VoxelMaterialLook,
    /** A slot list's texture array (null: none: the page draws flat colours). */
    private readonly loadArray: ((set: TextureSlotSet) => Promise<THREE.Texture>) | null = null,
  ) {
    this.select.setAttribute('aria-label', 'voxel material');
    this.select.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px system-ui,sans-serif;max-width:40vw';
    this.select.addEventListener('change', () => (this.picked = Number(this.select.value)));
    addEventListener('focus', () => void this.readAgain());
  }

  /** The first records (before the surface is made). */
  take(records: readonly MaterialDef[]): void {
    this.records = records;
    this.key = voxelLooksKey(records);
    this.fill();
  }

  /** The surface's looks: the records' over the page's base looks. */
  look(): (material: number) => VoxelMaterialLook {
    return voxelRecordLooks(this.records, this.base);
  }

  attach(surface: VoxelSurface): void {
    this.surface = surface;
    void this.loadTextures();
  }

  /** The arrays of the records' sets, given to the surface once all are loaded (the same sets: nothing done). */
  private async loadTextures(): Promise<void> {
    const surface = this.surface;
    if (surface === null || this.loadArray === null) return;
    const made = voxelRecordTextures(this.records);
    const key = made === null ? '' : JSON.stringify([VOXEL_TEXTURE_MAPS.map((m) => (made.sets[m] === undefined ? '' : textureSlotSetKey(made.sets[m]))), [...made.layers]]);
    if (key === this.arraysWanted) return;
    this.arraysWanted = key;
    const t0 = performance.now();
    let loaded: [string, THREE.Texture | null][] = [];
    try {
      loaded = made === null ? [] : await Promise.all(VOXEL_TEXTURE_MAPS.map(async (m) => [m, made.sets[m] === undefined ? null : await this.loadArray!(made.sets[m])] as [string, THREE.Texture | null]));
    } catch (e) {
      this.textures.failures++;
      this.textures.problem = e instanceof Error ? e.message : String(e);
      return;
    }
    const fresh = loaded.flatMap(([, t]) => (t === null ? [] : [t]));
    if (this.arraysWanted !== key) {
      for (const t of fresh) t.dispose();
      return;
    }
    surface.setTextures(made === null ? null : (Object.fromEntries(loaded.filter(([, t]) => t !== null)) as VoxelSurfaceTextureArrays), (m) => made?.layers.get(m) ?? null);
    for (const t of this.arrays) t.dispose();
    this.arrays = fresh;
    this.arraysKey = key;
    this.textures.loads++;
    this.textures.ms = performance.now() - t0;
    this.textures.layers = made?.sets.albedoHeight.layers.length ?? 0;
  }

  /** Whether the arrays drawn are those of the records read last. */
  get texturesCurrent(): boolean {
    return this.arraysKey === this.arraysWanted;
  }

  /** The records read again: the picker follows; the table is rewritten only when a look may have changed. */
  async readAgain(): Promise<boolean> {
    const records = await this.read().catch(() => null);
    if (records === null) return false;
    this.records = records;
    this.fill();
    void this.loadTextures();
    const key = voxelLooksKey(records);
    if (key === this.key) return false;
    this.key = key;
    this.surface?.setLooks(this.look());
    return true;
  }

  /** The voxel id shift-click adds. */
  get material(): number {
    return this.picked ?? STAND_IN_MATERIAL;
  }

  /** Picks a voxel material by id (false: not one the picker lists). */
  pick(id: number): boolean {
    if (!this.list.some((m) => m.id === id)) return false;
    this.picked = id;
    this.select.value = String(id);
    return true;
  }

  get entries(): readonly PickerMaterial[] {
    return this.list;
  }

  private fill(): void {
    this.list = voxelPickerMaterials(this.records);
    if (this.picked !== null && !this.list.some((m) => m.id === this.picked)) this.picked = null;
    this.picked ??= this.list[0]?.id ?? null;
    this.select.replaceChildren(
      ...(this.list.length === 0
        ? [new Option(`no voxel materials (adds stand-in ${STAND_IN_MATERIAL})`, String(STAND_IN_MATERIAL))]
        : this.list.map((m) => new Option(`${m.name} · ${m.id} · ${m.use}`, String(m.id)))),
    );
    this.select.disabled = this.list.length === 0;
    if (this.picked !== null) this.select.value = String(this.picked);
  }
}
