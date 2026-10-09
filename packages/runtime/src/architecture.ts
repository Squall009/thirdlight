/**
 * Generated architecture's colliders in the simulation. The simulation makes
 * them itself from the component's parameters (`architectureColliders`, the
 * same pure generator the page draws with), so nothing crosses from the
 * page: boxes along each wall segment cut round openings, meshes for floors
 * (and roofs and vaults that ask), a box per stamped piece copy, and each
 * kit copy that collides as its model's `_COL` parts. Outlines are made by
 * their presets' styles first (`expandArchitecture`, with the game's style
 * graphs and the presets scripts swapped), as the page makes them. Built in
 * the grid's collision batches when an object loads, its parameters change
 * or a preset swap reaches it. Objects drawn on a block layer
 * (`architecture.layer`) also give that layer's grid their rooms' wall
 * edges and regions (`roomsOn`). Buildings whose interiors are scenes of
 * their own link their doors' two sides (`doorLinks`, from the objects
 * loaded: an exterior gives the outside of its doors, an interior the
 * inside).
 *
 * Pure simulation state.
 */
import { COLLIDER_3D_LIMITS, architectureColliders, architectureDoorLinks, architectureRoomRegions, architectureStylesOf, architectureWallEdges, canonicalJsonText, expandArchitecture, type ArchitectureComponent, type ArchitectureGraphLike, type ArchitectureStyles, type EntityV3, type ModelColliderTable } from '@thirdlight/project-model';

import { colliderShape3DOf } from './collider-specs';
import type { GridDoorLink } from './grid';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import { deepFreeze } from './snapshot';

/** Generated architecture's colliders built and the last build (diagnostics). */
export interface ArchitectureCollisionDiagnostics {
  objects: number;
  colliders: number;
  lastBuild: { objects: number; colliders: number; ms: number } | null;
}

/**
 * What the rooms drawn on a block layer give its grid (layer cells): the
 * cell edges their walls stand on (`cellKeyOf × 2 + axis` → blocks; an
 * opening's edges do not) and each room storey as a region.
 */
export interface ArchitectureLayerRooms {
  readonly edges: ReadonlyMap<number, boolean>;
  readonly regions: ReadonlyMap<string, readonly (readonly number[])[]>;
}

const NO_ROOMS: ArchitectureLayerRooms = Object.freeze({ edges: new Map(), regions: new Map() });

/** A collider id of an object's generated architecture (stable: the element and the piece's place). */
const colliderId = (id: string, part: string): string => `${id}#arch:${part}`;

/** Metres a door link is looked for round a point when the script names no reach. */
export const DOOR_LINK_REACH_DEFAULT = 2;

interface Held {
  component: ArchitectureComponent;
  origin: [number, number, number];
  /** Its door links (null: not read yet). */
  doors: readonly GridDoorLink[] | null;
  /** The parameters' text the colliders were built from (null: not built). */
  builtFrom: string | null;
  built: string[];
}

export class RuntimeArchitecture {
  private readonly held = new Map<string, Held>();
  /** The door links of every held object, made on the first ask after an object came or went. */
  private doorList: readonly GridDoorLink[] | null = null;
  private dirty = new Set<string>();
  private lastBuild: ArchitectureCollisionDiagnostics['lastBuild'] = null;
  private readonly styles: ArchitectureStyles;
  /** Presets scripts swapped (`setArchitecturePreset`): preset → the one shown in its place. */
  private swaps: Readonly<Record<string, string>> = {};
  /** Counts changes to rooms drawn on block layers (objects with `layer` added, removed or restyled). */
  private roomsRevision = 0;
  private readonly roomsCache = new Map<string, { revision: number; key: string; rooms: ArchitectureLayerRooms }>();

  constructor(
    private readonly collide = false,
    private readonly modelColliders?: ModelColliderTable,
    styleGraphs?: readonly ArchitectureGraphLike[],
    /** The scene a loaded object is in (absent: none known). */
    private readonly sceneOf?: (entityId: string) => string | undefined,
  ) {
    this.styles = architectureStylesOf(styleGraphs);
  }

  /** Whether a preset is the game's (or one of the engine's starters). */
  hasPreset(id: string): boolean {
    return this.styles.presets.has(id);
  }

  /** The presets shown in place of others; objects with outlines or buildings build their colliders again. */
  setSwaps(swaps: Readonly<Record<string, string>>): void {
    this.swaps = swaps;
    for (const [id, h] of this.held) if ((h.component.outlines?.length ?? 0) + (h.component.buildings?.length ?? 0) > 0) this.dirty.add(id);
    this.roomsRevision += 1;
  }

  /** Changes whenever the rooms on any layer may have (walk graphs kept from before are stale). */
  get revision(): number {
    return this.roomsRevision;
  }

  /**
   * The rooms drawn on a block layer (objects whose `layer` names it): their
   * wall edges and regions in the layer's cells (`origin`, `cellSize`: the
   * layer's). Kept until an object or a swap changes.
   */
  roomsOn(layerId: string, origin: readonly number[], cellSize: readonly number[]): ArchitectureLayerRooms {
    const key = `${origin.join(',')}|${cellSize.join(',')}`;
    const kept = this.roomsCache.get(layerId);
    if (kept !== undefined && kept.revision === this.roomsRevision && kept.key === key) return kept.rooms;
    const edges = new Map<number, boolean>();
    const regions = new Map<string, readonly (readonly number[])[]>();
    for (const [, h] of [...this.held].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (h.component.layer !== layerId) continue;
      const x = expandArchitecture(h.component, h.origin, this.styles, { swaps: this.swaps });
      const offset = [0, 1, 2].map((i) => h.origin[i]! - (origin[i] ?? 0));
      for (const [k, v] of architectureWallEdges(x.component, offset, cellSize)) edges.set(k, (edges.get(k) ?? false) || v);
      for (const r of architectureRoomRegions(x.rooms, offset, cellSize)) if (!regions.has(r.regionId)) regions.set(r.regionId, r.boxes);
    }
    const rooms = edges.size === 0 && regions.size === 0 ? NO_ROOMS : { edges, regions };
    this.roomsCache.set(layerId, { revision: this.roomsRevision, key, rooms });
    return rooms;
  }

  /** The door links of the loaded objects (objects in id order; frozen). Scripts and graphs ask every frame: kept until an object comes or goes. */
  doorLinks(): readonly GridDoorLink[] {
    if (this.doorList !== null) return this.doorList;
    const out: GridDoorLink[] = [];
    for (const [id, h] of [...this.held].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (h.component.buildings === undefined) continue;
      h.doors ??= Object.freeze(
        architectureDoorLinks(id, h.component, h.origin).map((l) => deepFreeze({ ...l, scene: this.sceneOf?.(id) ?? (l.side === 'inside' ? (h.component.buildings?.find((b) => b.id === l.building)?.interior?.scene ?? null) : null) })),
      );
      out.push(...h.doors);
    }
    this.doorList = Object.freeze(out);
    return this.doorList;
  }

  /** The door link nearest a world point within `reach` metres on the ground (null: none, or not a point). */
  doorLinkNear(point: readonly number[], reach?: number): GridDoorLink | null {
    if (!Array.isArray(point) || point.length !== 3 || !point.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    const r = typeof reach === 'number' && Number.isFinite(reach) && reach >= 0 ? reach : DOOR_LINK_REACH_DEFAULT;
    let best: GridDoorLink | null = null;
    let bestD = r * r;
    for (const l of this.doorLinks()) {
      const dx = l.position[0] - point[0]!;
      const dz = l.position[2] - point[2]!;
      const d = dx * dx + dz * dz;
      if (d <= bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  /** Loaded objects carrying `architecture` (their colliders at the next flush when new or changed). */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const c = (e.components as { architecture?: ArchitectureComponent }).architecture;
      if (c === undefined || !Array.isArray(c.elements)) continue;
      const p = e.components.transform?.position ?? [0, 0, 0];
      const old = this.held.get(e.id);
      this.doorList = null;
      this.held.set(e.id, { component: c, origin: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], doors: null, builtFrom: old?.builtFrom ?? null, built: old?.built ?? [] });
      this.dirty.add(e.id);
      if (c.layer !== undefined || old?.component.layer !== undefined) this.roomsRevision += 1;
    }
  }

  /** Forget unloaded objects; returns their collider ids (the caller removes them from the port). */
  remove(ids: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const h = this.held.get(id);
      if (h !== undefined) out.push(...h.built);
      if (h?.component.layer !== undefined) this.roomsRevision += 1;
      this.held.delete(id);
      this.doorList = null;
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
      const expanded = expandArchitecture(h.component, h.origin, this.styles, { swaps: this.swaps }).component;
      const from = canonicalJsonText({ c: expanded, o: h.origin });
      if (h.builtFrom === from) continue;
      remove.push(...h.built);
      h.built = [];
      h.builtFrom = from;
      for (const spec of this.collidersOf(id, expanded, h.origin)) {
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

  private collidersOf(id: string, component: ArchitectureComponent, o: readonly [number, number, number]): StaticColliderSpec3D[] {
    const out: StaticColliderSpec3D[] = [];
    // Rows come from the material's sheet only on the page; colliders follow surfaces, which no sheet moves.
    for (const c of architectureColliders(component, {}, { vertices: COLLIDER_3D_LIMITS.meshVertices, triangles: COLLIDER_3D_LIMITS.meshTriangles })) {
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
