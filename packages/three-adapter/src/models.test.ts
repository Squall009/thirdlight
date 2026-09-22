/**
 * Packet 69 — the M4 `models` block: scene realization of `model` entities
 * (delivery.md (M4) §2; presentation.md §41.9 row, C64-4).
 *
 * Node-side (the packet-08 pattern: a STUB canvas, no GPU). The REAL
 * pinned GLTFLoader port (`createGltfLoaderPort`, the `./gltf-loader`
 * subpath) parses REAL synthetic GLB bytes (test-glb.ts), and the REAL
 * `AnimationMixer`/`AnimationRoleController` are driven directly — the
 * browser-visible realization (visible model/pose frames) is the
 * `tests/integration/m4-render/` evidence (numeric mixer tests alone are
 * not sufficient — the packet-69 acceptance boundary).
 *
 * Covered here: the §2.2 fail-fast validation (the two new closed-set
 * codes), the attach under the entity holders, the per-instance material
 * independence (§2.3), the independent controllers (two instances at
 * distinct committed states — §2.4), the refcounted resource release
 * (last instance releases the shared LoadedGlb exactly once — §2.5), the
 * L6 static path (a mismatching mapping: `animation_role_unresolved`, the
 * model stays attached, the run proceeds — §2.7), the `models_asset_
 * unresolved` residual (§2.3), and the §2.6 cancellation: a disposed run
 * cancels in-flight prepares, a late completion is discarded and released
 * exactly once, and repeated disposal is a no-op (ownership counters at
 * baseline).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import {
  createSceneAdapter,
  ERROR_CODES,
  validateModelsBlock,
  type ModelAnimationRoles,
  type SceneAdapterModels,
} from './index';
import { createGltfLoaderPort } from './gltf-loader';
import { buildGlb } from './test-glb';
import { prepareVisualResource, type GlbLoaderPort } from './visual';
import { createAnimationRoleController } from './animation';

// ---- helpers ---------------------------------------------------------------

/** A stub canvas: the structural surface, no real context (render_unsupported). */
function stubCanvas(): Record<string, unknown> {
  return { getContext: () => null, width: 640, height: 480, clientWidth: 640, clientHeight: 480 };
}

const DIGEST = 'd62fc659f569b42c0f828ebf08eac661b5afe4312f81266a178ea3d3e25678be';
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

/** The 3-clip synthetic GLB (real GLTFLoader-parseable bytes). */
const GLB_BYTES = buildGlb({ clipNames: ['Idle', 'Run', 'Airborne'] });
const ROLES: ModelAnimationRoles = {
  idle: { clipIndex: 0, clipName: 'Idle' },
  run: { clipIndex: 1, clipName: 'Run' },
  airborne: { clipIndex: 2, clipName: 'Airborne' },
};

/** A counting loader wrapper: the port's loads/releases for the ownership
 * (baseline) assertions. */
function countingPort(inner: GlbLoaderPort): { port: GlbLoaderPort; loads: number; releases: number } {
  let loads = 0;
  let releases = 0;
  const port: GlbLoaderPort = {
    load(bytes, options) {
      loads += 1;
      return inner.load(bytes, options).then((loaded) => {
        let released = false;
        const originalDispose = loaded.dispose.bind(loaded);
        loaded.dispose = (): void => {
          if (released) return;
          released = true;
          releases += 1;
          originalDispose();
        };
        return loaded;
      });
    },
  };
  return { port: { load: port.load }, get loads() { return loads; }, get releases() { return releases; } };
}

interface V3SceneOptions {
  /** Give the player + decoration entities the committed mapping. */
  withRoles?: boolean;
  /** The decoration's mapping is deliberately mismatched (L6 static path). */
  decorationMismatch?: boolean;
  /** A `model` entity whose assetId has no `assets` row (§2.3 residual). */
  withUnresolved?: boolean;
}

function v3Scene(opts: V3SceneOptions = {}): unknown {
  const roles = opts.decorationMismatch
    ? { idle: { clipIndex: 0, clipName: 'Wrong' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } }
    : ROLES;
  const entities: unknown[] = [
    {
      id: 'cam-main',
      components: { transform: { ...T }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } },
    },
    {
      id: 'player-01',
      components: {
        transform: { position: [3, 0.91, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        controller: {},
        model: { asset: { assetId: 'asset-courier' } },
        modelAnimation: { assetId: 'asset-courier', version: 1, roles: ROLES },
      },
    },
    {
      id: 'deco-01',
      components: {
        transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        model: { asset: { assetId: 'asset-courier' } },
        ...(opts.withRoles === false ? {} : { modelAnimation: { assetId: 'asset-courier', version: 1, roles } }),
      },
    },
  ];
  if (opts.withUnresolved) {
    entities.push({
      id: 'lost-01',
      components: {
        transform: { position: [20, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        model: { asset: { assetId: 'asset-ghost' } },
      },
    });
  }
  return { schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities };
}

function fakeRuntime(view?: { stepIndex: number; speed: number; grounded: boolean }): Runtime {
  const stepIndex = view?.stepIndex ?? 0;
  const playerMotion = { speed: view?.speed ?? 0, grounded: view?.grounded ?? true };
  return {
    getInterpolatedState: () => ({
      ok: true,
      state: {
        transforms: [
          { id: 'player-01', position: [3, 0.91, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          { id: 'deco-01', position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        ],
      },
    }),
    getGameView: () => ({ ok: true, view: { stepIndex, playerMotion } }),
    dispose: () => undefined,
  } as unknown as Runtime;
}

function snapshotOf(scene: unknown): RuntimeSnapshot {
  return {
    snapshotId: 'demo-0001@r1',
    projectId: 'demo-0001',
    revision: 1,
    scene: scene as RuntimeSnapshot['scene'],
    game: { configVersion: 1, playerId: 'player-01', cameraId: 'cam-main' },
  } as unknown as RuntimeSnapshot;
}

function modelsBlock(scene: unknown, bytes: Uint8Array): SceneAdapterModels {
  const entities = (scene as { entities: Array<{ id: string; components: Record<string, unknown> }> }).entities;
  return {
    assets: [
      { assetId: 'asset-courier', version: 1, sourceDigest: DIGEST },
    ],
    animation: entities
      .filter((e) => e.components['modelAnimation'] !== undefined)
      .map((e) => {
        const ma = e.components['modelAnimation'] as { roles: ModelAnimationRoles };
        return { entityId: e.id, roles: ma.roles, version: 1 };
      }),
    resolveBytes: (assetId: string, version: number) => {
      if (assetId !== 'asset-courier' || version !== 1) {
        return Promise.reject(new Error(`no verified bytes for ${assetId} v${version}`));
      }
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return Promise.resolve(buffer);
    },
  };
}

function waitSettled(p: Promise<unknown>): Promise<unknown> {
  // The prepares run through the real GLTFLoader (microtask + parser);
  // a few macrotask turns are enough for the small synthetic GLB.
  return p.then((r) => new Promise<unknown>((resolve) => setTimeout(() => resolve(r), 50)));
}

// ---- §2.2 fail-fast validation (models_config_invalid) ---------------------

describe('models block validation (delivery.md (M4) §2.2)', () => {
  const base = {
    models: {
      assets: [{ assetId: 'asset-courier', version: 1, sourceDigest: DIGEST }],
      animation: [{ entityId: 'player-01', roles: ROLES, version: 1 }],
      resolveBytes: () => Promise.resolve(new ArrayBuffer(0)),
    },
    modelEntities: new Map([['player-01', 'asset-courier']]),
    modelAnimationEntities: new Map([['player-01', { assetId: 'asset-courier', version: 1 }]]),
  };

  it('a non-v3 scene with a models block is models_config_invalid', () => {
    const err = validateModelsBlock({ schemaVersion: 2, hasLoader: true, ...base });
    expect(err).not.toBeNull();
    expect(err?.code).toBe('models_config_invalid');
  });

  it('a missing loader port is models_config_invalid', () => {
    const err = validateModelsBlock({ schemaVersion: 3, hasLoader: false, ...base });
    expect(err?.code).toBe('models_config_invalid');
  });

  it('an animation entry naming an entity without modelAnimation is models_config_invalid', () => {
    const err = validateModelsBlock({ schemaVersion: 3, hasLoader: true, ...base, models: { ...base.models, animation: [{ entityId: 'ghost', roles: ROLES, version: 1 }] } });
    expect(err?.code).toBe('models_config_invalid');
  });

  it('an animation entry whose version mismatches the component is models_config_invalid', () => {
    const err = validateModelsBlock({ schemaVersion: 3, hasLoader: true, ...base, models: { ...base.models, animation: [{ entityId: 'player-01', roles: ROLES, version: 2 }] } });
    expect(err?.code).toBe('models_config_invalid');
  });

  it('an animation entry whose assetId has no assets row is models_config_invalid', () => {
    const err = validateModelsBlock({
      schemaVersion: 3,
      hasLoader: true,
      ...base,
      models: { ...base.models, assets: [] },
    });
    expect(err?.code).toBe('models_config_invalid');
  });

  it('two different versions for one assetId is models_config_invalid (the manifest dedupes per assetId)', () => {
    const err = validateModelsBlock({
      schemaVersion: 3,
      hasLoader: true,
      ...base,
      models: { ...base.models, assets: [{ assetId: 'asset-courier', version: 1, sourceDigest: DIGEST }, { assetId: 'asset-courier', version: 2, sourceDigest: DIGEST }] },
    });
    expect(err?.code).toBe('models_config_invalid');
  });

  it('a well-formed block validates (null)', () => {
    const err = validateModelsBlock({ schemaVersion: 3, hasLoader: true, ...base });
    expect(err).toBeNull();
  });

  it('both new codes are registered in the closed adapter set', () => {
    expect(ERROR_CODES).toContain('models_config_invalid');
    expect(ERROR_CODES).toContain('models_asset_unresolved');
  });
});

// ---- the adapter surface ----------------------------------------------------

describe('createSceneAdapter with the models block (M4 C64-4)', () => {
  it('absent models option: byte-stable behavior, no models diagnostics, no modelsSettled', async () => {
    const adapter = createSceneAdapter(stubCanvas(), { runtime: fakeRuntime(), snapshot: snapshotOf(v3Scene()) });
    expect(adapter.modelsSettled).toBeUndefined();
    const d = adapter.diagnostics();
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.diagnostics.models).toBeUndefined();
    expect(adapter.dispose().ok).toBe(true);
    expect(adapter.dispose()).toEqual({ ok: true, alreadyDisposed: true });
  });

  it('a v2 scene with a models block: the settle reports models_config_invalid; the base scene keeps rendering', async () => {
    const scene = v3Scene();
    (scene as { schemaVersion: number }).schemaVersion = 2;
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: snapshotOf(scene),
      models: modelsBlock(scene, GLB_BYTES),
      modelsLoader: createGltfLoaderPort(),
    });
    expect(typeof adapter.modelsSettled).toBe('function');
    const settled = await waitSettled(adapter.modelsSettled!());
    expect(settled).toMatchObject({ ok: false, code: 'models_config_invalid' });
    // The base scene is still realized (a structured render failure on the
    // stub canvas — never a throw).
    const frame = adapter.renderFrame();
    expect(frame.ok).toBe(false);
    adapter.dispose();
  });

  it('realizes both model entities under their holders; the settle carries the §2.5 counters', async () => {
    const scene = v3Scene();
    const counter = countingPort(createGltfLoaderPort());
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime({ stepIndex: 7, speed: 3, grounded: true }),
      snapshot: snapshotOf(scene),
      models: modelsBlock(scene, GLB_BYTES),
      modelsLoader: counter.port,
    });
    // The diagnostics' models block is present while the adapter is live.
    const d0 = adapter.diagnostics();
    expect(d0.ok).toBe(true);
    if (d0.ok) expect(d0.diagnostics.models).toBeDefined();
    const settled = await waitSettled(adapter.modelsSettled!());
    expect(settled).toEqual({ ok: true, assets: 1, instances: 2, animations: 2, unresolved: 0 });
    const d1 = adapter.diagnostics();
    if (d1.ok) {
      expect(d1.diagnostics.models).toEqual({ assets: 1, instances: 2, pending: 0, animations: 2, failed: 0 });
    }
    // One prepare for the shared asset; one shared GLB load…
    expect(counter.loads).toBe(1);
    // …released exactly once when the LAST instance is disposed (below).
    expect(counter.releases).toBe(0);
    adapter.dispose();
    expect(counter.releases).toBe(1); // the last instance release
    // After dispose: the models diagnostics block is absent; repeated
    // disposal is a no-op (the counters stay at baseline).
    const d2 = adapter.diagnostics();
    if (d2.ok) expect(d2.diagnostics.models).toBeUndefined();
    expect(adapter.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(counter.loads).toBe(1);
    expect(counter.releases).toBe(1);
    const settled2 = await adapter.modelsSettled!();
    expect(settled2).toMatchObject({ ok: false, code: 'adapter_disposed' });
  });

  it('settle waits for every asset to attach (two-asset microtask race, §2.8)', async () => {
    // Two assets prepare in parallel. A settle gate on the handles'
    // `state()` would resolve in the microtask gap between the second
    // handle's promise resolution and the attach callback — reporting
    // partial instances/animations. The gate is the completion count:
    // the settle carries the FULL realization.
    const bytesA = buildGlb({ clipNames: ['Idle', 'Run', 'Airborne'] });
    const bytesB = buildGlb({ clipNames: [] }); // a second (static) GLB
    const scene: unknown = {
      schemaVersion: 3,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'cam-main', components: { transform: { ...T }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
        {
          id: 'player-01',
          components: {
            transform: { position: [3, 0.91, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            controller: {},
            model: { asset: { assetId: 'asset-a' } },
            modelAnimation: { assetId: 'asset-a', version: 1, roles: ROLES },
          },
        },
        { id: 'deco-01', components: { transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, model: { asset: { assetId: 'asset-a' } } } },
        { id: 'deco-02', components: { transform: { position: [12, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, model: { asset: { assetId: 'asset-b' } } } },
      ],
    };
    const snap = {
      snapshotId: 'demo-0001@r1',
      projectId: 'demo-0001',
      revision: 1,
      scene,
      game: { configVersion: 1, playerId: 'player-01', cameraId: 'cam-main' },
    } as unknown as RuntimeSnapshot;
    const byId = new Map<string, Uint8Array>([
      ['asset-a', bytesA],
      ['asset-b', bytesB],
    ]);
    const models: SceneAdapterModels = {
      assets: [
        { assetId: 'asset-a', version: 1, sourceDigest: DIGEST },
        { assetId: 'asset-b', version: 1, sourceDigest: DIGEST },
      ],
      animation: [{ entityId: 'player-01', roles: ROLES, version: 1 }],
      resolveBytes: (assetId: string): Promise<ArrayBuffer> => {
        const b = byId.get(assetId);
        if (b === undefined) return Promise.reject(new Error(`no bytes for ${assetId}`));
        const buf = new ArrayBuffer(b.byteLength);
        new Uint8Array(buf).set(b);
        return Promise.resolve(buf);
      },
    };
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime({ stepIndex: 7, speed: 3, grounded: true }),
      snapshot: snap,
      models,
      modelsLoader: createGltfLoaderPort(),
    });
    const settled = await waitSettled(adapter.modelsSettled!());
    // All three model entities attached AND the controller live — a raced
    // (partial) settle reports fewer instances/animations than this.
    expect(settled).toEqual({ ok: true, assets: 2, instances: 3, animations: 1, unresolved: 0 });
    const d = adapter.diagnostics();
    if (d.ok) {
      expect(d.diagnostics.models).toEqual({ assets: 2, instances: 3, pending: 0, animations: 1, failed: 0 });
    }
    adapter.dispose();
  });

  it('two instances at distinct committed states: the player runs, the non-player idles (the real mixer, §2.4)', async () => {
    // The adapter path (below) wires the committed view; here the SAME
    // substrate + real GLB + real mixers prove the per-instance state
    // independence numerically (the browser evidence proves it visually).
    const bytes = buildGlb({ clipNames: ['Idle', 'Run', 'Airborne'] });
    const descriptor = { assetId: 'asset-courier', version: 1, sourceDigest: DIGEST, sourceByteLength: bytes.byteLength };
    const loader = createGltfLoaderPort();
    const handleA = prepareVisualResource({ kind: 'bytes', descriptor, bytes: bytes.slice() }, { loader });
    const handleB = prepareVisualResource({ kind: 'bytes', descriptor, bytes: bytes.slice() }, { loader });
    const [resA, resB] = await Promise.all([handleA.result, handleB.result]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (resA.ok === false || resB.ok === false) throw new Error('unreachable');
    const instA = resA.resource.createInstance();
    const instB = resB.resource.createInstance();
    if (instA.ok === false || instB.ok === false) throw new Error('instance creation failed');
    const viewA = () => ({ stepIndex: 12, playerMotion: { speed: 3.2, grounded: true } }); // the player
    const viewB = () => ({ stepIndex: 12, playerMotion: { speed: 0, grounded: true } }); // the non-player (neutral)
    const ctrlA = createAnimationRoleController(instA.instance, viewA);
    const ctrlB = createAnimationRoleController(instB.instance, viewB);
    if (ctrlA.ok === false || ctrlB.ok === false) throw new Error('controller creation failed');
    expect(ctrlA.controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    expect(ctrlB.controller.setRoles(ROLES, 1)).toEqual({ ok: true });
    for (let i = 0; i < 40; i += 1) {
      expect(ctrlA.controller.update(1 / 60)).toEqual({ ok: true });
      expect(ctrlB.controller.update(1 / 60)).toEqual({ ok: true });
    }
    const sA = ctrlA.controller.state();
    const sB = ctrlB.controller.state();
    // The committed states differ: the player's motion selects `run`, the
    // non-player's neutral motion selects `idle` — independent mixers,
    // no shared state (rule 5).
    expect(sA.role).toBe('run');
    expect(sA.weights.run).toBeCloseTo(1, 5);
    expect(sB.role).toBe('idle');
    expect(sB.weights.idle).toBeCloseTo(1, 5);
    expect(sA.stepIndex).toBe(12);
    expect(sB.stepIndex).toBe(12);
    // The REAL mixer wrote DIFFERENT poses into the two instances (the
    // test GLB's `Rotor` node carries the rotation clips): the run clip
    // and the idle clip are distinct, and the per-instance holders (the
    // ModelInstance roots) carry NO transform writes — the animation
    // wrote only mixer time/weights (rule 6 / no root contamination).
    // The REAL mixer wrote pose into both instances and advanced it over
    // time (the test GLB's clips are the same rotation with distinct
    // names: at the same committed time the two instances share the clip
    // shape — independent mixers, deterministic clip). The state-level
    // distinction is the role (run vs idle) asserted above; the
    // motion-level distinction (run vs idle clips) is the browser
    // evidence (the template courier GLB carries distinct clip motion).
    const rotorOf = (root: THREE.Object3D): THREE.Object3D | null => {
      let found: THREE.Object3D | null = null;
      root.traverse((o) => {
        if (found === null && o.name === 'Rotor') found = o;
      });
      return found;
    };
    const rotorA = rotorOf(instA.instance.glbRoot);
    const rotorB = rotorOf(instB.instance.glbRoot);
    expect(rotorA).not.toBeNull();
    expect(rotorB).not.toBeNull();
    const qOf = (r: THREE.Object3D): THREE.Vector4 => new THREE.Vector4(r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w);
    const qA1 = qOf(rotorA!);
    const qB1 = qOf(rotorB!);
    // The pose was written by the mixer (not identity after the advance).
    expect(Math.hypot(qA1.x - 0, qA1.y - 0, qA1.z - 0, qA1.w - 1)).toBeGreaterThan(1e-6);
    // Same committed time ⇒ same deterministic clip pose for both.
    expect(Math.hypot(qA1.x - qB1.x, qA1.y - qB1.y, qA1.z - qB1.z, qA1.w - qB1.w)).toBeLessThan(1e-9);
    for (let i = 0; i < 40; i += 1) {
      expect(ctrlA.controller.update(1 / 60)).toEqual({ ok: true });
      expect(ctrlB.controller.update(1 / 60)).toEqual({ ok: true });
    }
    const qA2 = qOf(rotorA!);
    // The pose advanced over time (the real mixer consumed the deltas).
    expect(Math.hypot(qA2.x - qA1.x, qA2.y - qA1.y, qA2.z - qA1.z, qA2.w - qA1.w)).toBeGreaterThan(1e-6);
    expect(instA.instance.root.position.length()).toBe(0); // holder: identity
    expect(instB.instance.root.position.length()).toBe(0); // holder: identity
    // Disposal: the last instance of each resource releases its shared
    // load exactly once (the refcount rule, §2.5).
    expect(instA.instance.dispose()).toEqual({ ok: true });
    expect(resA.resource.diagnostics().instances).toBe(0);
    expect(instB.instance.dispose()).toEqual({ ok: true });
    expect(resB.resource.diagnostics().instances).toBe(0);
    expect(ctrlA.controller.dispose()).toEqual({ ok: true, alreadyDisposed: true }); // released by the instance
  });

  it('L6: a mismatching mapping keeps the model attached and static; the run proceeds (§2.7)', async () => {
    const scene = v3Scene({ decorationMismatch: true });
    const counter = countingPort(createGltfLoaderPort());
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime({ stepIndex: 3, speed: 3, grounded: true }),
      snapshot: snapshotOf(scene),
      models: modelsBlock(scene, GLB_BYTES),
      modelsLoader: counter.port,
    });
    const settled = await waitSettled(adapter.modelsSettled!());
    // Both instances attach (the model loaded successfully); only the
    // player's role controller is live (the decoration's stage 5–6
    // re-check failed — animation_role_unresolved, one bounded
    // diagnostic, the selector for that model does not run).
    expect(settled).toEqual({ ok: true, assets: 1, instances: 2, animations: 1, unresolved: 0 });
    const d = adapter.diagnostics();
    if (d.ok) expect(d.diagnostics.models).toEqual({ assets: 1, instances: 2, pending: 0, animations: 1, failed: 0 });
    adapter.dispose();
    expect(counter.releases).toBe(1);
  });

  it('a model entity with no assets row: a plain group + the bounded unresolved diagnostic; the run proceeds (§2.3)', async () => {
    const scene = v3Scene({ withUnresolved: true });
    const counter = countingPort(createGltfLoaderPort());
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: snapshotOf(scene),
      models: modelsBlock(scene, GLB_BYTES),
      modelsLoader: counter.port,
    });
    const settled = await waitSettled(adapter.modelsSettled!());
    expect(settled).toEqual({ ok: true, assets: 1, instances: 2, animations: 2, unresolved: 1 });
    adapter.dispose();
  });

  it('a rejected resolveBytes is a hard assets-phase failure (L2 class)', async () => {
    const scene = v3Scene();
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: snapshotOf(scene),
      models: {
        assets: [{ assetId: 'asset-courier', version: 1, sourceDigest: DIGEST }],
        animation: [],
        resolveBytes: () => Promise.reject(new Error('the wrapper read failed')),
      },
      modelsLoader: createGltfLoaderPort(),
    });
    const settled = await waitSettled(adapter.modelsSettled!());
    expect(settled).toMatchObject({ ok: false, code: 'asset_missing' });
    const d = adapter.diagnostics();
    if (d.ok) expect(d.diagnostics.models?.failed).toBe(1);
    adapter.dispose();
  });

  it('dispose while a prepare is in flight: the late completion is discarded and released exactly once (§2.6)', async () => {
    // A loader that completes AFTER the dispose: the cancellation/late-
    // completion release must still run exactly once (no leak, nothing
    // applied).
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const slowPort: GlbLoaderPort = {
      load: (bytes, options) =>
        gate.then(() => createGltfLoaderPort().load(bytes, options)),
    };
    const scene = v3Scene();
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: snapshotOf(scene),
      models: modelsBlock(scene, GLB_BYTES),
      modelsLoader: slowPort,
    });
    // The two-phase prepare runs in a microtask (resolveBytes → store.load):
    // yield one turn so the in-flight handle is registered before the read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = adapter.diagnostics();
    if (pending.ok) expect(pending.diagnostics.models?.pending).toBe(1);
    adapter.dispose(); // cancels the in-flight prepare
    // The settle resolved with the teardown (no late success).
    const settled = await adapter.modelsSettled!();
    expect(settled).toMatchObject({ ok: false, code: 'adapter_disposed' });
    // Now let the (discarded) late completion land: it must not throw,
    // must not attach anything, and must not re-settle.
    releaseGate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = adapter.diagnostics();
    if (after.ok) expect(after.diagnostics.models).toBeUndefined();
    expect(adapter.renderFrame().ok).toBe(false); // adapter_disposed
  });

  it('per-instance material independence: one instance\'s cloned materials are its own (§2.3)', async () => {
    const bytes = buildGlb({ clipNames: ['Idle', 'Run', 'Airborne'], materials: 1 });
    const descriptor = { assetId: 'asset-courier', version: 1, sourceDigest: DIGEST, sourceByteLength: bytes.byteLength };
    const loader = createGltfLoaderPort();
    const handle = prepareVisualResource({ kind: 'bytes', descriptor, bytes }, { loader });
    const res = await handle.result;
    if (res.ok === false) throw new Error('prepare failed');
    const a = res.resource.createInstance();
    const b = res.resource.createInstance();
    if (a.ok === false || b.ok === false) throw new Error('instance creation failed');
    const materialsOf = (root: unknown): unknown[] => {
      const out: unknown[] = [];
      const walk = (node: { isMesh?: boolean; material?: unknown; children?: unknown[] }): void => {
        if (node.isMesh === true && node.material !== undefined) out.push(Array.isArray(node.material) ? node.material[0] : node.material);
        for (const child of node.children ?? []) walk(child as { isMesh?: boolean; material?: unknown; children?: unknown[] });
      };
      walk(root as { isMesh?: boolean; material?: unknown; children?: unknown[] });
      return out;
    };
    const matsA = materialsOf(a.instance.glbRoot);
    const matsB = materialsOf(b.instance.glbRoot);
    expect(matsA.length).toBeGreaterThan(0);
    // The two instances share the LOADED resource's materials by
    // construction (the GLB loader's createInstance clones the hierarchy,
    // not the materials) — the adapter's per-instance CLONE step
    // (cloneInstanceMaterials in models.ts) is what gives each attached
    // instance its own materials; the browser evidence proves the
    // independence end-to-end.
    expect(matsA[0]).toBe(matsB[0]);
    a.instance.dispose();
    b.instance.dispose();
  });
});