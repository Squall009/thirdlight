/**
 * The voxel brush tool's rules probe: while the world edit mode's Rules
 * rail has the tool, the pointer reads the surface under it. The brush tool
 * owns the pointer, the pick and the grid; this part asks the view's worker
 * for the surface's fields at the cell picked (the same fields, by the same
 * kernel, a dressing rule is checked against where cover is made) and hands
 * them on. Nothing is written and nothing is kept.
 *
 * A click pins the read where it is, so the pointer can leave for the
 * column and its list; a click elsewhere pins there; Esc lets go.
 *
 * Browser-only.
 */
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

import { surfaceHeightCells } from '../session/voxel-brush';
import type { ScenePickHit, SceneSurfaceRead } from '../voxel-world/scene-voxels-wire';

/** What the probe reads at a point of a world's ground. */
export interface RulesProbeRead {
  readonly world: string;
  /** The cell picked (the world's lattice). */
  readonly cell: readonly [number, number, number];
  /** Where on the ground the read stands, metres: the picked cell's column middle, at the surface met. */
  readonly at: readonly [number, number, number];
  /** The surface under it and its fields (null: the view could not read it). */
  readonly read: SceneSurfaceRead | null;
  /** Held where it was clicked. */
  readonly pinned: boolean;
}

export interface RulesProbeHost {
  /** The surface under a cell of a world's own lattice, as the view holds its cells (absent, or null: the view reads none). */
  surface?(world: string, cell: readonly [number, number, number]): Promise<SceneSurfaceRead | null> | null;
  requestRender(): void;
}

/** Where a hit stands on the ground: its cell's column middle, at the height the surface cell's fill gives when met from above. */
export function probePointM(h: Pick<ScenePickHit, 'cell' | 'normal' | 'record'>): [number, number, number] {
  const y = h.normal[1] > 0 ? surfaceHeightCells(h.cell, h.record) : h.cell[1] + 1;
  return [(h.cell[0] + 0.5) * VOXEL_SIZE_M, y * VOXEL_SIZE_M, (h.cell[2] + 0.5) * VOXEL_SIZE_M];
}

export class VoxelRulesProbe {
  private shown: RulesProbeRead | null = null;
  private pinned = false;
  /** The cell asked last (a pointer resting on a cell asks once). */
  private asked = '';
  /** Counts the reads asked: an answer overtaken by a later one is dropped. */
  private seq = 0;

  constructor(private readonly host: RulesProbeHost, private readonly say: (read: RulesProbeRead | null) => void) {}

  /** What the column shows now (null: nothing under the pointer and nothing pinned). */
  current(): RulesProbeRead | null {
    return this.shown;
  }

  /** The pointer is over this hit of the armed world (null: over nothing of it): read there, unless a read is pinned. */
  hover(world: string, hit: ScenePickHit | null): void {
    if (this.pinned) return;
    if (hit === null) {
      if (this.shown !== null) this.set(null, '');
      return;
    }
    this.read(world, hit, false);
  }

  /** A click: the read is pinned at this hit. */
  press(world: string, hit: ScenePickHit): void {
    this.pinned = true;
    this.read(world, hit, true, true);
  }

  /** Esc: a pinned read let go (false: none was pinned). */
  cancel(): boolean {
    if (!this.pinned) return false;
    this.pinned = false;
    this.set(null, '');
    return true;
  }

  /** The rail was left: nothing shown, nothing pinned; a read in flight is dropped. */
  reset(): void {
    this.pinned = false;
    this.seq++;
    if (this.shown !== null || this.asked !== '') this.set(null, '');
  }

  private set(read: RulesProbeRead | null, key: string): void {
    this.shown = read;
    this.asked = key;
    this.say(read);
    this.host.requestRender();
  }

  private read(world: string, hit: ScenePickHit, pinned: boolean, again = false): void {
    const key = `${world}|${hit.cell.join(',')}|${hit.normal.join(',')}`;
    if (!again && key === this.asked) return;
    this.asked = key;
    const seq = ++this.seq;
    const at = probePointM(hit);
    const answer = this.host.surface?.(world, hit.cell) ?? null;
    const done = (read: SceneSurfaceRead | null): void => {
      // A later read, a pin or a reset overtook this one.
      if (seq !== this.seq) return;
      this.set({ world, cell: hit.cell, at, read, pinned }, key);
    };
    if (answer === null) done(null);
    else void answer.then(done, () => done(null));
  }
}
