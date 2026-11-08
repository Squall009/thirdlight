/**
 * The voxel world page's materials: the project's material records (read
 * through the command route with the kits), the voxel materials among them
 * in a picker (only materials with a voxel use: a mesh-only, decal or graph
 * material cannot be put in voxels), and the surface's material table built
 * from them. Shift-click adds the picked material; with no voxel material in
 * the project the brush adds voxel id 2 (its stand-in look), as before
 * material records.
 *
 * The page has no change feed: it reads the records again when the window
 * gets the focus back (a material edited in the editor meanwhile) and on
 * the hook's `readMaterials`; a change rewrites the table only.
 */
import { isVoxelMaterial } from '@thirdlight/project-model/voxel-materials';
import type { MaterialDef } from '@thirdlight/project-model';
import { resolveMaterialInstancesLike, voxelLooksKey, voxelRecordLooks, type MaterialDefLike, type VoxelMaterialLook, type VoxelSurface } from '@thirdlight/three-adapter';

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

export class PageMaterials {
  private records: readonly MaterialDef[] = [];
  private key = '';
  private surface: VoxelSurface | null = null;
  private list: PickerMaterial[] = [];
  private picked: number | null = null;
  readonly select = document.createElement('select');

  constructor(
    private readonly read: () => Promise<readonly MaterialDef[]>,
    private readonly base: (material: number) => VoxelMaterialLook,
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
  }

  /** The records read again: the picker follows; the table is rewritten only when a look may have changed. */
  async readAgain(): Promise<boolean> {
    const records = await this.read().catch(() => null);
    if (records === null) return false;
    this.records = records;
    this.fill();
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
