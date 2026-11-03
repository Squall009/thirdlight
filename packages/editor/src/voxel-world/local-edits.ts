/**
 * The voxel world page's runtime-edit hooks: an edit applied to the page's
 * own store (a game's runtime edit: no backend round trip, nothing saved),
 * a blast that digs a sphere either that way or as a command and reports
 * whether its rebuilt sections swapped in one frame, the files read again
 * for what local edits changed, and the spot finders a measuring run uses.
 */
import { canonicalEditCommand, voxel, VOXEL_ROLE, VOXEL_SIZE_M, type ChunkDrawBatch, type ChunkGrid, type VoxelStreamer } from '@thirdlight/voxel';
import type { PendingEdits, SwapSeen } from './pending-edits';
import type { EditTiming } from './page';

/** How long an edit may take to show before it is reported as not shown. */
export const EDIT_VISIBLE_TIMEOUT_MS = 10_000;

type Cell = readonly [number, number, number];

/** When a coarser level's node or seam draw was last replaced: frames drawn before it, performance.now(), its batch and the batch's main-thread ms. */
export interface LevelDrawSet {
  readonly frame: number;
  readonly at: number;
  readonly batch: number;
  readonly ms: number;
}

/** A mip node result the streamer reported (drawn or not): its level, the frames drawn before it, performance.now(). */
export interface NodeEventSeen {
  readonly level: number;
  readonly frame: number;
  readonly at: number;
}

/**
 * When the coarser levels' node and seam draws were last replaced (keyed
 * "level:nx,ny,nz" and "seam level:nx,ny,nz:face") and the mip node results
 * the streamer reported lately, drawn or not: what an edit did beyond level 0.
 */
export class LevelDrawLog {
  readonly setAt = new Map<string, LevelDrawSet>();
  readonly nodes: NodeEventSeen[] = [];
  private batches = 0;

  /** A draw batch was applied after `frame` frames, costing `ms` on the main thread. */
  batch(b: ChunkDrawBatch, frame: number, ms: number): void {
    const set = { frame, at: performance.now(), batch: ++this.batches, ms };
    for (const c of b.chunks) if ((c.level ?? 0) > 0) this.setAt.set(`${c.level}:${c.cx},${c.cy},${c.cz}`, set);
    for (const sw of b.seams ?? []) this.setAt.set(`seam ${sw.level}:${sw.nx},${sw.ny},${sw.nz}:${sw.face}`, set);
  }

  /** A mip node's result came in after `frame` frames. */
  node(level: number, frame: number): void {
    this.nodes.push({ level, frame, at: performance.now() });
    if (this.nodes.length > 256) this.nodes.shift();
  }
}

/** A worker timing ring's samples since it was last cleared: count, sum, longest (µs). */
function ringSum(ring: { sorted(): Float64Array }): { n: number; sumUs: number; maxUs: number } {
  const s = ring.sorted();
  let sum = 0;
  for (const v of s) sum += v;
  return { n: s.length, sumUs: Math.round(sum), maxUs: Math.round(s.length === 0 ? 0 : s[s.length - 1]!) };
}

export interface LocalEditContext {
  readonly streamer: VoxelStreamer;
  readonly grid: ChunkGrid;
  readonly pending: PendingEdits;
  /** Open logs of the sections derived while an edit settles. */
  readonly derivedLogs: Set<Set<string>>;
  /** The frame and swap at which each storage chunk's body was last replaced. */
  readonly bodySetAt: ReadonlyMap<number, { frame: number; swap: number }>;
  /** The same for each storage chunk's draw. */
  readonly chunkSetAt: ReadonlyMap<number, { frame: number; swap: number }>;
  /** The coarser levels' draws replaced and mip node results reported. */
  readonly levelLog: LevelDrawLog;
  /** Every resident chunk. */
  readonly resident: ReadonlyMap<number, { cx: number; cy: number; cz: number }>;
  /** What a swapped edit cost once the frame showing it is drawn. */
  shown(t0: number, startFrame: number, seen: SwapSeen): Promise<EditTiming>;
  /** Sends a stroke command through the backend. */
  edit(command: unknown): Promise<EditTiming>;
  frameStats(): { frames: number; missed: number; longestMs: number };
  resetLongest(): void;
}

export function localEditHooks(ctx: LocalEditContext): Record<string, (...args: never[]) => unknown> {
  const { streamer, pending } = ctx;
  const v = voxel();
  /** Whether local edits were made since the page last went back to the files. */
  let localEdited = false;

  /**
   * A game's runtime edit: applied to the streamer's overlay at once (no
   * backend, nothing saved) at the start of the next frame, the rebuilt
   * sections swapped in together. Returns the timing and, read right after
   * the apply in the same task, whether `probe` (a cell the edit changes)
   * already reads as changed.
   */
  async function localEdit(command: unknown, probe?: Cell): Promise<EditTiming & { applyMs: number; readAtOnce?: { material: number } }> {
    const log = new Set<string>();
    ctx.derivedLogs.add(log);
    try {
      // Applied at the start of a frame, right after it is drawn, as a game's update applies it: the soonest a
      // rebuild can show is the next frame.
      await new Promise<void>((ok) => requestAnimationFrame(() => ok()));
      const t0 = performance.now();
      const startFrame = ctx.frameStats().frames;
      const canonical = canonicalEditCommand(command);
      const outcome = streamer.edit(canonical);
      localEdited = true;
      const applyMs = performance.now() - t0;
      let readAtOnce: { material: number } | undefined;
      if (probe !== undefined) {
        streamer.voxelAt(probe[0], probe[1], probe[2], v);
        readAtOnce = { material: v.material };
      }
      const seen = await pending.wait(outcome.group, EDIT_VISIBLE_TIMEOUT_MS);
      if (seen === null) return { ok: false, code: 'not_visible', applyMs };
      const timing = await ctx.shown(t0, startFrame, seen);
      return { ...timing, cells: outcome.cells, chunks: outcome.chunks.length, rederived: [...log].sort(), applyMs, ...(readAtOnce === undefined ? {} : { readAtOnce }) };
    } finally {
      ctx.derivedLogs.delete(log);
    }
  }

  /** The level drawn where a cell lies (null: none, or no levels). */
  function levelDrawnAt(c: Cell): number | null {
    const mips = streamer.mips;
    if (mips === null) return null;
    const k = c.map((x) => Math.floor(x / ctx.grid.edge));
    for (let l = 0; l <= mips.maxLevel; l++) if (mips.lod.drawn.drawn(l, k[0]! >> l, k[1]! >> l, k[2]! >> l)) return l;
    return null;
  }

  /**
   * What an edit did to the coarser levels: the mip node results derived
   * again after it (drawn or not: its ancestors) and the node and seam
   * draws replaced, each as frames from the edit to the first frame
   * showing it (1: the next frame), and the batches' main-thread ms.
   */
  function levelReport(before: ReadonlyMap<string, LevelDrawSet>, last: NodeEventSeen | null, timing: { startFrame?: number; startedAt?: number }, drawnLevel: number | null): Record<string, unknown> {
    const f0 = timing.startFrame ?? 0;
    const t0 = timing.startedAt ?? 0;
    const i0 = last === null ? 0 : ctx.levelLog.nodes.lastIndexOf(last) + 1;
    const events = ctx.levelLog.nodes.slice(i0).filter((e) => e.at >= t0);
    const nodes: Record<number, { n: number; frames: number[]; ms: number }> = {};
    for (const e of events) {
      const r = (nodes[e.level] ??= { n: 0, frames: [], ms: 0 });
      r.n++;
      if (!r.frames.includes(e.frame - f0 + 1)) r.frames.push(e.frame - f0 + 1);
      r.ms = Math.max(r.ms, Number((e.at - t0).toFixed(1)));
    }
    const drawn = { nodes: 0, seams: 0, frames: [] as number[], batches: [] as number[], ms: 0, mainMs: 0, byFrame: {} as Record<number, string[]> };
    const batchMs = new Map<number, number>();
    for (const [key, set] of ctx.levelLog.setAt) {
      if (before.get(key) === set) continue;
      if (key.startsWith('seam ')) drawn.seams++;
      else drawn.nodes++;
      if (!drawn.frames.includes(set.frame - f0 + 1)) drawn.frames.push(set.frame - f0 + 1);
      (drawn.byFrame[set.frame - f0 + 1] ??= []).push(key);
      if (!drawn.batches.includes(set.batch)) drawn.batches.push(set.batch);
      batchMs.set(set.batch, set.ms);
      drawn.ms = Math.max(drawn.ms, Number((set.at - t0).toFixed(1)));
    }
    for (const ms of batchMs.values()) drawn.mainMs += ms;
    drawn.mainMs = Number(drawn.mainMs.toFixed(2));
    drawn.frames.sort((a, b) => a - b);
    return { drawnLevel, derived: nodes, drawn };
  }

  return {
    localEdit,
    /** The level drawn where a cell lies (null: none drawn there, or no levels). */
    levelAt: (x: number, y: number, z: number): number | null => levelDrawnAt([x, y, z]),
    /**
     * Digs a sphere of `radiusM` metres at a cell, through the backend
     * (`command`) or locally (`local`), and reports the swap: the frame
     * each storage chunk's body and draw were replaced in (one frame for
     * all: no partial blast is ever drawn or collided with), and the frames
     * from the edit to the first frame showing it.
     */
    async blast(centre: Cell, radiusM: number, how: 'local' | 'command'): Promise<Record<string, unknown>> {
      const r = Math.max(1, Math.round(radiusM / VOXEL_SIZE_M));
      const command = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [r, r, r], points: [...centre], mode: 'dig', smooth: false };
      const before = new Map(ctx.bodySetAt);
      const chunksBefore = new Map(ctx.chunkSetAt);
      const levelsBefore = new Map(ctx.levelLog.setAt);
      const nodeEvents0 = ctx.levelLog.nodes.length === 0 ? null : ctx.levelLog.nodes[ctx.levelLog.nodes.length - 1]!;
      const mips = streamer.mips;
      const level = levelDrawnAt(centre);
      mips?.downsampleUs.clear();
      mips?.deriveUs.clear();
      mips?.seams.seamUs.clear();
      const missed0 = ctx.frameStats().missed;
      ctx.resetLongest();
      const timing = how === 'local' ? await localEdit(command, centre) : await ctx.edit(command);
      // A batch is applied in the task announcing it; one more frame and every draw the settle let through is in.
      await new Promise<void>((ok) => requestAnimationFrame(() => ok()));
      const replaced: Array<{ frame: number; swap: number }> = [];
      for (const [key, at] of ctx.bodySetAt) if (before.get(key) !== at) replaced.push(at);
      const bodyCount = replaced.length;
      for (const [key, at] of ctx.chunkSetAt) if (chunksBefore.get(key) !== at) replaced.push(at);
      const now = ctx.frameStats();
      const levels = levelReport(levelsBefore, nodeEvents0, timing, level);
      const worker = mips === null ? null : { downsample: ringSum(mips.downsampleUs), derive: ringSum(mips.deriveUs), seams: ringSum(mips.seams.seamUs) };
      return { ...timing, replacedBodies: bodyCount, replacedChunks: replaced.length - bodyCount, replacedFrames: [...new Set(replaced.map((a) => a.frame))], replacedSwaps: [...new Set(replaced.map((a) => a.swap))], missedDuring: now.missed - missed0, longestFrameMs: Number(now.longestMs.toFixed(2)), levels, mipWorker: worker };
    },
    /**
     * Back to the files: drops the local edits (they live in the streamer's
     * overlay, the files never had them) and, with none, reads every
     * resident chunk from the files again; waits until it is all derived again.
     */
    async reread(): Promise<void> {
      const group = localEdited ? streamer.clearOverlay() : streamer.refresh([...ctx.resident.values()]);
      localEdited = false;
      await pending.wait(group, 60_000);
      await streamer.settle();
    },
    /** The cell above the highest non-air cell of a column, searched down from `top` (null: none above `bottom`). */
    surfaceAt(x: number, z: number, top: number, bottom: number): number | null {
      for (let y = top; y >= bottom; y--) {
        streamer.voxelAt(x, y, z, v);
        if (v.material !== 0) return y + 1;
      }
      return null;
    },
    /** Cells in a box by role (inclusive bounds): how much of a spot is air, terrain or built. */
    roleCounts(min: Cell, max: Cell): Record<string, number> {
      const out: Record<string, number> = { air: 0, terrain: 0, built: 0 };
      for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) {
        streamer.voxelAt(x, y, z, v);
        const k = v.material === 0 ? 'air' : v.role === VOXEL_ROLE.terrain ? 'terrain' : 'built';
        out[k]! += 1;
      }
      return out;
    },
  };
}
