/**
 * A view's see-through as the game's scripts leave it (`ctx.camera.setSeeThrough`):
 * the project's settings with each call's fields over them, and the subjects
 * (entity ids; null: the camera's target).
 *
 * Simulation state, not the renderer's: it travels with the resolved view
 * (`CameraViewInfo.seeThrough`), so the page, the simulation worker, a replay
 * and the export draw from the same calls in the same steps. Until a script
 * calls, the view carries nothing and the renderer keeps the project's own
 * settings (so a game that never calls draws, and digests, as before).
 */
import { seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/project-model';

/** What a script set: the settings now and the subjects. */
export interface SeeThroughScriptState {
  readonly settings: Readonly<SeeThroughSettings>;
  /** Entity ids faded round (null: the live camera's target). */
  readonly subjects: readonly string[] | null;
}

/** `ctx.camera.setSeeThrough`'s argument: any of the settings, and the subjects. */
export interface SeeThroughScriptPatch extends Partial<SeeThroughSettings> {
  /** Entity ids to fade round (any number: the renderer keeps the nearest its arrays hold); null or empty: back to the camera's target. */
  subjects?: readonly string[] | null;
}

export class SeeThroughScript {
  private state: SeeThroughScriptState | null = null;

  constructor(private readonly project: Readonly<SeeThroughSettings>) {}

  /**
   * Apply a script's call. False (nothing changed) for an argument that is
   * not an object, a field of the wrong type, or subjects that are neither
   * null nor a list of ids; numbers are kept within their limits.
   */
  set(patch: unknown): boolean {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const p = patch as Record<string, unknown>;
    if (p['enabled'] !== undefined && typeof p['enabled'] !== 'boolean') return false;
    for (const k of ['radius', 'softness', 'maxFade', 'depthMargin', 'fadeTime'] as const) {
      const v = p[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false;
    }
    const subjects = p['subjects'];
    if (subjects !== undefined && subjects !== null && !(Array.isArray(subjects) && subjects.every((s) => typeof s === 'string' && s.length > 0))) return false;
    const base = this.state ?? { settings: this.project, subjects: null };
    this.state = Object.freeze({
      settings: Object.freeze(seeThroughSettingsOf(p, base.settings)),
      // No names (null, or an empty list, what an unwired graph input gives) is the camera's target.
      subjects: subjects === undefined ? base.subjects : subjects === null || (subjects as string[]).length === 0 ? null : Object.freeze([...new Set(subjects as string[])]),
    });
    return true;
  }

  /** The state a script left (null: no call yet this run). */
  current(): SeeThroughScriptState | null {
    return this.state;
  }

  /** A new run: back to the project's settings. */
  reset(): void {
    this.state = null;
  }
}
