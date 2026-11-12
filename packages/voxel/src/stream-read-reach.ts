/**
 * How far a streamer reads its voxels round the focus: the load ring as a
 * scene sets it, ended at the detail ring's reach where the world's fine far
 * levels are baked down to the level drawn past the detail ring (nothing
 * past the detail ring and the collision ring reads a voxel there), and
 * where a bake is still under way the ring as set. Looked at again as the
 * focus moves into another chunk.
 */
import type { ChunkGrid } from './coords';
import type { FarNodeSource } from './far-field';
import { readRing, type Focus, type StreamRing } from './stream-ring';

/** What the read reach takes from its streamer. */
export interface StreamReadReachHost {
  readonly grid: ChunkGrid;
  /** The far cache the far field reads (null: no far field). */
  far(): FarNodeSource | null;
  /** The detail ring's reach in cells (null: no level rings). */
  detailReach(): number | null;
  focus(): Focus;
  /** The ring read now changed (a narrower one applies at the next update, a wider one once the speed allows). */
  setBase(ring: StreamRing): void;
}

export class StreamReadReach {
  /** The load ring as set. */
  private scene: StreamRing;
  /** Cells the voxels are read to round the focus (null: the ring as set). */
  private reach: number | null = null;
  /** The fine far level baked past the detail ring the reach follows (null: none). */
  private baked: number | null = null;

  constructor(
    private readonly host: StreamReadReachHost,
    ring: StreamRing,
  ) {
    this.scene = ring;
  }

  /** The load ring as set. */
  get sceneRing(): StreamRing {
    return this.scene;
  }

  /** Cells the voxels are read to now (null: the ring as set). */
  get cells(): number | null {
    return this.reach;
  }

  /** A new load ring as set: the ring read is it, ended at the reach. */
  ringSet(ring: StreamRing): StreamRing {
    this.scene = ring;
    return readRing(ring, this.reach);
  }

  /** The fine far level baked past the detail ring (null: none): where every column of it within the ring as set round the focus is baked, the reach ends the ring. */
  setBaked(level: number | null): void {
    this.baked = level;
    this.check();
  }

  /** The focus entered another chunk. */
  moved(): void {
    if (this.baked !== null) this.check();
  }

  private check(): void {
    const far = this.host.far();
    const level = this.baked;
    const detail = this.host.detailReach();
    if (far === null || level === null || detail === null || far.fineBaked === undefined) return this.set(null);
    const g = this.host.grid;
    const f = this.host.focus();
    const r = this.scene.loadRadius;
    const x0 = Math.floor((f.x - r) / g.edge), x1 = Math.floor((f.x + r) / g.edge);
    const z0 = Math.floor((f.z - r) / g.edge), z1 = Math.floor((f.z + r) / g.edge);
    const seen = new Set<string>();
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const n = { level, nx: cx >> level, ny: 0, nz: cz >> level };
      const k = `${n.nx},${n.nz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!far.fineBaked(n)) return this.set(null);
    }
    this.set(detail);
  }

  private set(cells: number | null): void {
    if (cells === this.reach) return;
    this.reach = cells;
    this.host.setBase(readRing(this.scene, cells));
  }
}
