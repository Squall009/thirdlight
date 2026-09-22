/**
 * Packet 53 — the runtime role selector and the bounded crossfade
 * (presentation.md §41.3.6/§41.3.7/§41.9; acceptance B14).
 *
 * A `createAnimationRoleController(instance, view)` controller drives ONE
 * `ModelInstance`'s rigid-node animation from the committed game state:
 *
 *   - one `THREE.AnimationMixer` per instance, rooted at the instance holder
 *     (rule 5: independent pose/mixer per copy — no global mixer, no shared
 *     action, no shared clock);
 *   - three `THREE.AnimationAction`s (one per role), installed by
 *     `setRoles(roles, version)` after the §41.3.2 stage 3 / stage 5–6
 *     re-check against the LOADED clips (rule 7: a mismatching mapping is
 *     the hard `animation_role_unresolved`, never a fallback);
 *   - the fixed role selection of rule 3 (airborne iff !grounded; run iff
 *     speed > RUN_SPEED_EPS; else idle) from the committed view the host
 *     passes in — the selector reads `Runtime.getGameView()` facts only
 *     (gameplay.md §6 C41-1), never authoring state, never input;
 *   - the bounded 0.2 s crossfade of rule 4 (`crossFadeTo`, `warp = false`),
 *     host-driven: `update(deltaSeconds)` is called once per rendered frame
 *     with the real frame delta (0 ≤ delta ≤ 0.25); this module installs no
 *     `requestAnimationFrame`, no timer, no mixer listener and reads no
 *     clock;
 *   - no physics writes, no second loop, no root motion (rule 6): the
 *     controller writes only mixer time and action weights; entity
 *     transforms stay owned by the adapter's transform sync.
 *
 * The controller is tracked by its instance: `ModelInstance.dispose()`
 * disposes it exactly once (presentation.md §41.6 ownership table — the
 * mixer row; the controller's own `dispose()` is idempotent, rule 8, and
 * safe mid-blend).
 */
import * as THREE from 'three';
import { adapterError, type AdapterError } from './errors';
import { roleControllerAttachError, trackRoleController, untrackRoleController } from './visual';
import type { ModelInstance } from './visual';

// ---- Contract constants (presentation.md §41.3.6/§41.7.1 — fixed, not authored) ----

/** Rule 3: `run` iff committed `speed > RUN_SPEED_EPS` m/s. */
export const RUN_SPEED_EPS = 0.05;

/** Rule 4 / §41.7.1: the bounded crossfade duration (seconds). */
export const ANIMATION_CROSSFADE_SECONDS = 0.2;

/** Rule 2: `update(deltaSeconds)` accepts `0 ≤ deltaSeconds ≤ 0.25`. */
export const ANIMATION_MAX_DELTA_SECONDS = 0.25;

// ---- Types ----

export type AnimationRoleName = 'idle' | 'run' | 'airborne';

/** The fixed role order (canonical; deterministic first-failure order). */
export const ANIMATION_ROLES: readonly AnimationRoleName[] = ['idle', 'run', 'airborne'];

/** §41.3.1 one committed role binding (the `AnimationRoleBinding` shape). */
export interface AnimationRoleBindingInput {
  readonly clipIndex: number;
  readonly clipName: string;
}

/** §41.3.1 the committed mapping: exactly these three keys, all required. */
export interface AnimationRolesInput {
  readonly idle: AnimationRoleBindingInput;
  readonly run: AnimationRoleBindingInput;
  readonly airborne: AnimationRoleBindingInput;
}

/** The committed motion facts the selector reads (gameplay.md §6, C41-1). */
export interface AnimationRoleMotion {
  readonly speed: number;
  readonly grounded: boolean;
}

/**
 * The committed view slice the selector consumes (presentation.md §41.3.7):
 * the host reads it from `Runtime.getGameView()` (`stepIndex` +
 * `playerMotion`) and passes it in — the controller never references the
 * runtime itself, never samples input and never writes any transform
 * (rule 1). `stepIndex` is what `state()` reports as the last committed step
 * the selector consumed.
 */
export interface AnimationRoleView {
  readonly stepIndex: number;
  readonly playerMotion: AnimationRoleMotion;
}

export interface AnimationRoleState {
  readonly role: AnimationRoleName;
  readonly weights: { readonly idle: number; readonly run: number; readonly airborne: number };
  /** true while a crossfade is in progress */
  readonly blending: boolean;
  /** the committed step the selector last consumed (-1: none yet) */
  readonly stepIndex: number;
}

export interface AnimationRoleController {
  /** Validate and install the committed mapping against this instance's clips. */
  setRoles(roles: AnimationRolesInput, version: number): { ok: true } | { ok: false; error: AdapterError };
  /** One host-driven advance; the host owns the frame loop. */
  update(deltaSeconds: number): { ok: true } | { ok: false; error: AdapterError };
  state(): AnimationRoleState;
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true } | { readonly ok: false; readonly error: AdapterError };
}

// ---- Pure helpers (exported for the named B14 checklist and the fixture replay) ----

/**
 * Rule 3 — the fixed role selection (no tuning key): `airborne` iff
 * `!grounded`; else `run` iff `speed > RUN_SPEED_EPS`; else `idle`. A pure
 * function of the committed view: the same view yields the same role.
 */
export function selectAnimationRole(motion: AnimationRoleMotion): AnimationRoleName {
  if (!motion.grounded) return 'airborne';
  if (motion.speed > RUN_SPEED_EPS) return 'run';
  return 'idle';
}

/**
 * Rule 4 — the incoming role's weight at fade time `t` (0 ≤ t ≤ 0.2) in the
 * clean two-action case; the outgoing role's weight is `1 − this`. Clamped
 * to [0, 1]; non-finite input yields the start weight 0.
 */
export function crossfadeIncomingWeight(t: number, duration: number = ANIMATION_CROSSFADE_SECONDS): number {
  if (!Number.isFinite(t) || !Number.isFinite(duration) || duration <= 0) return 0;
  if (t <= 0) return 0;
  if (t >= duration) return 1;
  return t / duration;
}

/** One bounded validation failure (no clip data beyond the clip list's names). */
export type AnimationRoleValidationFailure =
  | { readonly stage: 'version'; readonly detail: string }
  | { readonly stage: 'range' | 'name' | 'ambiguous'; readonly role: AnimationRoleName; readonly detail: string };

/**
 * Rule 7 / §41.3.2 stage 3 + stage 5–6 re-check: validate the committed
 * mapping against the clips of the loaded version.
 *
 * - `version` must equal the loaded version (stale-load guard: a mapping
 *   recorded against a different version is not this instance's mapping —
 *   "the runtime loads the new version against the new mapping", §41.3.4
 *   rule 6; authored bytes stay pinned during active play);
 * - each role's `clipIndex` must index the loaded clip list (stage 3);
 * - each binding's `clipName` must equal the loaded clip's real name
 *   (stage 5);
 * - no clip name may match more than one loaded clip (stage 6).
 *
 * Stage 4 (no two roles share a `clipIndex`) is a version-independent
 * property of the mapping, committed and validated at publication; the
 * loaded clips never participate in it. Deterministic order: the role order
 * `idle` → `run` → `airborne`, the first failing role wins. `null` = valid.
 */
export function validateAnimationRoles(
  roles: AnimationRolesInput,
  clips: readonly { readonly index: number; readonly name: string }[],
  version: number,
  loadedVersion: number,
): AnimationRoleValidationFailure | null {
  if (typeof version !== 'number' || !Number.isInteger(version) || version !== loadedVersion) {
    return {
      stage: 'version',
      detail: `the committed mapping names version ${String(version)} but this instance loaded version ${loadedVersion}`,
    };
  }
  for (const role of ANIMATION_ROLES) {
    const binding = roles[role];
    const index = binding === undefined || typeof binding !== 'object' ? undefined : (binding as { clipIndex?: unknown }).clipIndex;
    if (
      binding === undefined ||
      typeof binding !== 'object' ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= clips.length
    ) {
      return {
        stage: 'range',
        role,
        detail: `role '${role}' has no valid binding: clipIndex must be an integer in 0..${Math.max(0, clips.length - 1)}`,
      };
    }
    const name = (binding as { clipName?: unknown }).clipName;
    const clipName = clips[index]?.name ?? '';
    if (typeof name !== 'string' || name !== clipName) {
      return {
        stage: 'name',
        role,
        detail: `role '${role}' clipName '${String(name)}' does not equal the loaded clip name '${clipName}' at index ${index}`,
      };
    }
    const matches = clips.filter((c) => c.name === name).length;
    if (matches > 1) {
      return {
        stage: 'ambiguous',
        role,
        detail: `role '${role}' clipName '${name}' matches ${matches} loaded clips`,
      };
    }
  }
  return null;
}

// ---- The controller ----

/**
 * Create one role controller for one model instance (presentation.md
 * §41.3.6; §41.9 root-subpath addition). `view` is the host-owned committed
 * view accessor (the `Runtime.getGameView()` slice of §41.3.7); the
 * controller never owns a clock, a loop or a runtime reference. The
 * controller is tracked by the instance: `ModelInstance.dispose()` disposes
 * it exactly once, and creating one for a disposed instance is
 * `asset_disposed`.
 */
export function createAnimationRoleController(
  instance: ModelInstance,
  view: () => AnimationRoleView,
): { readonly ok: true; readonly controller: AnimationRoleController } | { readonly ok: false; readonly error: AdapterError } {
  const bad = roleControllerAttachError(instance);
  if (bad !== null) return { ok: false, error: bad };
  const controller = createRoleController(instance, view);
  trackRoleController(instance, controller);
  return { ok: true, controller };
}

function createRoleController(
  instance: ModelInstance,
  view: () => AnimationRoleView,
): AnimationRoleController {
  let mixer: THREE.AnimationMixer | null = null;
  let actions: Partial<Record<AnimationRoleName, THREE.AnimationAction>> = {};
  let installed = false;
  let current: AnimationRoleName | null = null;
  let fadeRemaining = 0;
  let lastStepIndex = -1;
  let disposed = false;

  function releaseActions(): void {
    if (mixer !== null) {
      for (const role of ANIMATION_ROLES) {
        const action = actions[role];
        if (action !== undefined) {
          try {
            action.stop();
            mixer.uncacheAction(action.getClip());
          } catch {
            /* best effort: a disposal failure must not throw across the edge */
          }
        }
      }
    }
    actions = {};
  }

  const controller: AnimationRoleController = {
    setRoles(roles, version) {
      if (disposed) return { ok: false, error: adapterError('asset_disposed', 'the role controller is disposed') };
      const failure = validateAnimationRoles(roles, instance.clips(), version, instance.descriptor.version);
      if (failure !== null) {
        const detail = failure.stage === 'version' ? failure.detail : `role '${failure.role}': ${failure.detail}`;
        return { ok: false, error: adapterError('animation_role_unresolved', detail) };
      }
      const anims = instance.animationClips();
      if (mixer === null) mixer = new THREE.AnimationMixer(instance.root);
      releaseActions();
      for (const role of ANIMATION_ROLES) {
        const clip = anims[roles[role].clipIndex];
        if (clip === undefined) {
          // Unreachable after the re-check above; defensive: no action for a
          // binding the clip list cannot satisfy.
          return {
            ok: false,
            error: adapterError('animation_role_unresolved', `role '${role}' clipIndex ${roles[role].clipIndex} is outside the loaded clip list`),
          };
        }
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        actions[role] = action;
      }
      installed = true;
      fadeRemaining = 0;
      // A re-install (e.g. the new mapping after a reimport lands on this
      // instance) starts clean: the next `update` re-selects and activates
      // the role at full weight (a stale `current` would keep referencing
      // the actions this call just released).
      current = null;
      // The current role is (re-)selected at the next `update` from the
      // committed view; the install itself starts no fade and plays nothing
      // (frame ordering: step → onFrame update → render, runtime.md §6).
      return { ok: true };
    },

    update(deltaSeconds) {
      if (disposed) return { ok: false, error: adapterError('asset_disposed', 'the role controller is disposed') };
      if (
        typeof deltaSeconds !== 'number' ||
        !Number.isFinite(deltaSeconds) ||
        deltaSeconds < 0 ||
        deltaSeconds > ANIMATION_MAX_DELTA_SECONDS
      ) {
        return {
          ok: false,
          error: adapterError('preview_invalid', `update requires a finite delta in [0, ${ANIMATION_MAX_DELTA_SECONDS}] seconds`),
        };
      }
      if (!installed || mixer === null) {
        // No valid mapping installed (absent or rejected): the host renders
        // statically and does not run gameplay (rule 7) — no mixer activity.
        return { ok: true };
      }
      const v = view();
      if (v !== null && typeof v === 'object') {
        const stepIndex = v.stepIndex;
        if (typeof stepIndex === 'number' && Number.isFinite(stepIndex)) lastStepIndex = Math.trunc(stepIndex);
        const motion = v.playerMotion as AnimationRoleMotion | undefined;
        const target =
          motion !== undefined && typeof motion === 'object' && motion !== null
            ? selectAnimationRole({
                speed: typeof motion.speed === 'number' ? motion.speed : 0,
                grounded: motion.grounded !== false,
              })
            : 'idle';
        const m = mixer;
        if (current === null) {
          // First advance: activate the selected role at full weight, no fade.
          // The non-target actions are only `stop()`-ed: a stopped action is
          // not blended, and its nominal weight must stay 1 so a later
          // crossfade back to it ramps 0→1 (three scales the fade by the
          // nominal weight — zeroing it here would keep that role at 0 forever).
          for (const role of ANIMATION_ROLES) {
            const action = actions[role];
            if (action === undefined) continue;
            if (role === target) {
              action.setEffectiveWeight(1);
              action.play();
            } else {
              action.stop();
            }
          }
          current = target;
          fadeRemaining = 0;
        } else if (target !== current) {
          // Rule 4: one bounded crossfade (0.2 s, warp = false). A change
          // while blending retargets the fade: the previous incoming action
          // becomes the outgoing one (`crossFadeTo` schedules it from its
          // current weight).
          const outgoing = actions[current];
          const incoming = actions[target];
          if (outgoing !== undefined && incoming !== undefined) {
            outgoing.crossFadeTo(incoming, ANIMATION_CROSSFADE_SECONDS, false);
            incoming.play();
          }
          current = target;
          fadeRemaining = ANIMATION_CROSSFADE_SECONDS;
        }
        m.update(deltaSeconds);
        if (fadeRemaining > 0) fadeRemaining = Math.max(0, fadeRemaining - deltaSeconds);
      }
      return { ok: true };
    },

    state() {
      const weights: { idle: number; run: number; airborne: number } = { idle: 0, run: 0, airborne: 0 };
      if (installed && !disposed) {
        for (const role of ANIMATION_ROLES) {
          const action = actions[role];
          if (action === undefined) continue;
          const w = action.isRunning() ? action.getEffectiveWeight() : 0;
          weights[role] = typeof w === 'number' && Number.isFinite(w) ? w : 0;
        }
      }
      return {
        role: disposed ? 'idle' : (current ?? 'idle'),
        weights,
        blending: !disposed && fadeRemaining > 0,
        stepIndex: disposed ? -1 : lastStepIndex,
      };
    },

    dispose() {
      if (disposed) return { ok: true, alreadyDisposed: true };
      disposed = true;
      // Rule 8: safe mid-blend — stop and uncache the actions and release the
      // mixer exactly once; the instance's dispose path disposes this same
      // controller too (idempotence makes the double path a no-op).
      releaseActions();
      if (mixer !== null) {
        try {
          mixer.stopAllAction();
          mixer.uncacheRoot(instance.root);
        } catch {
          /* best effort */
        }
        mixer = null;
      }
      installed = false;
      current = null;
      fadeRemaining = 0;
      lastStepIndex = -1;
      untrackRoleController(instance, controller);
      return { ok: true };
    },
  };
  return controller;
}
