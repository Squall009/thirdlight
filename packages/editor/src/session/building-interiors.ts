/**
 * Buildings' interiors in the Scene view (browser-free). A building whose
 * interior is a scene of its own has no stored object there: the build makes
 * the interior into that scene from the building's definition
 * (`withBuildingInteriors`). The Scene view shows it the same way while that
 * scene is open, wherever the building's own scene is (the projection holds
 * every scene's objects), so the interior is seen where props are placed in
 * it. The drawn objects are not in the hierarchy and cannot be picked as
 * objects; they follow every edit of the building. Buildings' furnishing
 * lights are added the same way.
 */
import { buildingInteriorEntity, furnishingLightEntity, furnishingLightsOf, MAX_LOCAL_LIGHTS, type ArchitectureComponent, type ArchitectureStyles } from '@thirdlight/runtime';
import type { LightComponent } from '@thirdlight/project-model';

import type { ProjectedEntity } from './projection';

/** Interiors made from one building object, kept while the object (and the scenes open) stay the same. */
const made = new WeakMap<ProjectedEntity, ProjectedEntity[]>();

function interiorsOf(e: ProjectedEntity): ProjectedEntity[] {
  const known = made.get(e);
  if (known !== undefined) return known;
  const c = e.components['architecture'] as ArchitectureComponent | undefined;
  const out: ProjectedEntity[] = [];
  for (const b of c?.buildings ?? []) {
    const scene = b.interior?.scene;
    if (scene === undefined || e.sceneId === undefined || scene === e.sceneId) continue;
    const x = buildingInteriorEntity({ id: e.id, name: e.name, components: e.components }, e.sceneId, b);
    const t = x.components['transform'] as { position: number[] };
    out.push({
      id: x.id,
      name: x.name,
      parentId: null,
      kind: 'entity',
      active: true,
      visible: true,
      locked: true,
      static: true,
      keepLoaded: false,
      tags: 0,
      position: [...t.position],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ...(e.materials !== undefined ? { materials: e.materials } : {}),
      sceneId: scene,
      components: x.components,
    });
  }
  made.set(e, out);
  return out;
}

/**
 * The entities the Scene view draws: `visible` (the open scenes' objects)
 * and the interiors of buildings anywhere in `all` whose interior scene is
 * open. The same array when there are none.
 */
export function withSceneViewInteriors(visible: readonly ProjectedEntity[], all: readonly ProjectedEntity[], open: ReadonlySet<string>): readonly ProjectedEntity[] {
  let extra: ProjectedEntity[] | null = null;
  const taken = new Set<string>();
  for (const e of all) {
    if ((e.components['architecture'] as ArchitectureComponent | undefined)?.buildings === undefined || e.active === false) continue;
    for (const x of interiorsOf(e)) {
      if (!open.has(x.sceneId!) || taken.has(x.id)) continue;
      taken.add(x.id);
      (extra ??= []).push(x);
    }
  }
  return extra === null ? visible : [...visible, ...extra];
}

/** Furnishing lights made from one architecture object, kept while the object and the table stay the same. */
const lit = new WeakMap<ProjectedEntity, { table: ArchitectureStyles; lights: ProjectedEntity[] }>();

function lightsOf(e: ProjectedEntity, table: ArchitectureStyles): ProjectedEntity[] {
  const known = lit.get(e);
  if (known !== undefined && known.table === table) return known.lights;
  const lights = furnishingLightsOf({ id: e.id, name: e.name, active: e.active, components: e.components }, table).map((l): ProjectedEntity => {
    const x = furnishingLightEntity({ id: e.id, name: e.name, components: e.components }, l);
    const light = x.components['light'] as LightComponent;
    return {
      id: x.id,
      name: x.name,
      parentId: e.id,
      kind: 'light',
      active: true,
      visible: true,
      locked: true,
      static: true,
      keepLoaded: false,
      tags: 0,
      position: [...l.position],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      light,
      ...(e.sceneId !== undefined ? { sceneId: e.sceneId } : {}),
      components: x.components,
    };
  });
  lit.set(e, { table, lights });
  return lights;
}

/**
 * The entities the Scene view draws with buildings' furnishing lights added
 * (as the build adds them: within each scene's budget of point and spot
 * lights). The same array when there are none.
 */
export function withSceneViewLights(entities: readonly ProjectedEntity[], table: ArchitectureStyles): readonly ProjectedEntity[] {
  let extra: ProjectedEntity[] | null = null;
  const used = new Map<string, number>();
  const local = (e: ProjectedEntity): boolean => e.light?.type === 'point' || e.light?.type === 'spot';
  for (const e of entities) if (local(e)) used.set(e.sceneId ?? '', (used.get(e.sceneId ?? '') ?? 0) + 1);
  for (const e of entities) {
    if ((e.components['architecture'] as ArchitectureComponent | undefined)?.buildings === undefined || e.active === false) continue;
    for (const l of lightsOf(e, table)) {
      const scene = e.sceneId ?? '';
      if ((used.get(scene) ?? 0) >= MAX_LOCAL_LIGHTS) break;
      used.set(scene, (used.get(scene) ?? 0) + 1);
      (extra ??= []).push(l);
    }
  }
  return extra === null ? entities : [...entities, ...extra];
}
