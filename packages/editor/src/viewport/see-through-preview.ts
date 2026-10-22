/**
 * The Scene view's See-through preview: level builders see what Play's
 * see-through will thin while they edit, with the project's settings and one
 * subject (the selection when it is something a camera would follow, else
 * the scene's camera target). It is the view's own state: nothing is saved,
 * and the project's setting stays what Play and the export use.
 */
import { SEE_THROUGH_DEFAULTS, type SeeThroughSettings } from '@thirdlight/runtime';
import type { SceneAdapter } from '@thirdlight/three-adapter';

import type { ProjectedEntity } from '../session/projection';

/** Components that make an entity part of the level (a floor, a building, a field of instances), never a subject. */
const LEVEL_PARTS = ['blockLayer', 'terrain', 'instances', 'architecture', 'virtualCamera', 'decal'] as const;

function levelPart(e: ProjectedEntity): boolean {
  return LEVEL_PARTS.some((k) => e.components[k] !== undefined);
}

/**
 * Whether the selection is something to fade round: a box, a model or a
 * character, or an object whose children draw one (a prefab's root); not a
 * light, a camera, a folder or a piece of the level.
 */
function suitable(e: ProjectedEntity, entities: readonly ProjectedEntity[]): boolean {
  if (levelPart(e) || e.kind === 'light' || e.kind === 'folder') return false;
  if (e.kind === 'box' || e.kind === 'model' || e.controller === true) return true;
  const kids = new Map<string, ProjectedEntity[]>();
  for (const c of entities) if (c.parentId !== null) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
  const open = [...(kids.get(e.id) ?? [])];
  for (let c = open.pop(); c !== undefined; c = open.pop()) {
    if ((c.kind === 'box' || c.kind === 'model') && !levelPart(c)) return true;
    open.push(...(kids.get(c.id) ?? []));
  }
  return false;
}

/**
 * What Play's camera would follow: the target of the enabled virtual camera
 * with the highest priority (the first on a tie) that names one in the scene.
 */
function cameraTarget(entities: readonly ProjectedEntity[]): string | null {
  const ids = new Set(entities.map((e) => e.id));
  let best: { priority: number; target: string } | null = null;
  for (const e of entities) {
    const cam = e.components['virtualCamera'] as { enabled?: unknown; priority?: unknown; target?: unknown } | undefined;
    if (cam === undefined || cam.enabled === false || typeof cam.target !== 'string' || !ids.has(cam.target)) continue;
    const priority = typeof cam.priority === 'number' ? cam.priority : 0;
    if (best === null || priority > best.priority) best = { priority, target: cam.target };
  }
  return best?.target ?? null;
}

/** The preview's subject: the selection when suitable, else the camera's target (null: none, nothing fades). */
export function previewSubject(selectedId: string | null, entities: readonly ProjectedEntity[]): string | null {
  const sel = selectedId === null ? undefined : entities.find((e) => e.id === selectedId);
  if (sel !== undefined && suitable(sel, entities)) return sel.id;
  return cameraTarget(entities);
}

/** The preview's state and what was last handed to the adapter. */
export class SeeThroughPreview {
  private on = false;
  private settings: SeeThroughSettings = { ...SEE_THROUGH_DEFAULTS };
  private applied = '';
  private stamped = '';

  /** Turn the preview on or off, with the project's settings (its own on/off is the preview's). */
  set(on: boolean, settings: Readonly<SeeThroughSettings>): void {
    this.on = on;
    this.settings = { ...settings };
  }

  /** Hand the adapter the preview when it changed (`fresh`: a new adapter, which starts off). Returns whether it did. */
  apply(adapter: SceneAdapter, selectedId: string | null, entities: readonly ProjectedEntity[], fresh = false): boolean {
    const subject = this.on ? previewSubject(selectedId, entities) : null;
    const key = JSON.stringify([this.on, this.settings, subject]);
    if (key === this.applied && !fresh) return false;
    if (fresh && !this.on) {
      this.applied = key;
      return false;
    }
    this.applied = key;
    adapter.seeThrough?.().set({ ...this.settings, enabled: this.on, subjects: subject === null ? [] : [subject] });
    return true;
  }

  /** The view's see-through after a frame, on the canvas (`data-see-through`; tests read it). */
  stamp(root: HTMLElement, adapter: SceneAdapter): void {
    const d = adapter.seeThrough?.().diagnostics();
    const mark = d === undefined ? '' : JSON.stringify({ enabled: d.enabled, armed: d.armed, subjects: d.subjects.map((s) => ({ id: s.id, fade: Math.round(s.fade * 100) / 100 })) });
    if (mark === this.stamped) return;
    this.stamped = mark;
    root.setAttribute('data-see-through', mark);
  }
}
