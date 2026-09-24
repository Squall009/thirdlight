/**
 * Packet 53 — the runtime role selector and the bounded crossfade
 * (presentation.md §41.3.6/§41.3.7/§41.9; acceptance B14).
 *
 * Runs in Node against the REAL `three@0.186.0` animation stack
 * (`AnimationMixer`/`AnimationAction`) over real, self-contained GLB bytes
 * (the pinned GLTFLoader-backed port — the same real-loader path as
 * `gltf-loader.test.ts`). Verified here: the fixed role selection (rule 3),
 * the crossfade weight law (rule 4), the stage 3 / stage 5–6 re-check and
 * the stale-load refusal (rule 7), one host-driven update per frame with the
 * bounded delta (rule 2), independent pose/mixer per copy (rule 5), no
 * transform writes (rule 6), and disposal while blending (rule 8).
 *
 * NOT verified here (no browser): rendered poses/pixels — the browser host
 * `tests/browser/m3-animation/m3-animation.browser.ts` names the rendered
 * B14 checklist (UNVERIFIED in-container).
 */
import { describe, expect, it } from 'vitest';
import {
  ANIMATION_CROSSFADE_SECONDS,
  RUN_SPEED_EPS,
  crossfadeIncomingWeight,
  createAnimationRoleController,
  selectAnimationRole,
  validateAnimationRoles,
  prepareVisualResource,
  suppliedBytes,
  type AnimationRoleController,
  type AnimationRoleMotion,
  type AnimationRoleView,
  type AnimationRolesInput,
  type ModelInstance,
  type PreparedVisualResource,
} from './index';
import { createGltfLoaderPort } from './gltf-loader';
import { buildGlb, descriptorFor } from './test-glb';

// ---- shared fixtures (the packet-41 role names, in stored order) ----

const CLIP_NAMES = ['Idle', 'Run', 'Airborne'] as const;
const REORDERED_NAMES = ['Airborne', 'Run', 'Idle'] as const;

/** The stored-order mapping (clipIndex i ⇒ clip i). */
const ROLES: AnimationRolesInput = {
  idle: { clipIndex: 0, clipName: 'Idle' },
  run: { clipIndex: 1, clipName: 'Run' },
  airborne: { clipIndex: 2, clipName: 'Airborne' },
};

/** One step of the host frame (the real frame delta the host owns). */
const DT = 0.016;

async function prepareResource(clipNames: readonly string[]): Promise<PreparedVisualResource> {
  const bytes = buildGlb({ clipNames: [...clipNames] });
  const handle = prepareVisualResource(
    suppliedBytes(descriptorFor(bytes, { assetId: 'asset-courier-0001', version: 1 }), bytes),
    { loader: createGltfLoaderPort() },
  );
  const result = await handle.result;
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}: ${result.error.message}`);
  return result.resource;
}

/**
 * A host-owned committed view slice (the `Runtime.getGameView()` facts,
 * §41.3.7): the tests commit `motion`/`step` the way a runtime commit does,
 * and the controller reads the current values through the accessor.
 */
function hostView(): { host: { motion: AnimationRoleMotion; step: number }; view: () => AnimationRoleView } {
  const host = { motion: { speed: 0, grounded: true } as AnimationRoleMotion, step: 0 };
  return { host, view: () => ({ stepIndex: host.step, playerMotion: host.motion }) };
}

let lastInstance: ModelInstance | null = null;

function controllerOf(resource: PreparedVisualResource, view: () => AnimationRoleView): AnimationRoleController {
  const made = resource.createInstance();
  if (!made.ok) throw new Error('expected an instance');
  lastInstance = made.instance;
  const c = createAnimationRoleController(made.instance, view);
  if (!c.ok) throw new Error(`expected a controller, got ${c.error.code}`);
  return c.controller;
}

function steps(controller: AnimationRoleController, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const out = controller.update(DT);
    if (!out.ok) throw new Error(`expected an ok update, got ${out.error.code}`);
  }
}

// ---- rule 3: the fixed role selection ----

describe('rule 3 — the fixed role selection (no tuning key)', () => {
  it('idle at rest', () => {
    expect(selectAnimationRole({ speed: 0, grounded: true })).toBe('idle');
  });
  it('the RUN_SPEED_EPS boundary is exclusive (speed === 0.05 ⇒ idle)', () => {
    expect(RUN_SPEED_EPS).toBe(0.05);
    expect(selectAnimationRole({ speed: 0.05, grounded: true })).toBe('idle');
  });
  it('run above the epsilon while grounded', () => {
    expect(selectAnimationRole({ speed: 0.0500001, grounded: true })).toBe('run');
    expect(selectAnimationRole({ speed: 2.5, grounded: true })).toBe('run');
  });
  it('airborne wins over speed (!grounded ⇒ airborne)', () => {
    expect(selectAnimationRole({ speed: 0, grounded: false })).toBe('airborne');
    expect(selectAnimationRole({ speed: 2.5, grounded: false })).toBe('airborne');
  });
});

// ---- rule 4: the crossfade weight law ----

describe('rule 4 — the crossfade weight law (t/0.2 over exactly 0.2 s)', () => {
  it('the contract constant is 0.2 s', () => {
    expect(ANIMATION_CROSSFADE_SECONDS).toBe(0.2);
  });
  it('the incoming weight is t/duration, clamped', () => {
    expect(crossfadeIncomingWeight(0)).toBe(0);
    expect(crossfadeIncomingWeight(0.05)).toBeCloseTo(0.25, 12);
    expect(crossfadeIncomingWeight(0.1)).toBeCloseTo(0.5, 12);
    expect(crossfadeIncomingWeight(0.2)).toBe(1);
    expect(crossfadeIncomingWeight(0.25)).toBe(1); // clamped past the fade
    expect(crossfadeIncomingWeight(-0.1)).toBe(0);
    expect(crossfadeIncomingWeight(Number.NaN)).toBe(0);
  });
});

// ---- rule 7: the stage 3 / stage 5–6 re-check (pure) ----

const CLIP_INFO = [
  { index: 0, name: 'Idle' },
  { index: 1, name: 'Run' },
  { index: 2, name: 'Airborne' },
];

describe('rule 7 — validateAnimationRoles (the stage 3 / stage 5–6 re-check)', () => {
  it('the stored-order mapping validates', () => {
    expect(validateAnimationRoles(ROLES, CLIP_INFO, 1, 1)).toBeNull();
  });
  it('a stale load is refused (the recorded version must equal the loaded version)', () => {
    const failure = validateAnimationRoles(ROLES, CLIP_INFO, 2, 1);
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error('unreachable');
    expect(failure.stage).toBe('version');
  });
  it('an out-of-range clipIndex is refused at stage 3 (first failing role wins)', () => {
    const failure = validateAnimationRoles(
      { ...ROLES, idle: { clipIndex: 3, clipName: 'Idle' } },
      CLIP_INFO,
      1,
      1,
    );
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error('unreachable');
    expect(failure).toMatchObject({ stage: 'range', role: 'idle' });
  });
  it('a clipName mismatch is refused at stage 5', () => {
    const failure = validateAnimationRoles(
      { ...ROLES, run: { clipIndex: 1, clipName: 'Walk' } },
      CLIP_INFO,
      1,
      1,
    );
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error('unreachable');
    expect(failure).toMatchObject({ stage: 'name', role: 'run' });
  });
  it('an ambiguous clip name is refused at stage 6', () => {
    const dupNames = [{ index: 0, name: 'Idle' }, { index: 1, name: 'Idle' }, { index: 2, name: 'Airborne' }];
    const failure = validateAnimationRoles(ROLES, dupNames, 1, 1);
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error('unreachable');
    expect(failure).toMatchObject({ stage: 'ambiguous', role: 'idle' });
  });
  it('a missing role key is refused (all three keys are required)', () => {
    const missing = { idle: ROLES.idle, run: ROLES.run } as unknown as AnimationRolesInput;
    const failure = validateAnimationRoles(missing, CLIP_INFO, 1, 1);
    expect(failure).not.toBeNull();
    if (failure === null) throw new Error('unreachable');
    expect(failure).toMatchObject({ stage: 'range', role: 'airborne' });
  });
});

// ---- the controller over the real three animation stack ----

describe('packet 53 — the role controller (real three@0.186.0 mixers, real GLB clips)', () => {
  it('installs the mapping and refuses the hard failures (rule 7)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { view } = hostView();
    const controller = controllerOf(resource, view);

    // Stale load: the mapping records version 2, the resource loaded version 1.
    const stale = controller.setRoles(ROLES, 2);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.error.code).toBe('animation_role_unresolved');

    // Name mismatch: the mapping claims clip 1 is 'Walk'.
    const mismatch = controller.setRoles({ ...ROLES, run: { clipIndex: 1, clipName: 'Walk' } }, 1);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('unreachable');
    expect(mismatch.error.code).toBe('animation_role_unresolved');

    // A rejected mapping installs nothing: the host renders statically
    // (update succeeds with no mixer activity; all weights stay 0).
    expect(controller.update(DT)).toEqual({ ok: true });
    const staticState = controller.state();
    expect(staticState.role).toBe('idle');
    expect(staticState.weights).toEqual({ idle: 0, run: 0, airborne: 0 });
    expect(staticState.blending).toBe(false);

    // The valid mapping installs (three actions, one per role).
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    steps(controller, 1);

    // setRoles on the disposed controller is asset_disposed.
    controller.dispose();
    const disposedSet = controller.setRoles(ROLES, 1);
    expect(disposedSet.ok).toBe(false);
    if (!disposedSet.ok) expect(disposedSet.error.code).toBe('asset_disposed');
    resource.dispose();
  });

  it('first advance selects the role at full weight, no fade; then the 0.2 s law (rule 4)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });

    // Committed motion: at rest (idle), step 3.
    host.step = 3;
    expect(controller.update(DT)).toEqual({ ok: true });
    const atRest = controller.state();
    expect(atRest.role).toBe('idle');
    expect(atRest.weights.idle).toBeGreaterThan(1 - 1e-6);
    expect(atRest.weights.run).toBeLessThan(1e-6);
    expect(atRest.weights.airborne).toBeLessThan(1e-6);
    expect(atRest.blending).toBe(false);
    expect(atRest.stepIndex).toBe(3);

    // Committed motion: running (speed 1.2 > 0.05, grounded) ⇒ the 0.2 s
    // crossfade. After each step the incoming weight follows t/0.2 (the
    // contract law, rule 4) and the outgoing is 1 − t/0.2.
    host.motion = { speed: 1.2, grounded: true };
    let elapsed = 0;
    for (let i = 0; i < 13; i += 1) {
      elapsed += DT;
      expect(controller.update(DT)).toEqual({ ok: true });
      const mid = controller.state();
      if (i < 12) {
        // Inside the fade (elapsed < 0.2): the law, with float tolerance.
        const expectedIn = crossfadeIncomingWeight(elapsed);
        expect(mid.blending).toBe(true);
        expect(mid.role).toBe('run');
        expect(mid.weights.run).toBeCloseTo(expectedIn, 6);
        expect(mid.weights.idle).toBeCloseTo(1 - expectedIn, 6);
      }
    }
    const done = controller.state();
    expect(done.blending).toBe(false);
    expect(done.role).toBe('run');
    expect(done.weights.run).toBeGreaterThan(1 - 1e-6);
    expect(done.weights.idle).toBeLessThan(1e-6);

    // Committed motion: airborne (!grounded) ⇒ the same bounded fade to
    // airborne (the previously outgoing action stays at 0).
    host.motion = { speed: 0, grounded: false };
    steps(controller, 13);
    const airborne = controller.state();
    expect(airborne.role).toBe('airborne');
    expect(airborne.weights.airborne).toBeGreaterThan(1 - 1e-6);
    expect(airborne.weights.run).toBeLessThan(1e-6);
    expect(airborne.blending).toBe(false);
    resource.dispose();
  });

  it('phase 15.3: the blend time is the project\'s animation_crossfade_s (0.5 s here; 0 s cuts)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const make = (seconds: number) => {
      const { host, view } = hostView();
      const made = resource.createInstance();
      if (!made.ok) throw new Error('expected an instance');
      const c = createAnimationRoleController(made.instance, view, seconds);
      if (!c.ok) throw new Error('expected a controller');
      expect(c.controller.setRoles(ROLES, 1)).toEqual({ ok: true });
      host.step = 1;
      steps(c.controller, 1); // idle at full weight
      host.motion = { speed: 1.2, grounded: true };
      return c.controller;
    };
    const slow = make(0.5);
    steps(slow, 30); // 0.25 s into a 0.5 s blend
    expect(slow.state().blending).toBe(true);
    expect(slow.state().weights.run).toBeCloseTo(crossfadeIncomingWeight(30 * DT, 0.5), 6);
    steps(slow, 31);
    expect(slow.state().blending).toBe(false);
    expect(slow.state().weights.run).toBeGreaterThan(1 - 1e-6);
    const cut = make(0);
    steps(cut, 1);
    expect(cut.state().blending).toBe(false);
    expect(cut.state().role).toBe('run');
    expect(cut.state().weights.run).toBeGreaterThan(1 - 1e-6);
    expect(cut.state().weights.idle).toBeLessThan(1e-6);
    resource.dispose();
  });

  it('a role change while blending retargets the fade (the previous incoming becomes the outgoing)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });

    host.step = 1;
    steps(controller, 1); // idle
    host.motion = { speed: 1.2, grounded: true };
    steps(controller, 5); // 0.08 s into idle→run
    expect(controller.state().blending).toBe(true);

    // Retarget mid-blend: run (the previous incoming) becomes the outgoing.
    host.motion = { speed: 0, grounded: false };
    steps(controller, 13); // 0.2 s after the retarget
    const done = controller.state();
    expect(done.role).toBe('airborne');
    expect(done.weights.airborne).toBeGreaterThan(1 - 1e-6);
    expect(done.weights.run).toBeLessThan(1e-6);
    expect(done.weights.idle).toBeLessThan(1e-6);
    expect(done.blending).toBe(false);
    resource.dispose();
  });

  it('the reordered-clip mapping is accepted against the reordered bytes (rule 7 / §41.3.4 rule 5)', async () => {
    const resource = await prepareResource(REORDERED_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    // The new mapping for the reordered stored order.
    const reorderedRoles: AnimationRolesInput = {
      idle: { clipIndex: 2, clipName: 'Idle' },
      run: { clipIndex: 1, clipName: 'Run' },
      airborne: { clipIndex: 0, clipName: 'Airborne' },
    };
    expect(controller.setRoles(reorderedRoles, 1)).toEqual({ ok: true });
    // The stored-order mapping now mismatches the reordered names.
    const staleMapping = controller.setRoles(ROLES, 1);
    expect(staleMapping.ok).toBe(false);
    if (!staleMapping.ok) expect(staleMapping.error.code).toBe('animation_role_unresolved');
    // Re-install the correct mapping (setRoles replaces the actions).
    expect(controller.setRoles(reorderedRoles, 1)).toEqual({ ok: true });
    host.step = 2;
    steps(controller, 1);
    const atRest = controller.state();
    expect(atRest.role).toBe('idle');
    expect(atRest.weights.idle).toBeGreaterThan(1 - 1e-6);
    resource.dispose();
  });

  it('update rejects the delta outside [0, 0.25] (rule 2)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { view } = hostView();
    const controller = controllerOf(resource, view);
    for (const delta of [-0.1, 0.26, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = controller.update(delta);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe('preview_invalid');
    }
    // 0 and 0.25 are accepted.
    expect(controller.update(0)).toEqual({ ok: true });
    expect(controller.update(0.25)).toEqual({ ok: true });
    resource.dispose();
  });

  it('independent pose/mixer per copy: two instances of one resource run different roles (rule 5)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const a = hostView();
    const b = hostView();
    const controllerA = controllerOf(resource, a.view);
    const madeB = resource.createInstance();
    if (!madeB.ok) throw new Error('expected an instance');
    const cB = createAnimationRoleController(madeB.instance, b.view);
    if (!cB.ok) throw new Error('expected a controller');
    const controllerB = cB.controller;
    expect(controllerA.setRoles(ROLES, 1)).toEqual({ ok: true });
    expect(controllerB.setRoles(ROLES, 1)).toEqual({ ok: true });

    // A: at rest (idle). B: running — different committed views, same resource.
    a.host.step = 1;
    b.host.step = 1;
    b.host.motion = { speed: 2.0, grounded: true };
    steps(controllerA, 1);
    steps(controllerB, 1);
    expect(controllerA.state().role).toBe('idle');
    expect(controllerB.state().role).toBe('run');

    // Drive B through a full fade to airborne; A's committed view never
    // changes. B's weight change must never touch A (one mixer per copy).
    b.host.motion = { speed: 0, grounded: false };
    for (let i = 0; i < 13; i += 1) {
      steps(controllerB, 1);
      const aState = controllerA.state();
      expect(aState.role).toBe('idle');
      expect(aState.weights.idle).toBeGreaterThan(1 - 1e-6);
      expect(aState.weights.run).toBeLessThan(1e-6);
      expect(aState.weights.airborne).toBeLessThan(1e-6);
    }
    const bState = controllerB.state();
    expect(bState.role).toBe('airborne');
    expect(bState.weights.airborne).toBeGreaterThan(1 - 1e-6);
    resource.dispose();
  });

  it('writes no transform: the holder pose is untouched by the controller (rule 6)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const made = resource.createInstance();
    if (!made.ok) throw new Error('expected an instance');
    const instance = made.instance;
    const { host, view } = hostView();
    const c = createAnimationRoleController(instance, view);
    if (!c.ok) throw new Error('expected a controller');
    const controller = c.controller;
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    const before = {
      position: instance.root.position.x,
      y: instance.root.position.y,
      z: instance.root.position.z,
      qx: instance.root.quaternion.x,
      qy: instance.root.quaternion.y,
      qz: instance.root.quaternion.z,
      qw: instance.root.quaternion.w,
      sx: instance.root.scale.x,
      sy: instance.root.scale.y,
      sz: instance.root.scale.z,
    };
    host.step = 1;
    steps(controller, 1); // idle
    host.motion = { speed: 1.2, grounded: true };
    steps(controller, 13); // run
    host.motion = { speed: 0, grounded: false };
    steps(controller, 13); // airborne
    // The holder (the entity-level Group) keeps exactly the pose the adapter
    // last wrote — the clip animates the GLB's internal nodes, never the holder.
    expect(instance.root.position.x).toBe(before.position);
    expect(instance.root.position.y).toBe(before.y);
    expect(instance.root.position.z).toBe(before.z);
    expect(instance.root.quaternion.x).toBe(before.qx);
    expect(instance.root.quaternion.y).toBe(before.qy);
    expect(instance.root.quaternion.z).toBe(before.qz);
    expect(instance.root.quaternion.w).toBe(before.qw);
    expect(instance.root.scale.x).toBe(before.sx);
    expect(instance.root.scale.y).toBe(before.sy);
    expect(instance.root.scale.z).toBe(before.sz);
    resource.dispose();
  });

  it('is host-driven: state is unchanged between explicit updates (no clock, no loop, rule 2)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    host.step = 4;
    steps(controller, 1);
    const once = controller.state();
    const twice = controller.state();
    expect(twice).toEqual(once);
    resource.dispose();
  });

  it('dispose while blending is safe and idempotent (rule 8)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    host.step = 1;
    steps(controller, 1); // idle
    host.motion = { speed: 1.2, grounded: true };
    steps(controller, 3); // mid-blend
    expect(controller.state().blending).toBe(true);

    expect(controller.dispose()).toEqual({ ok: true });
    expect(controller.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    // A disposed controller refuses further work and reports a zero state.
    const after = controller.update(DT);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('asset_disposed');
    const state = controller.state();
    expect(state.role).toBe('idle');
    expect(state.weights).toEqual({ idle: 0, run: 0, airborne: 0 });
    expect(state.blending).toBe(false);
    expect(state.stepIndex).toBe(-1);
    resource.dispose();
  });

  it('the instance dispose releases the tracked controller exactly once (§41.6 mixer row)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    host.step = 1;
    steps(controller, 1);
    // The instance's dispose path disposes the tracked controller.
    const instance = lastInstance;
    if (instance === null) throw new Error('unreachable');
    expect(instance.dispose()).toEqual({ ok: true });
    const after = controller.update(DT);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('asset_disposed');
    // The controller's own dispose is already consumed by the instance.
    expect(controller.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    // A second instance of the same resource stays fully usable (§41.6 rule 2).
    const other = resource.createInstance();
    expect(other.ok).toBe(true);
    if (other.ok) {
      const otherController = createAnimationRoleController(other.instance, view);
      expect(otherController.ok).toBe(true);
      if (otherController.ok) {
        expect(otherController.controller.setRoles(ROLES, 1)).toEqual({ ok: true });
        expect(otherController.controller.update(DT)).toEqual({ ok: true });
      }
    }
    resource.dispose();
  });

  it('a re-install after role changes starts clean (the next update re-selects the role)', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const { host, view } = hostView();
    const controller = controllerOf(resource, view);
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    host.step = 1;
    steps(controller, 1); // idle
    host.motion = { speed: 1.2, grounded: true };
    steps(controller, 13); // the fade completes: run
    expect(controller.state().role).toBe('run');
    // A re-install (the host's replace path when a reimport's new mapping
    // lands on this instance) must not keep the stale current role: the
    // next update re-selects the role from the committed view at full weight.
    expect(controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    host.step = 2;
    steps(controller, 1);
    const st = controller.state();
    expect(st.role).toBe('run');
    expect(st.weights.run).toBeGreaterThan(1 - 1e-6);
    expect(st.blending).toBe(false);
    resource.dispose();
  });

  it('creating a role controller for a disposed instance is asset_disposed', async () => {
    const resource = await prepareResource(CLIP_NAMES);
    const made = resource.createInstance();
    if (!made.ok) throw new Error('expected an instance');
    expect(made.instance.dispose()).toEqual({ ok: true });
    const { view } = hostView();
    const out = createAnimationRoleController(made.instance, view);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('asset_disposed');
    resource.dispose();
  });
});