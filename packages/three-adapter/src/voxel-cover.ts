/**
 * Ground cover on voxel worlds, where it is drawn: the voxel source of the
 * point-set cover path. It adds no draw path of its own. Each cover species
 * a world grows is one point source of `CoverGpu` (cover-gpu.ts), the path
 * block layers', models' and architecture's cover take: its chunk columns'
 * point sets are stored in the rule's point atlas (cover-points-gpu.ts) and
 * drawn as rows of the scene's culled-instance table (cover-rows.ts,
 * copy-rows.ts), which picks each point's level, thins it by its threshold
 * against the cover's share across the ground and culls it; the models'
 * materials read the wind map and the interaction field as any cover's do.
 *
 * What differs from the other point sources is only where the sets come
 * from: they are made where the world runs (`@thirdlight/voxel`
 * cover-stream.ts, a job a chunk column in its worker pool) and arrive with
 * the chunk draw batches, so this module holds what arrived and answers the
 * path when it asks for a column's set. A column's cover arrives after its
 * chunks' draws and goes in the batch that removes the last of them.
 *
 * **Its budget a tier** is two entries of the shared tables. Time: the sets
 * that arrived are handed to the path within the frame arbiter's
 * `voxelCover` slice a frame, the rest the next frames. Memory: the points
 * held are weighed against the memory budget table's `voxelCover` entry
 * ({@link VOXEL_COVER_POINT_BYTES} a point); past it every column hands over
 * only the share of its points with the lowest thresholds (the sets are
 * sorted by threshold), so the cover thins evenly and never ends at a place.
 *
 * Nothing here is stored; a world's cover goes when its draws close.
 */
import { frameSliceMs, residentBytes } from '@thirdlight/shared';
import { COVER_POINT_FLOATS, VOXEL_COVER_POINT_BYTES, type CoverPointSet, type ScatterRule, type VoxelCoverSet } from '@thirdlight/project-model';
import { VOXEL_SIZE_M, type ChunkCoverWire } from '@thirdlight/voxel';

/** What the voxel source uses of the point-set cover path (`CoverGpu`). */
export interface PointCoverPath {
  setPoints(id: string, rules: readonly ScatterRule[], origin: readonly number[], chunk: readonly [number, number], chunks: ReadonlySet<string>): void;
  invalidatePoints(id: string, rect: readonly [number, number, number, number] | null): void;
  dropPoints(id: string, cx: number, cz: number): void;
  remove(id: string): void;
}

/** The prefix of the point sources voxel worlds' species are (no object id starts with it). */
export const VOXEL_COVER_SOURCE = 'voxel-cover|';

/** Steps the kept share moves in when the points held pass the budget (a share that followed every arrival would rewrite every row each time). */
const SHARE_STEPS = 16;

/** One species of a world: a point source of the path. */
interface Species {
  readonly id: string;
  readonly world: string;
  rule: ScatterRule;
  ruleKey: string;
  side: number;
  /** Its sets by chunk column ("cx,cz"), and the columns as the path is told of them. */
  readonly sets: Map<string, CoverPointSet>;
  readonly columns: Set<string>;
}

export interface VoxelCoverStats {
  /** Worlds with cover, species (point sources), chunk column sets held and their points. */
  readonly worlds: number;
  readonly species: number;
  readonly sets: number;
  readonly points: number;
  /** Bytes the points are counted as against the budget, the budget, and the share of each set handed to the path. */
  readonly bytes: number;
  readonly budgetBytes: number;
  readonly share: number;
  /** Sets asked for by the path and not handed over yet. */
  readonly pending: number;
  /** Cover entries received (columns made or changed), and columns let go. */
  readonly received: number;
  readonly dropped: number;
}

/** The first `count` points of a set (it is sorted by threshold: the points kept longest as cover thins). */
function prefixOf(set: CoverPointSet, count: number): CoverPointSet {
  if (count >= set.count) return set;
  return { ...set, count, data: set.data.subarray(0, count * COVER_POINT_FLOATS) };
}

export class VoxelCover {
  private readonly species = new Map<string, Species>();
  /** Per world: per chunk column, the species ids that hold a set there. */
  private readonly worlds = new Map<string, Map<string, string[]>>();
  private readonly asks: { id: string; cx: number; cz: number; reply: (set: CoverPointSet | null) => void }[] = [];
  private points = 0;
  private budget = Infinity;
  private share = 1;
  private received = 0;
  private dropped = 0;
  private readonly unregister: () => void;

  constructor(private readonly path: PointCoverPath) {
    this.unregister = residentBytes.register('voxelCover', () => this.points * VOXEL_COVER_POINT_BYTES);
  }

  /** Whether a point source of the path is a voxel world's species (its sets are answered here). */
  owns(id: string): boolean {
    return id.startsWith(VOXEL_COVER_SOURCE);
  }

  /**
   * The memory the points may take from now on (the tier's `voxelCover` entry of the memory budget table): past it
   * each set hands over a share of its points.
   */
  setBudget(bytes: number): void {
    if (bytes === this.budget) return;
    this.budget = bytes;
    this.weigh();
  }

  /** The share of each set handed to the path for the points held now; when it moves a step every set is handed over again. */
  private weigh(): void {
    const need = this.points * VOXEL_COVER_POINT_BYTES;
    const share = need <= this.budget ? 1 : Math.max(1, Math.floor((this.budget / need) * SHARE_STEPS)) / SHARE_STEPS;
    if (share === this.share) return;
    this.share = share;
    for (const s of this.species.values()) this.path.invalidatePoints(s.id, null);
  }

  /** A batch's cover of world `world` (chunks of `edge` cells): each column's sets replace what it held. */
  receive(world: string, edge: number, entries: readonly ChunkCoverWire[]): void {
    const side = edge * VOXEL_SIZE_M;
    let columns = this.worlds.get(world);
    if (columns === undefined) this.worlds.set(world, (columns = new Map()));
    for (const e of entries) {
      const key = `${e.cx},${e.cz}`;
      const sets = (e.sets ?? []) as readonly VoxelCoverSet[];
      const now = new Map(sets.map((s) => [`${VOXEL_COVER_SOURCE}${world}|${s.dressing}|${s.species}`, s]));
      for (const id of columns.get(key) ?? []) if (!now.has(id)) this.take(this.species.get(id)!, key, e.cx, e.cz);
      for (const [id, s] of now) this.put(id, world, side, key, e.cx, e.cz, s);
      if (now.size > 0) {
        columns.set(key, [...now.keys()]);
        this.received++;
      } else if (columns.delete(key)) this.dropped++;
    }
    if (columns.size === 0) this.worlds.delete(world);
    this.weigh();
  }

  /** A species' set over a column arrived (again): held, and the path asks for it once it reaches the column. */
  private put(id: string, world: string, side: number, key: string, cx: number, cz: number, s: VoxelCoverSet): void {
    // The species' own id is its place in its dressing's list: the path keys its draws by the source and rule.
    const rule: ScatterRule = { ...s.rule, id };
    const ruleKey = JSON.stringify(rule);
    let sp = this.species.get(id);
    if (sp === undefined) this.species.set(id, (sp = { id, world, rule, ruleKey, side, sets: new Map(), columns: new Set() }));
    const fresh = !sp.columns.has(key);
    this.points += s.points.count - (sp.sets.get(key)?.count ?? 0);
    sp.sets.set(key, s.points);
    sp.columns.add(key);
    if (fresh || sp.ruleKey !== ruleKey || sp.side !== side) {
      // A rule that reads differently (its dressing was edited) is another source to the path: its draws are made again.
      sp.rule = rule;
      sp.ruleKey = ruleKey;
      sp.side = side;
      this.path.setPoints(id, [rule], [0, 0, 0], [side, side], sp.columns);
    }
    this.path.invalidatePoints(id, [cx * side, cz * side, (cx + 1) * side, (cz + 1) * side]);
  }

  /** A species no longer grows on a column: its set goes, and the species with its last. */
  private take(sp: Species, key: string, cx: number, cz: number): void {
    const had = sp.sets.get(key);
    if (had === undefined) return;
    this.points -= had.count;
    sp.sets.delete(key);
    sp.columns.delete(key);
    if (sp.sets.size === 0) {
      this.species.delete(sp.id);
      this.path.remove(sp.id);
      return;
    }
    this.path.dropPoints(sp.id, cx, cz);
  }

  /** The path asks for a source's set over a column: answered in {@link frame}, within the frame's slice. */
  ask(id: string, cx: number, cz: number, reply: (set: CoverPointSet | null) => void): void {
    this.asks.push({ id, cx, cz, reply });
  }

  /** Once a frame: the sets asked for are handed to the path while the frame arbiter's slice lasts (at least one). */
  frame(): void {
    if (this.asks.length === 0) return;
    const t0 = performance.now();
    const ms = frameSliceMs('voxelCover');
    let n = 0;
    while (n < this.asks.length && (n === 0 || performance.now() - t0 < ms)) {
      const a = this.asks[n++]!;
      const set = this.species.get(a.id)?.sets.get(`${a.cx},${a.cz}`) ?? null;
      a.reply(set === null ? null : prefixOf(set, Math.ceil(set.count * this.share)));
    }
    this.asks.splice(0, n);
  }

  /** A world's draws closed: every species of it goes. */
  close(world: string): void {
    if (!this.worlds.delete(world)) return;
    for (const sp of [...this.species.values()]) {
      if (sp.world !== world) continue;
      for (const set of sp.sets.values()) this.points -= set.count;
      this.species.delete(sp.id);
      this.path.remove(sp.id);
    }
    this.weigh();
  }

  stats(): VoxelCoverStats {
    let sets = 0;
    for (const s of this.species.values()) sets += s.sets.size;
    return { worlds: this.worlds.size, species: this.species.size, sets, points: this.points, bytes: this.points * VOXEL_COVER_POINT_BYTES, budgetBytes: this.budget, share: this.share, pending: this.asks.length, received: this.received, dropped: this.dropped };
  }

  dispose(): void {
    for (const world of [...this.worlds.keys()]) this.close(world);
    this.asks.length = 0;
    this.unregister();
  }
}
