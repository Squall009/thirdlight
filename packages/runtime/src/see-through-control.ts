/**
 * A view's see-through as the game's scripts leave it (`ctx.camera.setSeeThrough`):
 * the project's settings with each call's fields over them, and the subjects
 * (entity ids; null: the camera's target). Whether it is on is the live
 * camera's choice (its occlusion mode) until a script says `enabled`; a
 * script's `enabled` holds over every camera until it says `enabled: null`.
 *
 * Simulation state, not the renderer's: it travels with the resolved view
 * (`CameraViewInfo.seeThrough`), so the page, the simulation worker, a replay
 * and the export draw from the same calls in the same steps. Until a script
 * calls, the view carries nothing and the renderer keeps the project's own
 * settings (so a game that never calls draws, and digests, as before).
 */
import { SEE_THROUGH_FIELDS, SEE_THROUGH_NUMBER_FIELDS, seeThroughSettingsOf, type SeeThroughSettings } from '@thirdlight/project-model';

/** The fields a call may carry. */
const KNOWN: ReadonlySet<string> = new Set<string>([...SEE_THROUGH_FIELDS, 'subjects']);

/** What a script set: the settings now and the subjects. */
export interface SeeThroughScriptState {
  readonly settings: Readonly<SeeThroughSettings>;
  /** Entity ids faded round (null: the live camera's target). */
  readonly subjects: readonly string[] | null;
  /** On or off as a script said, over the live camera's occlusion mode (absent: the camera's). */
  readonly enabled?: boolean;
}

/** `ctx.camera.setSeeThrough`'s argument: any of the settings, and the subjects. */
export interface SeeThroughScriptPatch extends Partial<Omit<SeeThroughSettings, 'enabled'>> {
  /** On or off over every camera's choice; null: back to the live camera's occlusion mode. */
  enabled?: boolean | null;
  /** Entity ids to fade round (any number: the renderer keeps the nearest its arrays hold); null or empty: back to the camera's target. */
  subjects?: readonly string[] | null;
}

export class SeeThroughScript {
  private state: SeeThroughScriptState | null = null;

  constructor(private readonly project: Readonly<SeeThroughSettings>) {}

  /**
   * Apply a script's call. False (nothing changed) for an argument that is
   * not an object, carries no field or one it does not know (a typo), a
   * field of the wrong type, or subjects that are neither null nor a list of
   * ids; numbers are kept within their limits.
   */
  set(patch: unknown): boolean {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const p = patch as Record<string, unknown>;
    const keys = Object.keys(p);
    if (keys.length === 0 || keys.some((k) => !KNOWN.has(k))) return false;
    if (p['enabled'] !== undefined && p['enabled'] !== null && typeof p['enabled'] !== 'boolean') return false;
    for (const k of SEE_THROUGH_NUMBER_FIELDS) {
      const v = p[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false;
    }
    const subjects = p['subjects'];
    if (subjects !== undefined && subjects !== null && !(Array.isArray(subjects) && subjects.every((s) => typeof s === 'string' && s.length > 0))) return false;
    const base: SeeThroughScriptState = this.state ?? { settings: this.project, subjects: null };
    const enabled = p['enabled'] === null ? undefined : typeof p['enabled'] === 'boolean' ? p['enabled'] : base.enabled;
    this.state = Object.freeze({
      ...(enabled !== undefined ? { enabled } : {}),
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
