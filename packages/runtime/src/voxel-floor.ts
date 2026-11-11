/**
 * The coarse floor of a voxel world in the physics port: where a body's
 * fine collision is not in place yet, a heightfield of the far cache's 2 m
 * ground (`@thirdlight/voxel` far-ground.ts) a storage chunk column, so a
 * body comes to rest on the ground the far field draws instead of hanging
 * in the air or falling through.
 *
 * - **Where.** Chunk columns within the collision ring's add radius of a
 *   collision focus (the bodies, points ahead of them, the camera when it is
 *   not travelling fast) whose fine collision has not settled get a floor;
 *   a floor goes once its column settles (fine bodies in place) or every
 *   focus left its keep radius.
 * - **Hand-over.** The fine ground replaces a floor where the floor lay,
 *   above or below it. A body standing on a floor higher than the fine
 *   ground drops onto it (the floor lies on or above the coarse ground, so a
 *   short drop is the usual case); one the fine ground holds inside it (the
 *   fine ground lies higher) is lifted onto it by its host in the same step
 *   ({@link VoxelFloors.riseAt}).
 * - **Caves.** A floor is the column's top surface: a body more than
 *   {@link FLOOR_BELOW_M} under its lowest point (a cave, a tunnel) is not
 *   standing on it, and waits for its fine collision as before.
 */
import { heightfieldPart, VOXEL_SIZE_M, type ChunkGrid, type FarGround } from '@thirdlight/voxel';
import type { ColliderShape3D, PhysicsPort3D } from './ports';

/** How far under a floor's lowest point a body still counts as on it (metres): deeper, it is in a cave under the top. */
export const FLOOR_BELOW_M = 2;

/** How far over a body the fine ground that replaced its floor is looked for (metres): the coarse ground's error and more. */
export const FLOOR_LIFT_M = 4;

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

interface Floor {
  readonly cx: number;
  readonly cz: number;
  readonly id: string;
  readonly min: number;
}

/** A chunk column in the add or keep radius of the collision foci. */
export interface FloorColumns {
  /** Columns a floor may be added to (within the add radius of a focus). */
  readonly add: ReadonlyMap<number, { readonly cx: number; readonly cz: number }>;
  /** Columns a floor is kept in (within the keep radius). */
  readonly keep: ReadonlySet<number>;
}

/** The chunk columns near the foci (cells), by key: within `radius` to add, `keepRadius` to keep. */
export function floorColumns(grid: ChunkGrid, foci: readonly { readonly x: number; readonly z: number }[], radius: number, keepRadius: number): FloorColumns {
  const e = grid.edge;
  const add = new Map<number, { cx: number; cz: number }>();
  const keep = new Set<number>();
  const gap = (p: number, lo: number): number => (p < lo ? lo - p : p > lo + e ? p - lo - e : 0);
  for (const f of foci) {
    for (let cx = Math.floor((f.x - keepRadius) / e); cx <= Math.floor((f.x + keepRadius) / e); cx++) for (let cz = Math.floor((f.z - keepRadius) / e); cz <= Math.floor((f.z + keepRadius) / e); cz++) {
      const d = Math.hypot(gap(f.x, cx * e), gap(f.z, cz * e));
      if (d >= keepRadius) continue;
      const key = columnKey(cx, cz);
      keep.add(key);
      if (d < radius) add.set(key, { cx, cz });
    }
  }
  return { add, keep };
}

/** A chunk column's key (16 bits an axis: any world's chunk columns). */
function columnKey(cx: number, cz: number): number {
  return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
}

export class VoxelFloors {
  private readonly floors = new Map<number, Floor>();
  /** Columns whose floor went this step because their fine collision settled. */
  private handed = new Set<number>();
  /** Floors added and removed since the world opened, and those handed to the fine ground. */
  readonly counters = { added: 0, removed: 0, handedOver: 0, lifted: 0 };

  constructor(
    private readonly port: PhysicsPort3D,
    private readonly grid: ChunkGrid,
    /** The world's collider id prefix (`voxel:<world>:`): floors are `<prefix>floor:cx,cz`, chunk bodies the rest. */
    private readonly prefix: string,
    private readonly ground: FarGround,
  ) {}

  get count(): number {
    return this.floors.size;
  }

  /**
   * After the ring moved: floors whose column settled go (handed over), those every focus left go, and columns in
   * the add radius without fine collision get one once their coarse ground is known.
   */
  update(columns: FloorColumns, settled: (cx: number, cz: number) => boolean): void {
    this.handed = new Set();
    const gone: string[] = [];
    for (const [key, f] of this.floors) {
      const fine = settled(f.cx, f.cz);
      if (!fine && columns.keep.has(key)) continue;
      gone.push(f.id);
      this.floors.delete(key);
      this.counters.removed++;
      if (fine) {
        this.handed.add(key);
        this.counters.handedOver++;
      }
    }
    if (gone.length > 0) this.port.removeStaticColliders!(gone);
    const m = this.grid.edge * VOXEL_SIZE_M;
    for (const [key, c] of columns.add) {
      if (this.floors.has(key) || settled(c.cx, c.cz)) continue;
      const field = this.ground.field(c.cx, c.cz);
      if (field === null) continue;
      const part = heightfieldPart({ x: 0, z: 0, cellsX: field.cells, cellsZ: field.cells, heights: field.heights }, field.cellM);
      const id = `${this.prefix}floor:${c.cx},${c.cz}`;
      // The port reads the typed arrays element by element; the runtime's shape lists them as plain lists.
      const shape = { type: 'compound', parts: [part] } as unknown as ColliderShape3D;
      this.port.addStaticColliders!([{ entityId: id, shape, position: { x: c.cx * m, y: 0, z: c.cz * m }, rotation: IDENTITY }]);
      this.floors.set(key, { cx: c.cx, cz: c.cz, id, min: field.min });
      this.counters.added++;
    }
  }

  /** Whether a body at (x, y, z) (metres; y absent: anywhere in the column) stands over a floor now. */
  holds(x: number, z: number, y?: number): boolean {
    const f = this.floors.get(this.keyAt(x, z));
    return f !== undefined && (y === undefined || y >= f.min - FLOOR_BELOW_M);
  }

  /**
   * Where a body at (x, y, z) (metres, its origin at its feet) is to be lifted to: the fine ground's height where
   * its column's floor was handed over this step and the fine ground lies over the body; null otherwise.
   */
  riseAt(x: number, y: number, z: number): number | null {
    if (this.handed.size === 0 || !this.handed.has(this.keyAt(x, z))) return null;
    const floorPrefix = `${this.prefix}floor:`;
    const hit = this.port.raycast?.({ x, y: y + FLOOR_LIFT_M, z }, { x: 0, y: -1, z: 0 }, FLOOR_LIFT_M, { accept: (id) => id.startsWith(this.prefix) && !id.startsWith(floorPrefix) }) ?? null;
    if (hit === null) return null;
    const top = y + FLOOR_LIFT_M - hit.distance;
    if (top <= y + 0.01) return null;
    this.counters.lifted++;
    return top;
  }

  /** Every floor out of the port (the world unloads). */
  clear(): void {
    if (this.floors.size > 0) this.port.removeStaticColliders!([...this.floors.values()].map((f) => f.id));
    this.floors.clear();
    this.handed = new Set();
  }

  private keyAt(x: number, z: number): number {
    const sh = this.grid.shift;
    return columnKey(Math.floor(x / VOXEL_SIZE_M) >> sh, Math.floor(z / VOXEL_SIZE_M) >> sh);
  }
}
