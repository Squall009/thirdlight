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
import type { ContentCatalogV4, SceneEntityV3, SceneV4 } from './types-v3';
import { isFolderEntity } from './types-v3';

export interface PlayCheck {
  /** Stable code (Problems line kind). */
  code: 'view_missing';
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
export function playChecks(_content: ContentCatalogV4 | Record<string, unknown>, scenes: readonly SceneV4[], startScenes: readonly string[]): PlayCheck[] {
  const checks: PlayCheck[] = [];
  const start = new Set(startScenes);
  const started = scenes.filter((s) => start.has(s.sceneId));
  // A view exists: an enabled virtual camera in the scenes the game starts with (else the default pose shows).
  const shot = started.some((s) => inGame(s.entities).some((e) => {
    const vc = (e.components as { virtualCamera?: { enabled?: boolean } }).virtualCamera;
    return vc !== undefined && vc.enabled !== false;
  }));
  if (!shot) {
    checks.push({
      code: 'view_missing',
      refuse: false,
      message: `no camera is live when the game starts (no enabled virtual camera in ${startScenes.length === 1 ? `the start scene "${startScenes[0]}"` : 'the start scenes'}): the view holds the default pose until a script enables one or a scene with one loads`,
    });
  }
  return checks;
}
