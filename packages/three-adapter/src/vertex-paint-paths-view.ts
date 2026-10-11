/**
 * Path paint read for the generated meshes that draw it (architecture-view.ts,
 * spline-view.ts): an object's `vertexPaint.paths` grids read by digest and
 * turned into the sources `samplePathPaint` reads (project-model
 * `vertex-paint-paths.ts`), and the `tlPaint` attribute of a generated mesh.
 *
 * The paint is sampled onto the vertices on the page whenever a mesh is
 * drawn (a chunk made on a worker, read from the store or shipped), so the
 * made meshes and their cache keys stay the generator's: painting a wall
 * never makes it again. Only painted objects pay for it.
 */
import * as THREE from 'three';
import { pathPaintFrame, samplePathPaint, VERTEX_PAINT_BYTES, type ArchitectureComponent, type PathGrid, type PathPaintGrid, type PathPaintSide, type PathPaintSource, type SplineComponent } from '@thirdlight/runtime';

/** What paths an object's paint names: its architecture's and its spline. */
export interface PathPaintOwner {
  readonly architecture?: Pick<ArchitectureComponent, 'outlines' | 'buildings' | 'elements'>;
  readonly spline?: SplineComponent;
}

/** What an object's paint is, by its grids (one string: a change of any grid is a new one; '' without paint). */
export function pathPaintSignature(grids: readonly PathPaintGrid[] | undefined): string {
  return grids === undefined ? '' : grids.map((g) => `${g.path}|${g.side}|${g.origin.join(',')}|${g.size.join(',')}|${g.paint}`).join(';');
}

export class PathPaintReader {
  private readonly bytes = new Map<string, Uint8Array | null>();
  private readonly reading = new Map<string, Promise<void>>();

  constructor(private readonly read: ((digest: string) => Promise<ArrayBuffer>) | null) {}

  /**
   * The sources of an object's paint (null: none drawn — no grids, or none
   * could be read), or 'pending' while its grids are read (`onReady` once all
   * are, read or failed).
   */
  sources(owner: PathPaintOwner, grids: readonly PathPaintGrid[] | undefined, onReady: () => void): readonly PathPaintSource[] | null | 'pending' {
    if (grids === undefined || grids.length === 0) return null;
    const missing = grids.filter((g) => !this.bytes.has(g.paint));
    if (missing.length > 0) {
      if (this.read === null) return null;
      void Promise.all(missing.map((g) => this.load(g.paint))).then(onReady);
      return 'pending';
    }
    const byPath = new Map<string, Partial<Record<PathPaintSide, PathGrid>>>();
    for (const g of grids) {
      const values = this.bytes.get(g.paint);
      if (values === null || values === undefined || values.length !== g.size[0] * g.size[1] * VERTEX_PAINT_BYTES) continue;
      let sides = byPath.get(g.path);
      if (sides === undefined) byPath.set(g.path, (sides = {}));
      sides[g.side] = { origin: g.origin, size: g.size, values };
    }
    const out: PathPaintSource[] = [];
    for (const [key, sides] of byPath) {
      // A deleted path's paint is left unused.
      const frame = pathPaintFrame(owner, key);
      if (frame !== null) out.push({ frame, grids: sides });
    }
    return out.length > 0 ? out : null;
  }

  private load(digest: string): Promise<void> {
    const known = this.reading.get(digest);
    if (known !== undefined) return known;
    const p = this.read!(digest).then(
      (b) => {
        this.bytes.set(digest, new Uint8Array(b));
      },
      () => {
        this.bytes.set(digest, null);
      },
    ).finally(() => this.reading.delete(digest));
    this.reading.set(digest, p);
    return p;
  }
}

/**
 * The `tlPaint` attribute of generated vertices (`positions`, `normals`: xyz
 * relative to `offset` in the object's frame), or null when no grid reaches
 * any of them (the mesh then draws the program it had).
 */
export function pathPaintAttribute(sources: readonly PathPaintSource[], positions: ArrayLike<number>, normals: ArrayLike<number>, offset?: readonly number[]): THREE.BufferAttribute | null {
  const out = new Uint8Array((positions.length / 3) * VERTEX_PAINT_BYTES);
  samplePathPaint(sources, positions, normals, out, offset);
  return out.some((v) => v !== 0) ? new THREE.BufferAttribute(out, VERTEX_PAINT_BYTES, true) : null;
}
