/**
 * How wide the voxel surface's material blend is round a point: written once
 * over the projection's scalar interface (`voxel-surface-projection.ts`), so
 * the program builds it from shader nodes and the tests run it on numbers.
 *
 * Each material may set its own blend distance (`voxel.blendMetres`, the
 * material table's third block); one that sets none takes the world's
 * (`voxelWorld.blendMetres`, a uniform). Where materials meet the smallest
 * wins: of the eight cells round a point, the narrowest blend any solid one
 * asks for. A crisp material (cut stone beside grass) then keeps its edge
 * against a soft one, from both sides of the seam alike, since both sides
 * read the same eight cells. Air asks for nothing. Shader data only: a
 * changed distance re-uploads the table or sets the uniform, never a mesh.
 */
import type { ProjectionOps } from './voxel-surface-projection';

/** A cell round the point: its material's own blend metres (negative: none set) and whether it is solid. */
export interface BlendCell<F, B> {
  readonly own: F;
  readonly solid: B;
}

/** Above any blend a material may ask for: the start of the search for the narrowest. */
const NONE_ASKED = 1e9;

/** The blend metres at a point: the smallest any solid cell's material asks for (its own, else `worldM`); `worldM` with none solid. */
export function seamBlendMetres<F, B>(o: ProjectionOps<F, B>, cells: readonly BlendCell<F, B>[], worldM: F): F {
  const hold = (v: F): F => (o.hold === undefined ? v : o.hold(v));
  let narrowest = o.num(NONE_ASKED);
  for (const c of cells) {
    const asked = hold(o.pick(o.less(c.own, o.num(0)), worldM, c.own));
    // Air asks for nothing: it keeps what the solid cells asked.
    narrowest = hold(o.pick(c.solid, o.pick(o.less(asked, narrowest), asked, narrowest), narrowest));
  }
  return o.pick(o.less(narrowest, o.num(NONE_ASKED / 2)), narrowest, worldM);
}
