/**
 * The scene rules checked before Play and the export, not per command.
 *
 * An edit goes through intermediate states (a camera deleted before its
 * replacement is made, a player moved between scenes), so rules about what a
 * game needs to start are checked when it starts: Play (and the export)
 * writes each problem as one Problems line, and a refusing problem stops the
 * start with that line. The commands keep only the rules a single document
 * must always hold.
 *
 * Pure: the documents in, the problems out.
 */
import { effectiveEntityFlags } from './hierarchy-v3';
import type { ContentCatalogV4, SceneEntityV3, SceneV4 } from './types-v3';
import { isFolderEntity } from './types-v3';
import type { BlockLayerComponent, BlockType } from './block-layers';
import { blockKitNames } from './block-kit';

export interface PlayCheck {
  /** Stable code (Problems line kind). */
  code: 'view_missing' | 'player_scene' | 'kept_twice' | 'kept_ignored' | 'collider_model' | 'block_names_missing' | 'lights_dropped';
  /** True: the start is refused; false: a warning (the game starts). */
  refuse: boolean;
  message: string;
}

/** The objects a scene puts in the game (folders and inactive objects, with everything under them, are left out). */
function inGame(entities: readonly SceneEntityV3[]): SceneEntityV3[] {
  const out = new Set<string>();
  const byId = new Map(entities.map((e) => [e.id, e]));
  const isIn = (e: SceneEntityV3): boolean => {
    for (let cur: SceneEntityV3 | undefined = e, guard = 0; cur !== undefined && guard <= entities.length; guard += 1) {
      if (cur.active === false) return false;
      cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
    }
    return true;
  };
  for (const e of entities) if (!isFolderEntity(e) && isIn(e)) out.add(e.id);
  return entities.filter((e) => out.has(e.id));
}

/**
 * The problems of a start: `startScenes` are the scenes the game starts with
 * (the project's start scenes, or a test start's).
 */
export function playChecks(content: ContentCatalogV4 | Record<string, unknown>, scenes: readonly SceneV4[], startScenes: readonly string[]): PlayCheck[] {
  const checks: PlayCheck[] = [];
  const start = new Set(startScenes);
  const started = scenes.filter((s) => start.has(s.sceneId));
  // A view exists: an enabled virtual camera in the scenes the game starts with (else the default pose shows).
  const shot = started.some((s) => inGame(s.entities).some((e) => {
    const vc = (e.components as { virtualCamera?: { enabled?: boolean } }).virtualCamera;
    return vc !== undefined && vc.enabled !== false;
  }));
  // Any number of player controllers share the view (local co-op). A player's
  // physics body is made when the game starts: a scene loaded later cannot bring one.
  for (const s of scenes) {
    if (start.has(s.sceneId)) continue;
    const ps = inGame(s.entities).filter((e) => (e.components as { controller?: unknown }).controller !== undefined).map((e) => `"${e.id}"`);
    if (ps.length > 0) checks.push({ code: 'player_scene', refuse: false, message: `scene "${s.sceneId}" holds the player controller${ps.length > 1 ? 's' : ''} ${ps.slice(0, 4).join(', ')}, but the game does not start with it: loading it while the game runs is refused (put the players in a start scene and keep them loaded)` });
  }
  // A kept object is one object: its id in two scenes would be two copies.
  const keptIn = new Map<string, string>();
  for (const s of scenes) {
    const flags = effectiveEntityFlags(s.entities);
    for (const e of s.entities) {
      const f = flags.get(e.id);
      if (f?.keepIgnored === true) checks.push({ code: 'kept_ignored', refuse: false, message: `"${e.id}" (scene "${s.sceneId}") keeps loaded under "${String(e.parentId)}", which does not: it goes with its parent (keep the parent, or move it to the scene's root)` });
      if (f?.keepLoaded !== true || isFolderEntity(e)) continue;
      const other = keptIn.get(e.id);
      if (other !== undefined && other !== s.sceneId) checks.push({ code: 'kept_twice', refuse: true, message: `"${e.id}" keeps loaded in scene "${other}" and in scene "${s.sceneId}": a kept object is one object (give one of them another id)` });
      else keptIn.set(e.id, s.sceneId);
    }
  }
  // A block layer's cut-aways, kits and walk name its regions (rooms drawn on it included) and kits its block types have
  // (a region renamed or deleted since, or a kit no type has any more, cuts or swaps nothing).
  const kitNames = new Set(blockKitNames((content as { blockTypes?: readonly BlockType[] }).blockTypes ?? []));
  for (const s of scenes) {
    const regionsOf = new Map(((s as { blocks?: readonly { entityId: string; regions?: readonly { regionId: string }[] }[] }).blocks ?? []).map((b) => [b.entityId, new Set((b.regions ?? []).map((r) => r.regionId))]));
    // Rooms drawn on a layer are regions its cut-aways may name (each storey: the outline's id, `-s<storey>` above the ground),
    // buildings' too. A building's floor plan names its rooms `<building>-r<n>` when the scene loads (how many: its program's),
    // so any such name of a planned building counts as a room.
    type Outline = { id: string; path: { closed?: boolean }; storeys?: number; program?: string };
    const roomsOf = new Map<string, { ids: Set<string>; planned: string[] }>();
    for (const e of s.entities) {
      const a = (e.components as { architecture?: { layer?: string; outlines?: readonly Outline[]; buildings?: readonly Outline[] } }).architecture;
      if (a?.layer === undefined) continue;
      let have = roomsOf.get(a.layer);
      if (have === undefined) roomsOf.set(a.layer, (have = { ids: new Set(), planned: [] }));
      for (const o of [...(a.outlines ?? []), ...(a.buildings ?? [])]) {
        if (o.path.closed === true) for (let k = 0; k < (o.storeys ?? 1); k++) have.ids.add(k === 0 ? o.id : `${o.id}-s${k}`);
        if (o.program !== undefined) have.planned.push(`${o.id}-r`);
      }
    }
    const isRoom = (rooms: { ids: Set<string>; planned: string[] } | undefined, r: string): boolean => rooms !== undefined && (rooms.ids.has(r) || rooms.planned.some((p) => r.startsWith(p) && /^\d+(-s\d+)?$/.test(r.slice(p.length))));
    for (const e of inGame(s.entities)) {
      const bl = (e.components as { blockLayer?: BlockLayerComponent }).blockLayer;
      if (bl === undefined) continue;
      const have = regionsOf.get(e.id) ?? new Set<string>();
      const rooms = roomsOf.get(e.id);
      const cut = (bl.cutaway?.regions ?? []).flatMap((r) => [r.region, ...(r.when !== undefined ? [r.when] : [])]).filter((r) => !isRoom(rooms, r));
      const named = [...cut, ...(bl.kits ?? []).flatMap((k) => (k.region !== undefined ? [k.region] : [])), ...(bl.walk?.from !== undefined ? [bl.walk.from] : [])];
      const missing = [...new Set(named.filter((r) => !have.has(r)))];
      if (missing.length > 0) checks.push({ code: 'block_names_missing', refuse: false, message: `block layer "${e.id}" (scene "${s.sceneId}") names ${missing.length === 1 ? 'a region it does not have' : 'regions it does not have'}: ${missing.slice(0, 4).map((r) => `"${r}"`).join(', ')} (renamed or deleted?): its cut-aways, kits and walk check there cut, swap and check nothing` });
      const kits = [...new Set((bl.kits ?? []).map((k) => k.kit).filter((k) => !kitNames.has(k)))];
      if (kits.length > 0) checks.push({ code: 'block_names_missing', refuse: false, message: `block layer "${e.id}" (scene "${s.sceneId}") shows ${kits.length === 1 ? 'a kit' : 'kits'} no block type has: ${kits.slice(0, 4).map((k) => `"${k}"`).join(', ')}: nothing is swapped` });
    }
  }
  if (!shot) {
    checks.push({
      code: 'view_missing',
      refuse: false,
      message: `no camera is live when the game starts (no enabled virtual camera in ${startScenes.length === 1 ? `the start scene "${startScenes[0]}"` : 'the start scenes'}): the view holds the default pose until a script enables one or a scene with one loads`,
    });
  }
  return checks;
}
