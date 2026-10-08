/**
 * The scenes a game page reads ahead, so they load at once when the game
 * asks: the next entry of the shell's scene list, the interiors behind the
 * doors near the camera (buildings whose interiors are scenes of their own,
 * nearest first: an interior is made while its door is approached, so the
 * game's transition through the door shows it whole), and the targets of
 * the loaded scenes' transitions. Named again whenever the scene set or
 * the listed scene changes, and every few frames while doors are near.
 */
import { architectureDoorLinks, type ArchitectureComponent, type Runtime, type SceneSetView } from '@thirdlight/runtime';

import type { ScenePreloader } from './scene-preload';

/** Metres from the camera within which a door's interior scene is read ahead and made. */
export const BUILDING_READ_AHEAD_METRES = 50;
/** Frames between looks at which doors are near (the camera moves; the scene set rarely changes). */
const DOOR_LOOK_FRAMES = 15;

type DoorEntity = { readonly id: string; readonly components?: { readonly architecture?: ArchitectureComponent; readonly transform?: { readonly position?: readonly number[] } } };

/** The interiors' doors of the loaded scenes: where each stands and the scene behind it. */
function doorsOf(set: SceneSetView): { x: number; z: number; scene: string }[] {
  const out: { x: number; z: number; scene: string }[] = [];
  for (const b of set.batches) {
    for (const e of b.entities as readonly DoorEntity[]) {
      const c = e.components?.architecture;
      if (c?.buildings === undefined || c.interiorOf !== undefined) continue;
      for (const l of architectureDoorLinks(e.id, c, e.components?.transform?.position ?? [0, 0, 0])) out.push({ x: l.position[0], z: l.position[2], scene: l.to.scene });
    }
  }
  return out;
}

/** The scenes worth reading ahead: the listed scene's next, the interiors behind `doors` (nearest first), then the transitions' targets. */
export function scenesToReadAhead(set: SceneSetView, listed: readonly { readonly scene: string }[] | undefined, listedIndex: number, doors: readonly string[] = []): string[] {
  const out: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id === 'string' && set.status[id] === 'unloaded' && !out.includes(id)) out.push(id);
  };
  if (listed !== undefined && listed.length > 0) add(listed[Math.max(0, listedIndex + 1)]?.scene);
  for (const id of doors) add(id);
  for (const b of set.batches) {
    for (const e of b.entities as readonly { components?: { trigger?: { sceneTransition?: { scene?: unknown } } } }[]) add(e.components?.trigger?.sceneTransition?.scene);
  }
  for (const e of set.spawned as readonly { components?: { trigger?: { sceneTransition?: { scene?: unknown } } } }[]) add(e.components?.trigger?.sceneTransition?.scene);
  return out;
}

/** What a page's read-ahead looks at once a frame (`service`). */
export function createReadAhead(preload: ScenePreloader | undefined, listed: readonly { readonly scene: string }[] | undefined): { service(rt: Runtime): void } {
  let readSet: unknown = null;
  let readListed = -2;
  let doors: { x: number; z: number; scene: string }[] = [];
  let near = '';
  let frames = 0;
  const eye: number[] = [0, 0, 0];
  const turn: number[] = [0, 0, 0, 1];
  return {
    service(rt) {
      if (preload === undefined) return;
      const set = rt.sceneSet?.();
      if (set === undefined) return;
      const listedIndex = rt.listedSceneIndex?.() ?? -1;
      const changed = set !== readSet || listedIndex !== readListed;
      if (changed) doors = doorsOf(set);
      frames += 1;
      if (!changed && (doors.length === 0 || frames < DOOR_LOOK_FRAMES)) return;
      frames = 0;
      // The doors within reach of the camera, nearest first.
      let nearDoors: string[] = [];
      if (doors.length > 0 && (rt.readCameraView?.(eye, turn) ?? null) !== null) {
        const r2 = BUILDING_READ_AHEAD_METRES * BUILDING_READ_AHEAD_METRES;
        nearDoors = doors
          .map((d) => ({ scene: d.scene, d: (d.x - eye[0]!) * (d.x - eye[0]!) + (d.z - eye[2]!) * (d.z - eye[2]!) }))
          .filter((d) => d.d <= r2)
          .sort((a, b) => a.d - b.d)
          .map((d) => d.scene);
      }
      const key = nearDoors.join('\u0000');
      if (!changed && key === near) return;
      readSet = set;
      readListed = listedIndex;
      near = key;
      preload.want(scenesToReadAhead(set, listed, listedIndex, nearDoors), set.status);
    },
  };
}
