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
import { pathPaintFrame, samplePathPaint, VERTEX_PAINT_BYTES, type ArchitectureComponent, type PathGrid, type PathPaintGrid, type PathPaintSide, type PathPaintSource, type SplineComponent } from '@thirdlight/project-model';

import { PAINT_ATTRIBUTE } from './vertex-paint-draw';
import { PreviewLife, type PathPaintPreview } from './vertex-paint-preview';

/** `root.userData[PATH_PAINT_ENTITY_KEY]`: the object a generated mesh's root draws (the vertex paint brush finds what it paints by it). */
export const PATH_PAINT_ENTITY_KEY = '__tlPathPaintEntity';

/** One side's grid in place of the stored one (a brush's, before it is stored; null: the side unpainted). */
export interface PathGridOverride {
  readonly path: string;
  readonly side: PathPaintSide;
  readonly grid: PathGrid | null;
}

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
   * are, read or failed). `override`: one side drawn with this grid instead.
   */
  sources(owner: PathPaintOwner, grids: readonly PathPaintGrid[] | undefined, onReady: () => void, override?: PathGridOverride): readonly PathPaintSource[] | null | 'pending' {
    if ((grids === undefined || grids.length === 0) && override === undefined) return null;
    const missing = (grids ?? []).filter((g) => !this.bytes.has(g.paint));
    if (missing.length > 0) {
      if (this.read === null) return null;
      void Promise.all(missing.map((g) => this.load(g.paint))).then(onReady);
      return 'pending';
    }
    const byPath = new Map<string, Partial<Record<PathPaintSide, PathGrid>>>();
    for (const g of grids ?? []) {
      const grid = this.grid(g);
      if (grid === null) continue;
      let sides = byPath.get(g.path);
      if (sides === undefined) byPath.set(g.path, (sides = {}));
      sides[g.side] = grid;
    }
    if (override !== undefined) {
      let sides = byPath.get(override.path);
      if (sides === undefined) byPath.set(override.path, (sides = {}));
      if (override.grid === null) delete sides[override.side];
      else sides[override.side] = override.grid;
    }
    const out: PathPaintSource[] = [];
    for (const [key, sides] of byPath) {
      // A deleted path's paint is left unused.
      const frame = pathPaintFrame(owner, key);
      if (frame !== null) out.push({ frame, grids: sides });
    }
    return out.length > 0 ? out : null;
  }

  /** A stored grid as read (null: not read, or not the size it says). */
  grid(g: PathPaintGrid): PathGrid | null {
    const values = this.bytes.get(g.paint);
    if (values === null || values === undefined || values.length !== g.size[0] * g.size[1] * VERTEX_PAINT_BYTES) return null;
    return { origin: g.origin, size: g.size, values };
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

/**
 * Sample paint again onto meshes already drawn (a brush's preview): each
 * set of vertices once (levels of detail share theirs), its paint attribute
 * rewritten in place, or added where it had none. Positions are read in the
 * frame of `root` (the object's), each mesh at its place under it.
 */
export function resamplePathPaint(root: THREE.Object3D, meshes: readonly THREE.Mesh[], sources: readonly PathPaintSource[] | null): void {
  // The world matrices as the view placed them (set when built or moved).
  const inverse = root.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const done = new Map<THREE.BufferAttribute, THREE.BufferAttribute | null>();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (pos === undefined || nor === undefined) continue;
    let paint = done.get(pos);
    if (paint === undefined) {
      const had = g.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute | undefined;
      const out = had !== undefined && had.array.length === pos.count * VERTEX_PAINT_BYTES ? (had.array as Uint8Array) : new Uint8Array(pos.count * VERTEX_PAINT_BYTES);
      out.fill(0);
      m.multiplyMatrices(inverse, mesh.matrixWorld);
      if (sources !== null) samplePathPaint(sources, pos.array, nor.array, out, [m.elements[12], m.elements[13], m.elements[14]]);
      if (had !== undefined && had.array === out) {
        had.needsUpdate = true;
        paint = had;
      } else paint = out.some((v) => v !== 0) ? new THREE.BufferAttribute(out, VERTEX_PAINT_BYTES, true) : null;
      done.set(pos, paint);
    }
    if (paint !== null && g.getAttribute(PAINT_ATTRIBUTE) !== paint) {
      const had = g.getAttribute(PAINT_ATTRIBUTE) !== undefined;
      g.setAttribute(PAINT_ATTRIBUTE, paint);
      // A layout three reads only when the material's version moves (vertex-paint-preview.ts `relayout`).
      if (!had) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m !== undefined && m !== null) m.needsUpdate = true;
    }
  }
}

/**
 * Brush strokes drawn over generated objects' stored path paint
 * (vertex-paint-preview.ts): per object one side's grid in place of the
 * stored one, from the stroke's start until the object's stored paint
 * changes after it ended (or at once when it was refused).
 */
export class PathPaintOverrides {
  private readonly by = new Map<string, { override: PathGridOverride; life: PreviewLife; sig: string }>();

  /** The override drawn on an object (undefined: none). */
  of(id: string): PathGridOverride | undefined {
    return this.by.get(id)?.override;
  }

  /**
   * An object's stored paint is now `sig`: a held stroke's preview gives way
   * (true: it went, its meshes are drawn from the stored paint); one still
   * being painted stays on top of it.
   */
  stored(id: string, sig: string): boolean {
    const o = this.by.get(id);
    if (o === undefined || o.sig === sig) return false;
    o.sig = sig;
    if (!o.life.repainted()) return false;
    this.by.delete(id);
    return true;
  }

  /**
   * A stroke starts on `path`'s `side` of an object (a preview already on it
   * gives way to this one). `stored`: the side's grid as stored; the brush
   * starts from what is drawn. `redraw`: sample the drawn meshes again.
   */
  begin(id: string, sig: string, path: string, side: PathPaintSide, frame: PathPaintPreview['frame'], origin: readonly [number, number, number], stored: PathGrid | null, redraw: () => void): PathPaintPreview {
    const was = this.by.get(id);
    const from = was !== undefined && was.override.path === path && was.override.side === side ? was.override.grid : stored;
    was?.life.finish();
    const life = new PreviewLife();
    const rec = { override: { path, side, grid: from }, life, sig };
    this.by.set(id, rec);
    const copy = from === null ? null : { origin: [from.origin[0], from.origin[1]] as [number, number], size: [from.size[0], from.size[1]] as [number, number], values: from.values.slice() };
    return {
      kind: 'path',
      origin,
      frame,
      grid: copy,
      show: (grid) => {
        if (this.by.get(id) !== rec || life.state !== 'live') return;
        rec.override = { path, side, grid };
        redraw();
      },
      end: (keep) => {
        if (this.by.get(id) !== rec || life.state === 'gone') return life.gone;
        if (keep) {
          if (life.state === 'live') life.state = 'held';
          return life.gone;
        }
        this.by.delete(id);
        life.finish();
        redraw();
        return life.gone;
      },
    };
  }

  /** The object went: its preview with it. */
  drop(id: string): void {
    this.by.get(id)?.life.finish();
    this.by.delete(id);
  }
}
