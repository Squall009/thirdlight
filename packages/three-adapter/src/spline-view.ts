/**
 * The adapter's splines: what loaded objects carrying a `spline` make, drawn,
 * and their scatter bands handed to terrain ground cover.
 *
 * - Ground cover keeps clear of the splines' scatter bands as the stored
 *   copies do (those the backend bakes clear of them): the view hands the
 *   splines with a band to the cover generator whenever one is realized,
 *   changed or released.
 * - What a spline makes (its `data` blob: `spline-mesh.ts`) is read once per
 *   digest and drawn: each mesh piece a `THREE.LOD` of its levels (index
 *   lists over shared vertex buffers), switching where the next level's
 *   error is under a pixel at the reference view; the pieces' copies as
 *   instance sets of their models. They stand still and cast into the cached
 *   static shadow map. A mesh wears the object's material for slot "spline"
 *   (or "*"); without one, a plain grey surface or a blue, see-through water.
 *   Water carries its flow (UV set 1) and foam (vertex colour red) for a
 *   water material to read.
 * - A spline whose data changed keeps drawing what it had until the new
 *   blob is in (also when its object is released and realized again, as an
 *   edit does: a release takes effect at the next frame's update).
 */
import * as THREE from 'three';
import { LOD_REFERENCE_FOV_DEG, SPLINE_MATERIAL_SLOT, decodeSplineMade, type SplineComponent, type SplineMade } from '@thirdlight/runtime';

import type { CoverSpline } from './cover-worker';
import { buildInstanceSet, type BuiltInstanceSet } from './instancing';
import type { LodTuning } from './lod-switch';
import { STATIC_CASTER_KEY } from './shadow-casters';
import type { ModelInstance } from './visual';

/** Screen rows a level's error is measured against (1080p): it switches where its error is under one of them. */
const LOD_REFERENCE_ROWS = 1080;
/** Metres per metre of error: where a level's error covers one pixel at the reference view. */
const DISTANCE_PER_ERROR = LOD_REFERENCE_ROWS / (2 * Math.tan((LOD_REFERENCE_FOV_DEG * Math.PI) / 360));
/** The chunk size (m) a spline's pieces' copies are culled and given levels by. */
const PIECE_CHUNK_METRES = 64;

/** The page query that leaves out what splines make (`?splines=off`: a diagnostic comparison). */
export const SPLINES_URL_PARAM = 'splines';

/** Whether a page draws what splines make (`?splines=off|0|false`: no). */
export function splinesFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(SPLINES_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

export interface SplineViewDeps {
  /** The splines whose scatter bands terrain ground cover keeps clear of. */
  cover(splines: readonly CoverSpline[]): void;
  /** Read a stored blob by digest (null: none can be read here). */
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** A model's template for instance sets (null: still loading; `onReady` is called once it is in). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Put a model's own materials on an instance set's group (the undo; null: none). */
  dress(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** Put the object's materials (its `materials` component) on the mesh (the undo; null: none). */
  materials(root: THREE.Object3D, entityId: string): (() => void) | null;
  /** List (or unlist) a root's drawables in the scene. */
  place(root: THREE.Object3D, shown: boolean): void;
  /** The cached static shadow is drawn again. */
  shapeChanged(): void;
  tuning?: LodTuning;
  /** Something new to draw. */
  changed(): void;
  /** False: nothing made is drawn (a diagnostic comparison; ground cover still keeps clear of the bands). */
  drawn?: boolean;
}

interface Built {
  readonly root: THREE.Group;
  readonly geometries: THREE.BufferGeometry[];
  readonly sets: BuiltInstanceSet[];
  readonly undo: (() => void)[];
  readonly triangles: number;
  readonly pieces: number;
}

interface Rec {
  component: SplineComponent;
  origin: [number, number, number];
  hidden: boolean;
  /** The blob drawn, and the one being read. */
  built: Built | null;
  builtDigest: string | null;
  made: SplineMade | null;
  madeDigest: string | null;
  reading: string | null;
  /** Released (its object realized again, or gone): dropped at the next update unless set again first. */
  leaving: boolean;
}

/** What the view draws (diagnostics). */
export interface SplineViewDiagnostics {
  splines: number;
  meshPieces: number;
  /** Triangles of the finest levels, and the copies of the pieces' models. */
  triangles: number;
  copies: number;
  /** Blobs being read, and failures. */
  reading: number;
  errors: string[];
}

export class SplineView {
  private readonly splines = new Map<string, Rec>();
  private readonly errors: string[] = [];
  private disposed = false;
  private plain: THREE.MeshStandardMaterial | null = null;
  private water: THREE.MeshStandardMaterial | null = null;

  constructor(private readonly deps: SplineViewDeps) {}

  /** An object carrying `spline` was realized (or realized again), at `origin`. */
  set(id: string, component: SplineComponent, origin: readonly number[]): void {
    const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const had = this.splines.get(id);
    const rec: Rec = had ?? { component, origin: o, hidden: false, built: null, builtDigest: null, made: null, madeDigest: null, reading: null, leaving: false };
    const moved = had !== undefined && had.origin.some((v, i) => v !== o[i]);
    const coverBefore = had?.component.scatter !== undefined;
    rec.leaving = false;
    rec.component = component;
    rec.origin = o;
    this.splines.set(id, rec);
    if (coverBefore || component.scatter !== undefined) this.pushCover();
    const digest = this.deps.drawn === false ? null : (component.data ?? null);
    if (digest === null) {
      this.drop(rec);
      rec.made = null;
      rec.madeDigest = null;
      return;
    }
    if (moved && rec.built !== null) {
      rec.built.root.position.set(...o);
      rec.built.root.updateMatrixWorld(true);
      this.deps.place(rec.built.root, false);
      if (!rec.hidden) this.deps.place(rec.built.root, true);
      this.deps.shapeChanged();
    }
    if (rec.builtDigest === digest && rec.built !== null) return;
    if (rec.madeDigest === digest && rec.made !== null) {
      this.build(id, rec);
      return;
    }
    this.load(id, rec, digest);
  }

  /**
   * An object carrying `spline` was released: it goes at the next
   * {@link update} unless it is set again first (an object realized again,
   * every edit, keeps drawing what it made until its new data is in).
   */
  remove(id: string): void {
    const rec = this.splines.get(id);
    if (rec !== undefined) rec.leaving = true;
  }

  /** Drop the splines released and not set again (call once a frame, before the draw). */
  update(): void {
    let cover = false;
    for (const [id, rec] of [...this.splines]) {
      if (!rec.leaving) continue;
      this.splines.delete(id);
      this.drop(rec);
      cover ||= rec.component.scatter !== undefined;
    }
    if (cover) this.pushCover();
  }

  setHidden(id: string, hidden: boolean): void {
    const rec = this.splines.get(id);
    if (rec === undefined || rec.hidden === hidden) return;
    rec.hidden = hidden;
    if (rec.built !== null) {
      this.deps.place(rec.built.root, !hidden);
      this.deps.shapeChanged();
    }
  }

  ids(): string[] {
    return [...this.splines.keys()];
  }

  /** The materials of an object's mesh changed (its `materials` component): worn again. */
  restyle(id: string): void {
    const rec = this.splines.get(id);
    if (rec === undefined || rec.built === null) return;
    rec.built.undo[0]?.();
    rec.built.undo[0] = this.deps.materials(rec.built.root, id) ?? ((): void => undefined);
    this.deps.shapeChanged();
  }

  diagnostics(): SplineViewDiagnostics {
    let pieces = 0;
    let triangles = 0;
    let copies = 0;
    let reading = 0;
    for (const r of this.splines.values()) {
      if (r.reading !== null) reading += 1;
      if (r.built === null) continue;
      pieces += r.built.pieces;
      triangles += r.built.triangles;
      for (const s of r.built.sets) copies += s.count;
    }
    return { splines: this.splines.size, meshPieces: pieces, triangles, copies, reading, errors: [...this.errors] };
  }

  private pushCover(): void {
    const list: CoverSpline[] = [];
    for (const [id, s] of this.splines) if (s.component.scatter !== undefined) list.push({ id, component: s.component, origin: s.origin });
    this.deps.cover(list);
  }

  private load(id: string, rec: Rec, digest: string): void {
    if (rec.reading === digest || this.deps.read === null) return;
    rec.reading = digest;
    this.deps.read(digest).then(
      (bytes) => {
        if (this.disposed || this.splines.get(id) !== rec || rec.reading !== digest) return;
        rec.reading = null;
        try {
          rec.made = decodeSplineMade(new Uint8Array(bytes));
          rec.madeDigest = digest;
        } catch (e) {
          this.fail(`spline ${id}: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        this.build(id, rec);
      },
      (e: unknown) => {
        if (rec.reading === digest) rec.reading = null;
        this.fail(`spline ${id}: ${digest.slice(0, 12)}… could not be read (${e instanceof Error ? e.message : String(e)})`);
      },
    );
  }

  private fail(message: string): void {
    this.errors.push(message.slice(0, 200));
    if (this.errors.length > 16) this.errors.shift();
  }

  /** Draw a spline's made data (once every model its pieces repeat is in; their arrival builds it again). */
  private build(id: string, rec: Rec): void {
    const made = rec.made;
    if (made === null || this.disposed) return;
    const c = rec.component;
    const templates = made.copies.map((k) => {
      const p = c.pieces?.[k.index];
      return p === undefined ? null : { p, t: this.deps.template(p.asset.assetId, p.asset.piece, () => this.splines.get(id) === rec && rec.madeDigest === rec.component.data && this.build(id, rec)) };
    });
    if (templates.some((t) => t !== null && t.t === null)) return;
    const root = new THREE.Group();
    root.name = `spline:${id}`;
    root.position.set(...rec.origin);
    const geometries: THREE.BufferGeometry[] = [];
    let triangles = 0;
    if (made.pieces.length > 0) {
      const water = c.mesh?.kind === 'water';
      const material = this.surface(water);
      const cast = c.mesh?.castShadow !== false && !water;
      const receive = c.mesh?.receiveShadow !== false;
      for (const p of made.pieces) {
        const base: Record<string, THREE.BufferAttribute> = {
          position: new THREE.BufferAttribute(p.positions, 3),
          normal: new THREE.BufferAttribute(p.normals, 3),
          uv: new THREE.BufferAttribute(p.uvs, 2),
        };
        if (p.flow !== null && p.foam !== null) {
          base['uv1'] = new THREE.BufferAttribute(p.flow, 2);
          const color = new Float32Array((p.positions.length / 3) * 3);
          for (let i = 0; i < p.foam.length; i++) color[i * 3] = p.foam[i]!;
          base['color'] = new THREE.BufferAttribute(color, 3);
        }
        const lod = new THREE.LOD();
        lod.name = `spline:${id}:piece`;
        lod.position.set(p.center[0], p.center[1], p.center[2]);
        let last = -1;
        p.levels.forEach((level, k) => {
          const g = new THREE.BufferGeometry();
          for (const [name, a] of Object.entries(base)) g.setAttribute(name, a);
          g.setIndex(new THREE.BufferAttribute(level.indices, 1));
          g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), p.radius);
          g.boundingBox = new THREE.Box3().setFromBufferAttribute(base['position']!);
          geometries.push(g);
          const mesh = new THREE.Mesh(g, material);
          mesh.name = `spline:${id}:lod${k}`;
          mesh.castShadow = cast;
          mesh.receiveShadow = receive;
          if (cast) mesh.userData[STATIC_CASTER_KEY] = true;
          // Each level from where its error is under a pixel; never before the one finer than it.
          const at = k === 0 ? 0 : Math.max(last + 1, level.error * DISTANCE_PER_ERROR);
          last = at;
          lod.addLevel(mesh, at);
          if (k === 0) triangles += level.indices.length / 3;
        });
        root.add(lod);
      }
    }
    const sets: BuiltInstanceSet[] = [];
    const undo: (() => void)[] = [];
    made.copies.forEach((k, i) => {
      const t = templates[i];
      if (t === null || t === undefined || t.t === null || k.copies.length === 0) return;
      const built = buildInstanceSet(t.t, k.copies, k.copies.length / 10, `spline:${id}:pieces${k.index}`, { chunkSize: PIECE_CHUNK_METRES, ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}) });
      for (const mesh of built.meshes) {
        mesh.castShadow = t.p.castShadow !== false;
        mesh.receiveShadow = true;
        if (mesh.castShadow) mesh.userData[STATIC_CASTER_KEY] = true;
      }
      const undress = this.deps.dress(built.group, t.p.asset.assetId);
      if (undress !== null) undo.push(undress);
      root.add(built.group);
      sets.push(built);
    });
    // The object's materials on the mesh (its first undo: `restyle` replaces it).
    undo.unshift(this.deps.materials(root, id) ?? ((): void => undefined));
    root.updateMatrixWorld(true);
    this.drop(rec);
    rec.built = { root, geometries, sets, undo, triangles, pieces: made.pieces.length };
    rec.builtDigest = rec.madeDigest;
    if (!rec.hidden) this.deps.place(root, true);
    this.deps.shapeChanged();
    this.deps.changed();
  }

  /**
   * The plain surface a spline's mesh is made with (grey, or a see-through
   * blue for water), one of each for every spline and every rebuild: the
   * object's material put on it is then the same built material each time an
   * edit makes the mesh again, not a new one to build and compile.
   */
  private surface(water: boolean): THREE.MeshStandardMaterial {
    const have = water ? this.water : this.plain;
    if (have !== null) return have;
    const m = water
      ? new THREE.MeshStandardMaterial({ color: 0x2b6f8f, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.8, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.9, metalness: 0 });
    m.name = SPLINE_MATERIAL_SLOT;
    if (water) this.water = m;
    else this.plain = m;
    return m;
  }

  private drop(rec: Rec): void {
    const b = rec.built;
    if (b === null) return;
    rec.built = null;
    rec.builtDigest = null;
    this.deps.place(b.root, false);
    for (const u of b.undo) u();
    for (const s of b.sets) s.dispose();
    for (const g of b.geometries) g.dispose();
    this.deps.shapeChanged();
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of this.splines.values()) this.drop(rec);
    this.splines.clear();
    this.plain?.dispose();
    this.water?.dispose();
  }
}
