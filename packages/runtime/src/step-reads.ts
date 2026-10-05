/**
 * Reading the drawn state: every entity's transform between the last two
 * finished steps (the runtime's interpolation alpha), the last step itself,
 * or both steps for a presenter that blends them by its own clock. The
 * runtime hands in its step maps; nothing here writes simulation state.
 */
import { interpolateTransformInto } from './interp';
import type { InterpolatedTransform, InterpolatedVisitor, StepPairVisitor } from './types';
import type { TransformState } from './types-simulation';

/** The two steps a draw reads and where it falls between them. */
export interface DrawnSteps {
  readonly order: readonly string[];
  readonly prev: ReadonlyMap<string, TransformState>;
  readonly curr: ReadonlyMap<string, TransformState>;
  readonly alpha: number;
}

/** Reused arrays for the reads (copy them; they change at the next entity). */
export class StepReads {
  private readonly position: number[] = [0, 0, 0];
  private readonly rotation: number[] = [0, 0, 0, 1];
  private readonly scale: number[] = [1, 1, 1];

  /** One entity into the reused arrays; false when it is not in both steps. */
  private interpolate(s: DrawnSteps, id: string): boolean {
    const p = s.prev.get(id);
    const c = s.curr.get(id);
    if (!p || !c) return false;
    interpolateTransformInto(this.position, this.rotation, this.scale, p, c, s.alpha);
    return true;
  }

  /** Every entity's drawn transform as fresh objects (draw order). */
  transforms(s: DrawnSteps): InterpolatedTransform[] {
    const out: InterpolatedTransform[] = [];
    for (const id of s.order) {
      if (!this.interpolate(s, id)) continue;
      const p = this.position;
      const r = this.rotation;
      const k = this.scale;
      out.push({ id, position: [p[0]!, p[1]!, p[2]!], rotation: [r[0]!, r[1]!, r[2]!, r[3]!], scale: [k[0]!, k[1]!, k[2]!] });
    }
    return out;
  }

  /** Every entity's drawn transform handed to `visit` in the reused arrays (no objects per frame). */
  forEach(s: DrawnSteps, visit: InterpolatedVisitor): void {
    const order = s.order;
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i]!;
      if (this.interpolate(s, id)) visit(id, this.position, this.rotation, this.scale);
    }
  }

  /** Every entity's two steps (draw order). */
  forEachPair(s: DrawnSteps, visit: StepPairVisitor): void {
    const order = s.order;
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i]!;
      const p = s.prev.get(id);
      const c = s.curr.get(id);
      if (p && c) visit(id, p, c);
    }
  }

  /** One entity's drawn transform into the caller's arrays; false when it is unknown. */
  read(s: DrawnSteps, id: string, position: number[], rotation: number[], scale: number[]): boolean {
    if (!this.interpolate(s, id)) return false;
    for (let k = 0; k < 3; k += 1) position[k] = this.position[k]!;
    for (let k = 0; k < 4; k += 1) rotation[k] = this.rotation[k]!;
    for (let k = 0; k < 3; k += 1) scale[k] = this.scale[k]!;
    return true;
  }
}
