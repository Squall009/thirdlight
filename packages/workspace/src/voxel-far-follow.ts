/**
 * A world's far cache follows its edits and structure commands after they
 * are answered: the world chunks a command changed (an edit's, or those a
 * structure left and entered) are gathered here and built again in one
 * rebuild once no more came for {@link FAR_FOLLOW_SETTLE_MS}, so a command
 * answers when its voxels and scene are written, and a drag of moves is
 * one rebuild of where it ends.
 *
 * The rebuild runs in the world's queue like any write of it. Whatever asks
 * for the far cache (its route, an export) runs what is gathered first
 * ({@link FarFollow.settle}), so nothing reads a cache a command has made
 * stale. What the far cache records stays its world's revision: an edit
 * gathered here and lost with the process (a restart before the rebuild)
 * leaves the cache at an older revision than the world's, and the next read
 * builds it again whole; a structure moved, made or deleted changes no
 * revision, so a rebuild lost with the process leaves its old place in the
 * far field until that area is built again (a cache that proves its
 * placements would need a stored field).
 */
import { FAR_FOLLOW_SETTLE_MS, type ChunkCoord } from '@thirdlight/voxel';

/** What a rebuild of gathered chunks answered (the far answer of an applied command, or null: no far cache). */
export type FarFollowResult<R> = R | null;

interface Gathered<R> {
  /** The world revision the far cache had when the first change was gathered. */
  readonly before: number;
  readonly chunks: Map<string, ChunkCoord>;
  /** Commands gathered into it. */
  commands: number;
  timer: ReturnType<typeof setTimeout> | null;
  readonly done: Promise<FarFollowResult<R>>;
  resolve(r: FarFollowResult<R>): void;
}

export class FarFollow<R> {
  private readonly gathered = new Map<string, Gathered<R>>();
  /** Rebuilds under way, by world. */
  private readonly running = new Map<string, Promise<FarFollowResult<R>>>();
  /** The last rebuild's answer and how many commands it held, by world (diagnostics, the far route). */
  readonly last = new Map<string, { readonly result: FarFollowResult<R>; readonly commands: number; readonly chunks: number; readonly at: number }>();

  constructor(
    /** Runs a rebuild of `chunks` for world `key` whose far cache had revision `before` when they were gathered. */
    private readonly rebuild: (key: string, before: number, chunks: ChunkCoord[]) => Promise<FarFollowResult<R>>,
    private readonly settleMs = FAR_FOLLOW_SETTLE_MS,
  ) {}

  /** The revision the far cache had when the world's gathered changes began (undefined: none gathered). */
  before(key: string): number | undefined {
    return this.gathered.get(key)?.before;
  }

  /** Gathers a command's chunks (`before`: the far cache's revision if none are gathered yet); answers how many wait. */
  add(key: string, before: number, chunks: Iterable<ChunkCoord>): number {
    let g = this.gathered.get(key);
    if (g === undefined) {
      let resolve!: (r: FarFollowResult<R>) => void;
      const done = new Promise<FarFollowResult<R>>((ok) => (resolve = ok));
      this.gathered.set(key, (g = { before, chunks: new Map(), commands: 0, timer: null, done, resolve }));
    }
    for (const c of chunks) g.chunks.set(`${c.cx},${c.cy},${c.cz}`, c);
    g.commands++;
    if (g.timer !== null) clearTimeout(g.timer);
    const held = g;
    held.timer = setTimeout(() => void this.start(key, held), this.settleMs);
    return g.chunks.size;
  }

  /** Builds what the world has gathered now and resolves once it and any rebuild under way landed (null: nothing waited). */
  async settle(key: string): Promise<FarFollowResult<R>> {
    const g = this.gathered.get(key);
    const r = g !== undefined ? await this.start(key, g) : ((await this.running.get(key)) ?? null);
    return r;
  }

  /** Whether changes of the world are gathered or being built. */
  pending(key: string): boolean {
    return this.gathered.has(key) || this.running.has(key);
  }

  /** The world closed or was read again: what it gathered is dropped (its far cache is checked against its revision when next read). */
  drop(key: string): void {
    const g = this.gathered.get(key);
    if (g === undefined) return;
    if (g.timer !== null) clearTimeout(g.timer);
    this.gathered.delete(key);
    g.resolve(null);
  }

  private start(key: string, g: Gathered<R>): Promise<FarFollowResult<R>> {
    if (this.gathered.get(key) !== g) return g.done;
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
    this.gathered.delete(key);
    const run = this.rebuild(key, g.before, [...g.chunks.values()]).then(
      (r) => {
        this.last.set(key, { result: r, commands: g.commands, chunks: g.chunks.size, at: Date.now() });
        return r;
      },
      () => null,
    );
    this.running.set(key, run);
    void run.then((r) => {
      if (this.running.get(key) === run) this.running.delete(key);
      g.resolve(r);
    });
    return g.done;
  }
}
