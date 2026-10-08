/**
 * Buildings whose interiors are scenes of their own: the interior object
 * made in that scene from the building's one definition, and the links
 * between their doors.
 *
 * - The interior is not stored: the build (and the editor's Scene view) adds
 *   an object to the interior scene carrying the building as its one
 *   building, marked `interiorOf` (the scene and object it stands on), at
 *   the building's place moved by `interior.offset`. It wears the building
 *   object's materials. Editing the building edits both sides.
 * - Doors are the ground storey's openings whose sill is at the floor
 *   (`ARCHITECTURE_DOOR_SILL_MAX`). Each links the exterior's side of the
 *   door with the interior's: where the door stands, where one arriving
 *   through it stands (`ARCHITECTURE_DOOR_SPAWN_DISTANCE` in front of it, on
 *   that side) and the way out of the door there. What using a door does is
 *   the game's: the links only say where the other side is.
 *
 * Pure.
 */
import { pathPointAt, samplePath } from './arch-path';
import { hashText64 } from './arch-math';
import { pointInPolygon } from './arch-mesh';
import { ARCHITECTURE_DOOR_SILL_MAX, ARCHITECTURE_DOOR_SPAWN_DISTANCE, type ArchitectureBuilding, type ArchitectureComponent } from './architecture';

type Vec3 = [number, number, number];

/** One side of a linked door (world metres; `facing`: degrees about +Y turning +Z toward the way out of the door on this side). */
export interface ArchitectureDoorSide {
  /** The door's middle on its floor. */
  position: Vec3;
  /** Where one arriving through the door stands. */
  spawn: Vec3;
  facing: number;
}

/** A door of a building whose interior is a scene of its own, seen from one side. */
export interface ArchitectureDoorLink extends ArchitectureDoorSide {
  /** `<building>/<door>`: the same on both sides. */
  id: string;
  building: string;
  /** The opening's id. */
  door: string;
  /** This side's object. */
  entity: string;
  side: 'outside' | 'inside';
  /** The other side: its scene, the door there and where one arriving through it stands. */
  to: ArchitectureDoorSide & { scene: string };
}

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The id of the object a building's interior is made as in its own scene (stable: the building object's and the building's ids). */
export function buildingInteriorId(entityId: string, buildingId: string): string {
  return `interior-${hashText64(`${entityId}/${buildingId}`)}`;
}

/** Whether an opening is a door the interior links (on the ground storey, its sill at the floor). */
export function isBuildingDoor(o: { bottom: number; storey?: number }): boolean {
  return (o.storey ?? 0) === 0 && o.bottom <= ARCHITECTURE_DOOR_SILL_MAX;
}

/** Degrees about +Y that turn +Z toward (dx, dz). */
function facingOf(dx: number, dz: number): number {
  if (dx === 0) return dz >= 0 ? 0 : 180;
  if (dz === 0) return dx > 0 ? 90 : -90;
  return r6((Math.atan2(dx, dz) * 180) / Math.PI);
}

/**
 * The door links an object's buildings give (`origin`: its world position):
 * the outside of each door of a building whose interior is its own scene,
 * or, for an interior made in its scene (`interiorOf`), the inside.
 */
export function architectureDoorLinks(entityId: string, c: ArchitectureComponent, origin: readonly number[]): ArchitectureDoorLink[] {
  const out: ArchitectureDoorLink[] = [];
  const inside = c.interiorOf !== undefined;
  for (const b of c.buildings ?? []) {
    if (b.interior === undefined || b.path.closed !== true || b.path.points.length < 3) continue;
    const doors = (b.openings ?? []).filter(isBuildingDoor);
    if (doors.length === 0) continue;
    const s = samplePath(b.path);
    const ground: number[] = [];
    for (let i = 0; i < s.n; i++) ground.push(s.pos[i * 3]!, s.pos[i * 3 + 2]!);
    const off = b.interior.offset ?? [0, 0, 0];
    const here = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const there = inside ? [here[0]! - off[0], here[1]! - off[1], here[2]! - off[2]] : [here[0]! + off[0], here[1]! + off[1], here[2]! + off[2]];
    const p = [0, 0, 0];
    const t = [0, 0, 0];
    for (const o of doors) {
      pathPointAt(s, o.at, p, t);
      // Into the building: right of travel (the drawing rule), checked against the footprint.
      let ix = -t[2]!;
      let iz = t[0]!;
      const l = Math.sqrt(ix * ix + iz * iz) || 1;
      ix /= l;
      iz /= l;
      if (!pointInPolygon(p[0]! + ix * 0.05, p[2]! + iz * 0.05, ground)) {
        ix = -ix;
        iz = -iz;
      }
      const d = ARCHITECTURE_DOOR_SPAWN_DISTANCE;
      const side = (at: readonly number[], into: number, y: number): ArchitectureDoorSide => ({
        position: [r6(at[0]! + p[0]!), r6(at[1]! + y), r6(at[2]! + p[2]!)],
        spawn: [r6(at[0]! + p[0]! + ix * d * into), r6(at[1]! + y), r6(at[2]! + p[2]! + iz * d * into)],
        facing: facingOf(ix * into, iz * into),
      });
      // Outside: the way out is out of the building; inside: into it.
      const outer = side(inside ? there : here, -1, p[1]!);
      const inner = side(inside ? here : there, 1, p[1]!);
      const scene = inside ? c.interiorOf!.scene : b.interior.scene;
      out.push({ id: `${b.id}/${o.id}`, building: b.id, door: o.id, entity: entityId, side: inside ? 'inside' : 'outside', ...(inside ? inner : outer), to: { scene, ...(inside ? outer : inner) } });
    }
  }
  return out;
}

/** An object of a scene document as the interiors read it. */
export interface BuildingSourceEntity {
  id: string;
  name?: string;
  active?: boolean;
  components: object;
}

/** The object a building's interior is made as in its own scene (`sceneId`: the scene the building object is in). */
export function buildingInteriorEntity(source: BuildingSourceEntity, sceneId: string, building: ArchitectureBuilding): { id: string; name: string; components: Record<string, unknown> } {
  const own = source.components as Record<string, unknown>;
  const c = own['architecture'] as ArchitectureComponent;
  const p = (own['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
  const off = building.interior?.offset ?? [0, 0, 0];
  const architecture: ArchitectureComponent = {
    elements: [],
    ...(c.profiles !== undefined ? { profiles: c.profiles } : {}),
    buildings: [building],
    // The rooms of a locked plan stand in the interior with it.
    ...((c.outlines ?? []).some((o) => o.building === building.id) ? { outlines: (c.outlines ?? []).filter((o) => o.building === building.id) } : {}),
    ...(c.masks !== undefined ? { masks: c.masks } : {}),
    ...(c.chunkSize !== undefined ? { chunkSize: c.chunkSize } : {}),
    ...(c.seed !== undefined ? { seed: c.seed } : {}),
    ...(c.ao !== undefined ? { ao: c.ao } : {}),
    ...(c.lodDistance !== undefined ? { lodDistance: c.lodDistance } : {}),
    ...(c.castShadow !== undefined ? { castShadow: c.castShadow } : {}),
    ...(c.receiveShadow !== undefined ? { receiveShadow: c.receiveShadow } : {}),
    interiorOf: { scene: sceneId, entity: source.id },
  };
  const components: Record<string, unknown> = {
    transform: { position: [r6((p[0] ?? 0) + off[0]), r6((p[1] ?? 0) + off[1]), r6((p[2] ?? 0) + off[2])], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    architecture,
  };
  for (const k of ['materials', 'materialParams']) if (own[k] !== undefined) components[k] = own[k];
  return { id: buildingInteriorId(source.id, building.id), name: `${source.name ?? source.id} ${building.id} interior`.slice(0, 128), components };
}

/**
 * The interiors scene documents get from the buildings of every scene: the
 * documents with each interior scene's objects added (the others as they
 * are). A building naming its own scene, no scene of the set, or an id
 * already taken adds nothing.
 */
export function withBuildingInteriors<D extends { sceneId: string; entities: readonly BuildingSourceEntity[] }>(docs: readonly D[]): D[] {
  const ids = new Set<string>();
  for (const d of docs) for (const e of d.entities) ids.add(e.id);
  const added = new Map<string, BuildingSourceEntity[]>();
  const scenes = new Set(docs.map((d) => d.sceneId));
  for (const d of docs) {
    for (const e of d.entities) {
      if (e.active === false) continue;
      const c = (e.components as { architecture?: ArchitectureComponent }).architecture;
      for (const b of c?.buildings ?? []) {
        const target = b.interior?.scene;
        if (target === undefined || target === d.sceneId || !scenes.has(target)) continue;
        const made = buildingInteriorEntity(e, d.sceneId, b);
        if (ids.has(made.id)) continue;
        ids.add(made.id);
        added.set(target, [...(added.get(target) ?? []), made]);
      }
    }
  }
  if (added.size === 0) return [...docs];
  return docs.map((d) => (added.has(d.sceneId) ? ({ ...d, entities: [...d.entities, ...added.get(d.sceneId)!] } as D) : d));
}
