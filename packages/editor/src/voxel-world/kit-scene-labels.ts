/**
 * The kit test scene's labels on the slice page: one tag a exhibit (role,
 * case id, run section) over its centre cell, placed on the screen each
 * frame from the camera. The labels come from the same pure generator the
 * backend's `writeKitTestScene` command runs (@thirdlight/voxel
 * `kitTestScene`), so the page names the cases without reading anything
 * back; the derive decides what is drawn under them. Tags farther than
 * {@link LABEL_RANGE_M} or behind the camera are hidden, so a grid of
 * fifty exhibits stays readable up close.
 */
import * as THREE from 'three';
import { kitTestScene, VOXEL_SIZE_M, WORLD_RULES, type KitTestLabel } from '@thirdlight/voxel';

/** Tags farther from the camera than this are hidden (metres). */
const LABEL_RANGE_M = 30;

export interface KitSceneLabels {
  /** Places the tags for this frame; `o` is the floating origin in cells. */
  update(camera: THREE.Camera, o: { x: number; y: number; z: number }): void;
  /** How many tags are on the screen now. */
  shown(): number;
  /** Takes the tags off the page. */
  remove(): void;
}

export function createKitSceneLabels(labels: readonly KitTestLabel[], parent: HTMLElement): KitSceneLabels {
  const tags = labels.map((l) => {
    const el = document.createElement('div');
    el.textContent = `${l.roleName} · ${l.caseId}`;
    el.style.cssText = 'position:fixed;left:0;top:0;transform:translate(-50%,-100%);padding:1px 4px;background:rgba(20,20,30,.75);color:#fff;font:11px/1.3 system-ui,sans-serif;white-space:nowrap;pointer-events:none;border-radius:3px;display:none';
    parent.append(el);
    return { el, cell: l.cell };
  });
  const p = new THREE.Vector3();
  let shown = 0;
  return {
    update(camera, o) {
      shown = 0;
      for (const t of tags) {
        // Above the exhibit's centre cell, camera-relative like everything drawn.
        p.set((t.cell[0] + 0.5 - o.x) * VOXEL_SIZE_M, (t.cell[1] + 2.6 - o.y) * VOXEL_SIZE_M, (t.cell[2] + 0.5 - o.z) * VOXEL_SIZE_M);
        const far = p.distanceTo(camera.position) > LABEL_RANGE_M;
        p.project(camera);
        if (far || p.z < -1 || p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) {
          t.el.style.display = 'none';
          continue;
        }
        t.el.style.display = 'block';
        t.el.style.left = `${((p.x + 1) / 2) * innerWidth}px`;
        t.el.style.top = `${((1 - p.y) / 2) * innerHeight}px`;
        shown++;
      }
    },
    shown: () => shown,
    remove() {
      for (const t of tags) t.el.remove();
      tags.length = 0;
    },
  };
}

/**
 * The page's kit test scene: `write` sends the command (its answer is the
 * page's edit timing) and labels the scene's exhibits, once a page;
 * `fromParam` reads `?kitScene=x,y,z,material`; `clear` takes the labels
 * away (an undo of the scene leaves them, as they are not world data).
 */
export function kitSceneHooks<T>(send: (args: { origin: number[]; material: number }) => Promise<T>, parent: HTMLElement) {
  let labels: KitSceneLabels | null = null;
  const write = (at: readonly [number, number, number], material: number): Promise<T> => {
    labels ??= createKitSceneLabels(kitTestScene(WORLD_RULES, { origin: at, material }).labels, parent);
    return send({ origin: [...at], material });
  };
  return {
    write,
    async fromParam(param: string | null): Promise<void> {
      const v = param?.split(',').map(Number);
      if (v !== undefined && v.length === 4 && v.every(Number.isInteger)) await write([v[0]!, v[1]!, v[2]!], v[3]!);
    },
    update: (camera: THREE.Camera, o: { x: number; y: number; z: number }): void => labels?.update(camera, o),
    shown: (): number => labels?.shown() ?? 0,
    clear(): void {
      labels?.remove();
      labels = null;
    },
  };
}
