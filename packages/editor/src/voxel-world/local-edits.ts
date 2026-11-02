/**
 * The voxel world page's runtime-edit hooks: an edit applied to the page's
 * own store (a game's runtime edit: no backend round trip, nothing saved),
 * a blast that digs a sphere either that way or as a command and reports
 * whether its rebuilt sections swapped in one frame, the files read again
 * for what local edits changed, and the spot finders a measuring run uses.
 */
import { canonicalEditCommand, voxel, VOXEL_ROLE, VOXEL_SIZE_M, type ChunkGrid, type VoxelStreamer } from '@thirdlight/voxel';
import type { PendingEdits, SwapSeen } from './pending-edits';
import type { EditTiming } from './page';

/** How long an edit may take to show before it is reported as not shown. */
export const EDIT_VISIBLE_TIMEOUT_MS = 10_000;

type Cell = readonly [number, number, number];

export interface LocalEditContext {
  readonly streamer: VoxelStreamer;
  readonly grid: ChunkGrid;
  readonly pending: PendingEdits;
  /** Open logs of the sections derived while an edit settles. */
  readonly derivedLogs: Set<Set<string>>;
  /** The frame and swap at which each section's meshes and body were last replaced. */
  readonly setAt: ReadonlyMap<number, { frame: number; swap: number }>;
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

  return {
    localEdit,
    /**
     * Digs a sphere of `radiusM` metres at a cell, through the backend
     * (`command`) or locally (`local`), and reports the swap: sections
     * derived again, the frame each one's meshes and body were replaced in
     * (one frame for all: no partial blast is ever drawn), and the frames
     * from the edit to the first frame showing it.
     */
    async blast(centre: Cell, radiusM: number, how: 'local' | 'command'): Promise<Record<string, unknown>> {
      const r = Math.max(1, Math.round(radiusM / VOXEL_SIZE_M));
      const command = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [r, r, r], points: [...centre], mode: 'dig', smooth: false };
      const before = new Map(ctx.setAt);
      const missed0 = ctx.frameStats().missed;
      ctx.resetLongest();
      const timing = how === 'local' ? await localEdit(command, centre) : await ctx.edit(command);
      const replaced: Array<{ frame: number; swap: number }> = [];
      for (const [key, at] of ctx.setAt) if (before.get(key) !== at) replaced.push(at);
      const now = ctx.frameStats();
      return { ...timing, replacedSections: replaced.length, replacedFrames: [...new Set(replaced.map((a) => a.frame))], replacedSwaps: [...new Set(replaced.map((a) => a.swap))], missedDuring: now.missed - missed0, longestFrameMs: Number(now.longestMs.toFixed(2)) };
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
