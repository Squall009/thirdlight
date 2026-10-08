/**
 * Generated architecture's colliders in the simulation. The simulation makes
 * them itself from the component's parameters (`architectureColliders`, the
 * same pure generator the page draws with), so nothing crosses from the
 * page: boxes along each wall segment cut round openings, meshes for floors
 * (and roofs and vaults that ask), a box per stamped piece copy, and each
 * kit copy that collides as its model's `_COL` parts. Built in the grid's
 * collision batches when an object loads or its parameters change.
 *
 * Pure simulation state.
 */
import { COLLIDER_3D_LIMITS, architectureColliders, canonicalJsonText, type ArchitectureComponent, type EntityV3, type ModelColliderTable } from '@thirdlight/project-model';

import { colliderShape3DOf } from './collider-specs';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';

/** Generated architecture's colliders built and the last build (diagnostics). */
export interface ArchitectureCollisionDiagnostics {
  objects: number;
  colliders: number;
  lastBuild: { objects: number; colliders: number; ms: number } | null;
}

/** A collider id of an object's generated architecture (stable: the element and the piece's place). */
const colliderId = (id: string, part: string): string => `${id}#arch:${part}`;

interface Held {
  component: ArchitectureComponent;
  origin: [number, number, number];
  /** The parameters' text the colliders were built from (null: not built). */
  builtFrom: string | null;
  built: string[];
}

export class RuntimeArchitecture {
  private readonly held = new Map<string, Held>();
  private dirty = new Set<string>();
  private lastBuild: ArchitectureCollisionDiagnostics['lastBuild'] = null;

  constructor(
    private readonly collide = false,
    private readonly modelColliders?: ModelColliderTable,
  ) {}

  /** Loaded objects carrying `architecture` (their colliders at the next flush when new or changed). */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const c = (e.components as { architecture?: ArchitectureComponent }).architecture;
      if (c === undefined || !Array.isArray(c.elements)) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      const old = this.held.get(e.id);
      this.held.set(e.id, { component: c, origin: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], builtFrom: old?.builtFrom ?? null, built: old?.built ?? [] });
      this.dirty.add(e.id);
    }
  }

  /** Forget unloaded objects; returns their collider ids (the caller removes them from the port). */
  remove(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const h = this.held.get(id);
      if (h !== undefined) out.push(...h.built);
      this.held.delete(id);
      this.dirty.delete(id);
    }
    return out;
  }

  /** Build the colliders of objects added or changed since the last flush (batched: one remove, one add). */
  flush(port: PhysicsPort3D | undefined): void {
    if (this.dirty.size === 0) return;
    const dirty = [...this.dirty].sort();
    this.dirty = new Set();
    if (port === undefined || !this.collide) return;
    const t0 = performance.now();
    const remove: string[] = [];
    const add: StaticColliderSpec3D[] = [];
    let objects = 0;
    for (const id of dirty) {
      const h = this.held.get(id);
      if (h === undefined) continue;
      const from = canonicalJsonText({ c: h.component, o: h.origin });
      if (h.builtFrom === from) continue;
      remove.push(...h.built);
      h.built = [];
      h.builtFrom = from;
      for (const spec of this.collidersOf(id, h)) {
        add.push(spec);
        h.built.push(spec.entityId);
      }
      objects += 1;
    }
    if (remove.length > 0) port.removeStaticColliders?.(remove);
    if (add.length > 0) port.addStaticColliders?.(add);
    if (objects > 0) this.lastBuild = { objects, colliders: add.length, ms: performance.now() - t0 };
  }

  diagnostics(): ArchitectureCollisionDiagnostics | null {
    if (this.held.size === 0) return null;
    let colliders = 0;
    for (const h of this.held.values()) colliders += h.built.length;
    return { objects: this.held.size, colliders, lastBuild: this.lastBuild };
  }

  private collidersOf(id: string, h: Held): StaticColliderSpec3D[] {
    const out: StaticColliderSpec3D[] = [];
    const o = h.origin;
    // Rows come from the material's sheet only on the page; colliders follow surfaces, which no sheet moves.
    for (const c of architectureColliders(h.component, {}, { vertices: COLLIDER_3D_LIMITS.meshVertices, triangles: COLLIDER_3D_LIMITS.meshTriangles })) {
      if (c.kind === 'box') {
        out.push({ entityId: colliderId(id, c.id), shape: { type: 'box', hx: c.half[0], hy: c.half[1], hz: c.half[2] }, position: { x: o[0] + c.center[0], y: o[1] + c.center[1], z: o[2] + c.center[2] }, rotation: { x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] } });
      } else if (c.kind === 'mesh') {
        out.push({ entityId: colliderId(id, c.id), shape: { type: 'mesh', vertices: c.vertices, indices: c.indices }, position: { x: o[0], y: o[1], z: o[2] }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
      } else {
        const shape = colliderShape3DOf({ type: 'model' }, c.scale, { model: { asset: { assetId: c.model.assetId }, ...(c.model.piece !== undefined ? { piece: c.model.piece } : {}) } }, this.modelColliders !== undefined ? { modelColliders: this.modelColliders } : undefined);
        if (shape === null) continue;
        out.push({ entityId: colliderId(id, c.id), shape, position: { x: o[0] + c.position[0], y: o[1] + c.position[1], z: o[2] + c.position[2] }, rotation: { x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] } });
      }
    }
    return out;
  }
}
