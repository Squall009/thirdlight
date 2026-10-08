/**
 * The loaded splines as scripts read them (`ctx.splines`): a place and
 * cross-section at any distance along one, its length, and the nearest
 * place on it to a point — for anything that follows or measures a path
 * (a cart on a track, a patrol along a wall, a race's progress).
 *
 * Each loaded object carrying `spline` gets its curve in the world (the
 * object's position plus its points, as authored) when its scene loads;
 * `at` and `nearest` read it without allocating per call beyond the answer.
 *
 * What a spline makes collides: its mesh (a surface; water only when its
 * `collision` says so) as static triangle meshes, cut by cross-sections to
 * stay within the port's mesh limits, and each copy of a piece that collides
 * as its model's `_COL` parts. The made data arrives decoded from the page
 * (`addMade`, by digest: the simulation never touches the network); a spline
 * whose data has not arrived yet has no colliders until it does. They are
 * built in the grid's collision batches.
 *
 * Pure simulation state: the same curve in the page and the worker.
 */
import { COLLIDER_3D_LIMITS, SplineCurve, newSplineFrame, type EntityV3, type ModelColliderTable, type SplineComponent, type SplineFrame, type SplineMade } from '@thirdlight/project-model';

import { colliderShape3DOf } from './collider-specs';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

/** A place on a spline and its cross-section (world metres, unit vectors). */
export interface SplinePose {
  /** Metres along the curve from its start (wrapped on a closed curve, clamped on an open one). */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Along the curve. */
  readonly tangent: readonly [number, number, number];
  /** Across to the right, turned by the roll. */
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** Metres across, and degrees of roll. */
  readonly width: number;
  readonly roll: number;
}

/** The nearest place on a spline to a point. */
export interface SplineNearestInfo {
  /** Metres along the curve. */
  readonly distance: number;
  readonly position: readonly [number, number, number];
  /** Metres from the point to the curve. */
  readonly offset: number;
}

/**
 * The splines of the loaded scenes (objects carrying `spline`), in the world
 * as their objects were placed.
 */
export interface BehaviorSplines {
  /**
   * Metres along an object's spline (null when the object carries none or is not loaded).
   * @graphPure
   * @graphNode Spline length
   */
  length(entityId: string): number | null;
  /**
   * The place and cross-section `distance` metres along an object's spline (clamped to its ends; a closed one wraps), or null without one.
   * @graphPure
   * @graphNode Spline point at
   */
  at(entityId: string, distance: number): SplinePose | null;
  /**
   * The nearest place on an object's spline to a world position (`level`: measured across the ground, x and z only), or null without one.
   * @graphPure
   * @graphNode Nearest on spline
   */
  nearest(entityId: string, position: readonly [number, number, number], options?: { level?: boolean }): SplineNearestInfo | null;
}

const v = (x: number, y: number, z: number): readonly [number, number, number] => Object.freeze([x, y, z] as [number, number, number]);

/** A spline's made data on the page's way to the simulation, by digest. */
export interface SplineSimData {
  readonly digest: string;
  readonly spline: SplineMade;
}

/** Splines' colliders built and the last build (diagnostics). */
export interface SplineCollisionDiagnostics {
  splines: number;
  colliders: number;
  /** Splines whose made data has not arrived. */
  waiting: number;
  lastBuild: { splines: number; colliders: number; ms: number } | null;
}

/** A collider id of a spline (its mesh's part `k`, or copy `c` of its pieces setting `i`). */
const meshColliderId = (id: string, k: number): string => `${id}#spline-mesh:${k}`;
const copyColliderId = (id: string, i: number, c: number): string => `${id}#spline-piece:${i}:${c}`;

interface Held {
  readonly component: SplineComponent;
  readonly origin: readonly [number, number, number];
  built: string[];
  builtDigest: string | null;
}

export class RuntimeSplines {
  private readonly curves = new Map<string, SplineCurve>();
  private readonly held = new Map<string, Held>();
  private readonly made = new Map<string, SplineMade>();
  private dirty = new Set<string>();
  private lastBuild: SplineCollisionDiagnostics['lastBuild'] = null;
  private readonly scratch: SplineFrame = newSplineFrame();
  readonly api: BehaviorSplines;

  constructor(
    private readonly collide = false,
    private readonly modelColliders?: ModelColliderTable,
  ) {
    const curves = this.curves;
    const scratch = this.scratch;
    this.api = Object.freeze({
      length: (entityId: string): number | null => curves.get(entityId)?.length ?? null,
      at: (entityId: string, distance: number): SplinePose | null => {
        const c = curves.get(entityId);
        if (c === undefined || typeof distance !== 'number' || !Number.isFinite(distance)) return null;
        const f = c.frameAt(distance, scratch);
        return Object.freeze({ distance: f.distance, position: v(f.x, f.y, f.z), tangent: v(f.tx, f.ty, f.tz), right: v(f.rx, f.ry, f.rz), up: v(f.ux, f.uy, f.uz), width: f.width, roll: f.roll });
      },
      nearest: (entityId: string, position: readonly [number, number, number], options?: { level?: boolean }): SplineNearestInfo | null => {
        const c = curves.get(entityId);
        if (c === undefined || !Array.isArray(position) || position.length < 3 || !position.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
        const n = c.nearest(position[0], position[1], position[2], options?.level === true);
        return Object.freeze({ distance: n.distance, position: v(n.x, n.y, n.z), offset: n.offset });
      },
    });
  }

  /** The splines of loaded objects (their curves made now; their colliders at the next flush). */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const s = (e.components as { spline?: SplineComponent }).spline;
      if (s === undefined || !Array.isArray(s.points) || s.points.length < 2) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      this.curves.set(e.id, SplineCurve.of(s, p));
      this.held.set(e.id, { component: s, origin: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], built: this.held.get(e.id)?.built ?? [], builtDigest: null });
      if (s.data !== undefined) this.dirty.add(e.id);
    }
  }

  /** Forget unloaded objects' splines; returns their collider ids (the caller removes them from the port). */
  remove(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const id of ids) {
      this.curves.delete(id);
      const h = this.held.get(id);
      if (h !== undefined) out.push(...h.built);
      this.held.delete(id);
      this.dirty.delete(id);
    }
    return out;
  }

  /** Made data decoded on the page (by digest): the splines naming it get their colliders at the next flush. */
  addMade(items: readonly SplineSimData[]): void {
    for (const it of items) {
      this.made.set(it.digest, it.spline);
      for (const [id, h] of this.held) if (h.component.data === it.digest) this.dirty.add(id);
    }
  }

  /** Build the colliders of what the splines made, for those whose data arrived or changed (batched: one remove, one add). */
  flush(port: PhysicsPort3D | undefined): void {
    if (this.dirty.size === 0) return;
    const dirty = [...this.dirty].sort();
    this.dirty = new Set();
    if (port === undefined || !this.collide) return;
    const t0 = performance.now();
    const remove: string[] = [];
    const add: StaticColliderSpec3D[] = [];
    let splines = 0;
    for (const id of dirty) {
      const h = this.held.get(id);
      const digest = h?.component.data;
      if (h === undefined || digest === undefined || h.builtDigest === digest) continue;
      const made = this.made.get(digest);
      if (made === undefined) continue;
      remove.push(...h.built);
      h.built = [];
      h.builtDigest = digest;
      for (const spec of this.collidersOf(id, h, made)) {
        add.push(spec);
        h.built.push(spec.entityId);
      }
      splines += 1;
    }
    if (remove.length > 0) port.removeStaticColliders?.(remove);
    if (add.length > 0) port.addStaticColliders?.(add);
    if (splines > 0) this.lastBuild = { splines, colliders: add.length, ms: performance.now() - t0 };
  }

  diagnostics(): SplineCollisionDiagnostics | null {
    if (this.held.size === 0) return null;
    let colliders = 0;
    let waiting = 0;
    for (const h of this.held.values()) {
      colliders += h.built.length;
      if (h.component.data !== undefined && !this.made.has(h.component.data)) waiting += 1;
    }
    return { splines: this.held.size, colliders, waiting, lastBuild: this.lastBuild };
  }

  private collidersOf(id: string, h: Held, made: SplineMade): StaticColliderSpec3D[] {
    const out: StaticColliderSpec3D[] = [];
    const c = h.component;
    const o = h.origin;
    const mesh = c.mesh;
    if (mesh !== undefined && (mesh.collision ?? mesh.kind !== 'water')) {
      let k = 0;
      for (const p of made.pieces) {
        // Whole cross-sections at a time, within the port's mesh limits.
        const row = p.rowLength;
        const rows = p.positions.length / 3 / row;
        const per = Math.max(2, Math.min(Math.floor(COLLIDER_3D_LIMITS.meshVertices / row), Math.floor(COLLIDER_3D_LIMITS.meshTriangles / (2 * Math.max(1, row - 1))) + 1));
        for (let r0 = 0; r0 + 1 < rows; r0 += per - 1) {
          const r1 = Math.min(rows - 1, r0 + per - 1);
          const vertices = p.positions.slice(r0 * row * 3, (r1 + 1) * row * 3);
          const indices = new Uint32Array((r1 - r0) * (row - 1) * 6);
          let n = 0;
          for (let r = 0; r < r1 - r0; r++) {
            for (let j = 0; j + 1 < row; j++) {
              const a = r * row + j;
              indices[n++] = a;
              indices[n++] = a + 1;
              indices[n++] = a + row;
              indices[n++] = a + 1;
              indices[n++] = a + row + 1;
              indices[n++] = a + row;
            }
          }
          out.push({ entityId: meshColliderId(id, k++), shape: { type: 'mesh', vertices, indices }, position: { x: o[0] + p.center[0], y: o[1] + p.center[1], z: o[2] + p.center[2] }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
        }
      }
    }
    for (const k of made.copies) {
      const p = c.pieces?.[k.index];
      if (p === undefined || p.collide === false) continue;
      const n = k.copies.length / 10;
      for (let i = 0; i < n; i++) {
        const f = i * 10;
        const shape = colliderShape3DOf({ type: 'model' }, [k.copies[f + 7]!, k.copies[f + 8]!, k.copies[f + 9]!], { model: { asset: { assetId: p.asset.assetId }, ...(p.asset.piece !== undefined ? { piece: p.asset.piece } : {}) } }, this.modelColliders !== undefined ? { modelColliders: this.modelColliders } : undefined);
        if (shape === null) continue;
        const q = [k.copies[f + 3]!, k.copies[f + 4]!, k.copies[f + 5]!, k.copies[f + 6]!];
        const len = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
        out.push({ entityId: copyColliderId(id, k.index, i), shape, position: { x: o[0] + k.copies[f]!, y: o[1] + k.copies[f + 1]!, z: o[2] + k.copies[f + 2]! }, rotation: { x: q[0]! / len, y: q[1]! / len, z: q[2]! / len, w: q[3]! / len } });
      }
    }
    return out;
  }

  /** Whether an object's spline is loaded. */
  has(id: string): boolean {
    return this.curves.has(id);
  }

  curve(id: string): SplineCurve | undefined {
    return this.curves.get(id);
  }
}
