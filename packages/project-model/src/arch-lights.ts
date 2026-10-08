/**
 * The lights buildings' furnishing sets place, as light objects: made into
 * the scene documents by the build (Play and the export) and by the editor's
 * Scene view, never stored, so a new seed or plan moves them with the rooms.
 *
 * - Each light is a point light, a child of the architecture object at its
 *   room's middle (the expansion's `lights`), lighting through the same
 *   path as any light: room light layers, portals, the shadow budget. It
 *   casts no shadow (the engine's default for local lights).
 * - The scene's budget of point and spot lights (`MAX_LOCAL_LIGHTS`) holds:
 *   a scene's own lights first, then generated ones in object order until
 *   the budget is spent (a furnishing set's light count bounds one
 *   building's share).
 *
 * Pure.
 */
import { hashText64 } from './arch-math';
import { expandArchitecture } from './arch-rooms';
import type { ArchitectureStyles } from './arch-style';
import type { ArchitectureComponent } from './architecture';
import type { FurnishedLight } from './arch-furnish';
import { MAX_LOCAL_LIGHTS } from './local-lights';

/** An object of a scene document as the lights read it. */
export interface LightSourceEntity {
  id: string;
  name?: string;
  active?: boolean;
  components: object;
}

/** The id of a generated light's object (stable: the architecture object's and the light's ids). */
export function furnishingLightId(entityId: string, lightId: string): string {
  return `light-${hashText64(`${entityId}/${lightId}`)}`;
}

/** A furnishing light as a light object, the architecture object's child. */
export function furnishingLightEntity(entity: LightSourceEntity, l: FurnishedLight): { id: string; name: string; parentId: string; components: Record<string, unknown> } {
  return {
    id: furnishingLightId(entity.id, l.id),
    name: `${entity.name ?? entity.id} ${l.room} light`.slice(0, 128),
    parentId: entity.id,
    components: {
      transform: { position: [...l.position], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      light: { type: 'point', color: l.color, intensity: l.intensity, range: l.range, decay: 2 },
    },
  };
}

/** The furnishing lights of one architecture object (none without buildings). */
export function furnishingLightsOf(entity: LightSourceEntity, table: ArchitectureStyles): FurnishedLight[] {
  const comps = entity.components as { architecture?: ArchitectureComponent; transform?: { position?: number[] } };
  const c = comps.architecture;
  if (c?.buildings === undefined || !c.buildings.some((b) => b.furnishing !== undefined) || entity.active === false) return [];
  return [...(expandArchitecture(c, comps.transform?.position ?? [0, 0, 0], table).lights ?? [])];
}

const isLocal = (e: { components: object }): boolean => {
  const t = (e.components as { light?: { type?: unknown } }).light?.type;
  return t === 'point' || t === 'spot';
};

/**
 * Scene documents with each one's furnishing lights added (within its
 * budget of point and spot lights). The same documents when none are made.
 */
export function withFurnishingLights<D extends { entities: readonly LightSourceEntity[] }>(docs: readonly D[], table: ArchitectureStyles): D[] {
  let changed = false;
  const out = docs.map((d) => {
    let room = MAX_LOCAL_LIGHTS - d.entities.filter(isLocal).length;
    const ids = new Set(d.entities.map((e) => e.id));
    const added: LightSourceEntity[] = [];
    for (const e of d.entities) {
      if (room <= 0) break;
      for (const l of furnishingLightsOf(e, table)) {
        if (room <= 0) break;
        const made = furnishingLightEntity(e, l);
        if (ids.has(made.id)) continue;
        ids.add(made.id);
        added.push(made);
        room--;
      }
    }
    if (added.length === 0) return d;
    changed = true;
    return { ...d, entities: [...d.entities, ...added] } as D;
  });
  return changed ? out : [...docs];
}
