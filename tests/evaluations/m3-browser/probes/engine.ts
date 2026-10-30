/**
 * Probe B — the production engine stack in a real browser.
 *
 * Exercises the pinned production packages exactly as the play/export hosts do
 * (no re-implementation): `@thirdlight/physics-rapier` (real Rapier WASM, its
 * init config built from a scene by the runtime's `physics3DConfigOf`),
 * `@thirdlight/three-adapter/gltf-loader` (pinned GLTFLoader port) over a
 * committed fixture GLB, three's AnimationMixer crossfade over the real clips,
 * and `@thirdlight/input`'s action evaluator for the movement/jump key path.
 *
 * The page is served under the production preview-origin CSP
 * (`default-src 'none'; script-src 'self'; connect-src 'self'; …`) so a
 * WebAssembly/CSP incompatibility is observed here, not in a later build.
 */
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier';
import { createActionEvaluator, DEFAULT_INPUT_CONFIG } from '@thirdlight/input';
import { physics3DConfigOf } from '@thirdlight/runtime';
import * as THREE from 'three';

interface Results {
  [key: string]: unknown;
}

const R: Results = {};
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${String(e.reason)}`));
(window as unknown as { __probe: Results }).__probe = R;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

void (async () => {
  // 1. Bare WebAssembly under the page CSP (isolates CSP from Rapier).
  try {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const module = await WebAssembly.compile(wasm);
    R['wasmCompile'] = WebAssembly.Module.exports(module).length >= 0 ? 'ok' : 'ok';
  } catch (e) {
    R['wasmCompile'] = `blocked: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 2. Production Rapier port: real WASM init + a real course step.
  try {
    const at = (x: number, y: number) => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    const config = physics3DConfigOf(
      [
        { id: 'player', components: { transform: at(3, 0.91), controller: {} } },
        { id: 'floor', components: { transform: at(0, -0.25), collider: { shape: { type: 'box', hx: 8, hy: 0.25, hz: 2 } } } },
        { id: 'wall', components: { transform: at(6, 1.5), collider: { shape: { type: 'box', hx: 0.25, hy: 1.5, hz: 2 } } } },
      ],
      { gravity_y: -19.62, max_slope_climb_deg: 45, min_slope_slide_deg: 30 },
    );
    if (config === null) throw new Error('the probe scene made no physics config');
    const created = await createPhysicsPort3D(config);
    R['physicsOk'] = created.ok;
    if (!created.ok) {
      R['physicsError'] = created.error;
    } else {
      const port = created.port;
      R['physicsImplementation'] = port.implementation;
      const dt = 1 / 120;
      // A minimal controller integration (as the character controller drives the port):
      // vertical velocity is owned by the caller, the port applies the delta.
      let vy = 0;
      let airborne = false;
      let last = port.step();
      const stepOnce = (moveX: number, jump: boolean): void => {
        const grounded = last.grounded === true;
        if (jump && grounded) {
          vy = 7;
          airborne = true;
        }
        if (grounded && !airborne) vy = 0;
        else {
          vy += -19.62 * dt;
          if (vy < -30) vy = -30;
        }
        if (airborne && grounded && vy <= 0) airborne = false;
        port.stageCharacterMove({ x: moveX * 4 * dt, y: vy * dt, z: 0 });
        last = port.step();
      };
      for (let i = 0; i < 12; i += 1) stepOnce(0, false);
      R['settleLast'] = { grounded: last.grounded, position: last.position };
      const trace: unknown[] = [];
      for (let i = 0; i < 48; i += 1) {
        stepOnce(1, i === 0);
        if (i % 12 === 0 || i === 47) trace.push({ step: i, x: last.position?.x, y: last.position?.y, grounded: last.grounded, vy });
      }
      R['moveTrace'] = trace;
      R['diagnostics'] = port.diagnostics?.() ?? null;
      port.dispose();
      R['physicsDisposed'] = true;
    }
  } catch (e) {
    R['physicsThrow'] = e instanceof Error ? e.message : String(e);
  }

  // 3. Production GLTFLoader port over a committed fixture GLB (real bytes).
  let clipNames: string[] = [];
  try {
    const res = await fetch('./tiny-v2.glb');
    const bytes = new Uint8Array(await res.arrayBuffer());
    R['glbBytes'] = bytes.length;
    R['glbSha256'] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const port = createGltfLoaderPort();
    const loaded = await port.load(bytes, {
      signal: new AbortController().signal,
      descriptor: { assetId: 'asset-probe', version: 1, sourceDigest: 'x'.repeat(64), sourceByteLength: bytes.length },
    });
    R['glbLoaded'] = true;
    clipNames = loaded.animations.map((c) => c.name);
    R['glbClipNames'] = clipNames;
    R['glbClipCount'] = loaded.animations.length;
    R['glbOwnership'] = loaded.ownership ?? null;
    const instance = loaded.createInstance();
    R['glbInstanceChildren'] = instance.children.length;
    const scene = new THREE.Scene();
    scene.add(instance);

    // 4. Rigid clip crossfade through the real mixer on the loaded instance.
    //    No committed fixture carries two clips (tiny-v1/v2 each carry one), so
    //    the two crossfaded clips are empty probe clips built with three's own
    //    clip API: this isolates the mixer/crossfade *mechanics* (weight
    //    interpolation, per-instance mixer) from clip binding. The role-mapped
    //    multi-clip GLB is covered by the animation-roles tests.
    {
      const instance2 = loaded.createInstance();
      const idle = new THREE.AnimationClip('probe-idle', 1, []);
      const airborne = new THREE.AnimationClip('probe-airborne', 1, []);
      const mixer = new THREE.AnimationMixer(instance2);
      const a = mixer.clipAction(idle);
      const b = mixer.clipAction(airborne);
      a.play();
      b.play();
      // three's fadeIn multiplies the action's base weight by the scheduled
      // interpolant, so both actions keep base weight 1 (setEffectiveWeight(0)
      // would pin the incoming action to 0 forever).
      mixer.update(0.2);
      const startWeights = [a.weight, b.weight];
      a.crossFadeTo(b, 0.3, false);
      mixer.update(0.15);
      const midWeights = [a.getEffectiveWeight(), b.getEffectiveWeight()];
      mixer.update(0.25);
      const endWeights = [a.getEffectiveWeight(), b.getEffectiveWeight()];
      // A second, independent instance + mixer must not share action state.
      const instance3 = loaded.createInstance();
      const otherMixer = new THREE.AnimationMixer(instance3);
      const c = otherMixer.clipAction(idle);
      c.play();
      otherMixer.update(0.1);
      R['mixerCrossfade'] = {
        clips: [idle.name, airborne.name],
        startWeights,
        midWeights,
        endWeights,
        mixerTime: mixer.time,
        otherMixerTime: otherMixer.time,
        independentOtherWeight: c.getEffectiveWeight(),
        instanceChildren: [instance.children.length, instance2.children.length, instance3.children.length],
      };
      R['rigidAnimationProfileFeasible'] = endWeights[1] > 0.9 && endWeights[0] < 0.1;
      mixer.stopAllAction();
      mixer.uncacheRoot(instance2);
      otherMixer.stopAllAction();
      otherMixer.uncacheRoot(instance3);
    }
    loaded.dispose();
    R['glbDisposed'] = true;
  } catch (e) {
    R['glbError'] = e instanceof Error ? e.message : String(e);
  }

  // 5. Production input mapping (movement and jump from the default bindings).
  try {
    const frame = (keys: string[], buttons: number[] = [], axis0 = 0): unknown =>
      createActionEvaluator(DEFAULT_INPUT_CONFIG).sample({ keys: new Set(keys), pressedKeys: new Set(), gamepad: { buttons: Array.from({ length: 17 }, (_, i) => buttons.includes(i)), axes: [axis0, 0, 0, 0] } });
    R['inputRight'] = frame(['KeyD']);
    R['inputSpaceHeld'] = frame(['Space']);
    R['inputEnter'] = frame(['Enter']);
    R['inputGamepadButton'] = frame([], [0]);
    R['inputGamepadAxis'] = frame([], [], 0.9);
  } catch (e) {
    R['inputError'] = e instanceof Error ? e.message : String(e);
  }

  await sleep(50);
  R['errors'] = errors;
  (window as unknown as { __done: boolean }).__done = true;
})();
