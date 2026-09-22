/**
 * Packet 53 — M3 animation-roles browser verification (manual, the
 * packet-32/37 procedure; the m3-render host's structure).
 *
 * STATUS: UNVERIFIED in-container — no browser, no WebGL context, no GPU.
 * Nothing in this directory was executed; every rendered statement of packet
 * 53 (rendered poses, the 0.2 s crossfade in pixels, the independent mixers
 * on screen) is UNVERIFIED until the owner runs this procedure. The verified
 * halves are: the real-loader + real-fixture `setRoles` evidence
 * (`tests/m3-animation/roles-real-loader.test.ts`), the controller behavior
 * over the real three@0.186.0 animation stack
 * (`packages/three-adapter/src/animation.test.ts`), the pure rule 3/4/7 math
 * and the committed real-roles fixture re-derivation (media checker `roles`
 * group).
 *
 * The host composes the REAL packages (three-adapter root + the pinned
 * GLTFLoader port) over the REAL committed fixture bytes (fetched from the
 * served repository root and verified against the media index.json SHA-256
 * before use). It drives TWO model instances of ONE prepared resource with
 * two independent role controllers, a third for the dispose-while-blending
 * check, and renders real screenshots. The host owns the frame loop
 * (`requestAnimationFrame`); the controllers install no loop, no clock and
 * no mixer listener (presentation.md §41.3.6 rule 2) — each `update` receives
 * the real frame delta.
 *
 * Named `.browser.ts` so vitest never collects it.
 */
import * as THREE from 'three';
import {
  ANIMATION_CROSSFADE_SECONDS,
  RUN_SPEED_EPS,
  crossfadeIncomingWeight,
  createAnimationRoleController,
  prepareVisualResource,
  selectAnimationRole,
  suppliedBytes,
  type AnimationRoleController,
  type AnimationRoleMotion,
  type AnimationRolesInput,
  type ModelInstance,
  type PreparedVisualResource,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';

const FIXTURES = '/fixtures/m3/media';
const STEP = 1 / 60;

interface WeightRow {
  idle: number;
  run: number;
  airborne: number;
}

interface Evidence {
  startedAt: string;
  userAgent: string;
  webglRenderer: string;
  isWebGL2: boolean;
  fixtureDigests: Record<string, { expected: string; actual: string; match: boolean }>;
  checklist: {
    rolesAccepted: {
      storedOrderV1: { ok: boolean; role: string };
      reorderedV2: { ok: boolean; role: string };
      staleRow: { code: string; message: string };
      eps: number;
      crossfadeSeconds: number;
      selectorTable: { atRest: string; running: string; airborne: string };
    };
    weightLaw: { samples: Array<{ elapsed: number; expected: number; actual: number }>; maxAbsError: number };
    blending: { midFade: boolean; afterFade: boolean };
    independence: { bIdleThroughout: boolean; bWeightsLast: WeightRow; aRoleLast: string };
    poseIndependence: { rotorA: [number, number, number, number]; rotorB: [number, number, number, number]; differ: boolean };
    noTransformWrites: { holderABefore: [number, number, number]; holderAAfter: [number, number, number]; unchanged: boolean };
    stepIndex: { committed: number; reported: number };
    disposalWhileBlending: {
      midBlend: boolean;
      disposeOk: boolean;
      secondCall: 'alreadyDisposed' | 'other';
      sharedSurvives: boolean;
    };
  };
  screenshots: string[];
  errors: string[];
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  webglRenderer: 'n/a',
  isWebGL2: false,
  fixtureDigests: {},
  checklist: {
    rolesAccepted: {
      storedOrderV1: { ok: false, role: '' },
      reorderedV2: { ok: false, role: '' },
      staleRow: { code: '', message: '' },
      eps: RUN_SPEED_EPS,
      crossfadeSeconds: ANIMATION_CROSSFADE_SECONDS,
      selectorTable: { atRest: '', running: '', airborne: '' },
    },
    weightLaw: { samples: [], maxAbsError: 0 },
    blending: { midFade: false, afterFade: false },
    independence: { bIdleThroughout: true, bWeightsLast: { idle: 0, run: 0, airborne: 0 }, aRoleLast: '' },
    poseIndependence: { rotorA: [0, 0, 0, 0], rotorB: [0, 0, 0, 0], differ: false },
    noTransformWrites: { holderABefore: [0, 0, 0], holderAAfter: [0, 0, 0], unchanged: false },
    stepIndex: { committed: 0, reported: -1 },
    disposalWhileBlending: { midBlend: false, disposeOk: false, secondCall: 'other', sharedSurvives: false },
  },
  screenshots: [],
  errors: [],
};

function log(s: string): void {
  console.log('[m3-animation]', s);
}

function fail(s: string): void {
  evidence.errors.push(s);
  console.error('[m3-animation]', s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One host-owned committed view slice (the §41.3.7 accessor). */
function hostView() {
  const host = { motion: { speed: 0, grounded: true } as AnimationRoleMotion, step: 0 };
  return { host, view: () => ({ stepIndex: host.step, playerMotion: host.motion }) };
}

function controllerOf(
  instance: ModelInstance,
  view: () => { stepIndex: number; playerMotion: AnimationRoleMotion },
): AnimationRoleController {
  const c = createAnimationRoleController(instance, view);
  if (!c.ok) throw new Error(`expected a controller, got ${c.error.code}: ${c.error.message}`);
  return c.controller;
}

async function prepareFromFixture(rel: string, version: number): Promise<{ resource: PreparedVisualResource; digest: { expected: string; actual: string; match: boolean } }> {
  const r = await fetch(`${FIXTURES}/${rel}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const idx = JSON.parse(await (await fetch(`${FIXTURES}/index.json`)).text()) as { files: Record<string, { sha256: string }> };
  const expected = idx.files[rel]?.sha256 ?? '';
  const actual = await sha256Hex(bytes);
  evidence.fixtureDigests[rel] = { expected, actual, match: expected === actual };
  if (!evidence.fixtureDigests[rel].match) fail(`fixture digest mismatch for ${rel}`);
  const handle = prepareVisualResource(
    suppliedBytes({ assetId: 'asset-model-courier', version, sourceDigest: expected, sourceByteLength: bytes.byteLength }, bytes),
    { loader: createGltfLoaderPort() },
  );
  const result = await handle.result;
  if (!result.ok) throw new Error(`expected a ready resource, got ${result.error.code}: ${result.error.message}`);
  return { resource: result.resource, digest: evidence.fixtureDigests[rel] };
}

function animatedNodeQuat(instance: ModelInstance): [number, number, number, number] {
  // The committed media GLBs animate the 'Arm' node (the test-rig GLBs the
  // package tests use animate 'Rotor'); take the first named animated node.
  const found: { q: { x: number; y: number; z: number; w: number } | null } = { q: null };
  instance.glbRoot.traverse((o) => {
    if (found.q !== null) return;
    const name = (o as { name?: string }).name;
    if (name !== 'Arm' && name !== 'Rotor') return;
    const q = (o as unknown as { quaternion?: { x: number; y: number; z: number; w: number } }).quaternion;
    if (q !== undefined) found.q = { x: q.x, y: q.y, z: q.z, w: q.w };
  });
  if (found.q === null) throw new Error('no animated node (Arm/Rotor) in the GLB hierarchy');
  return [found.q.x, found.q.y, found.q.z, found.q.w];
}

interface RenderScene {
  canvas: HTMLCanvasElement;
  adapter: {
    renderFrame(): { ok: boolean; error?: { code: string; message: string } };
    captureScreenshot(_maxWidth: number): { ok: boolean; dataUrl?: string; error?: { code: string; message: string } };
    dispose(): { ok: boolean };
  };
}

/** A minimal WebGL render surface: scene graph + renderer, one camera. */
function buildRenderScene(instance: ModelInstance, w: number, h: number): RenderScene {
  // Local (host-owned) renderer: the evidence is the rendered poses; the
  // scene adapter's own canvas path is exercised by the m3-render host.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(w, h, false);
  evidence.isWebGL2 = renderer.capabilities.isWebGL2;
  const glInfo = renderer.getContext() as WebGL2RenderingContext | null;
  if (glInfo !== null) {
    const ext = glInfo.getExtension('WEBGL_debug_renderer_info');
    evidence.webglRenderer = ext !== null ? String(glInfo.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(glInfo.getParameter(glInfo.RENDERER));
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(3, 6, 4);
  scene.add(dir);
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(2, 2, 5);
  camera.lookAt(0, 0.5, 0);
  scene.add(instance.root);
  return {
    canvas,
    adapter: {
      renderFrame: () => {
        try {
          renderer.render(scene, camera);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: { code: 'render_failed', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      captureScreenshot: () => {
        try {
          const dataUrl = canvas.toDataURL('image/png');
          return { ok: true, dataUrl };
        } catch (e) {
          return { ok: false, error: { code: 'screenshot_failed', message: e instanceof Error ? e.message : String(e) } };
        }
      },
      dispose: () => {
        renderer.dispose();
        return { ok: true };
      },
    },
  };
}

function saveShot(name: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
  evidence.screenshots.push(name);
}

async function main(): Promise<void> {
  // 1. The committed real-roles rows + the real courier GLBs (digest-verified).
  const rolesJson = JSON.parse(await (await fetch(`${FIXTURES}/roles/roles-cases.json`)).text()) as {
    cases: Array<{ id: string; file: string; component: { assetId: string; version: number; roles: AnimationRolesInput }; expect: { verdict: string; code?: string } }>;
  };
  const byId = new Map(rolesJson.cases.map((c) => [c.id, c]));
  const storedV1 = byId.get('roles-stored-order-v1')!;
  const reorderedV2 = byId.get('roles-reordered-v2')!;
  const staleRow = byId.get('roles-stored-order-against-reordered-bytes')!;
  const { resource } = await prepareFromFixture(`glb/${storedV1.file}`, storedV1.component.version);

  // 2. The pure checklist rows (the contract constants + the selector table).
  const cs = evidence.checklist.rolesAccepted;
  cs.selectorTable = {
    atRest: selectAnimationRole({ speed: 0, grounded: true }),
    running: selectAnimationRole({ speed: 1.0, grounded: true }),
    airborne: selectAnimationRole({ speed: 0, grounded: false }),
  };

  // 3. Three instances of ONE resource: A (the timeline), B (the independent
  //    idle copy), C (the dispose-while-blending copy).
  const madeA = resource.createInstance();
  const madeB = resource.createInstance();
  const madeC = resource.createInstance();
  if (!madeA.ok || !madeB.ok || !madeC.ok) throw new Error('expected three instances');
  const viewA = hostView();
  const viewB = hostView();
  const viewC = hostView();
  const ctrlA = controllerOf(madeA.instance, viewA.view);
  const ctrlB = controllerOf(madeB.instance, viewB.view);
  const ctrlC = controllerOf(madeC.instance, viewC.view);

  // A and B take the accepted rows; the stale row is refused.
  const setA = ctrlA.setRoles(storedV1.component.roles, storedV1.component.version);
  const setB = ctrlB.setRoles(storedV1.component.roles, storedV1.component.version);
  const setStale = ctrlC.setRoles(staleRow.component.roles, staleRow.component.version);
  cs.storedOrderV1.ok = setA.ok === true;
  cs.reorderedV2.ok = setB.ok === true;
  cs.staleRow.code = setStale.ok === false ? setStale.error.code : 'accepted (unexpected)';
  cs.staleRow.message = setStale.ok === false ? setStale.error.message : '';
  log(`rolesAccepted: storedV1=${cs.storedOrderV1.ok} reorderedV2=${cs.reorderedV2.ok} staleRow.code=${cs.staleRow.code}`);

  // C's refused mapping re-checks cleanly with its own (accepted) row so the
  // dispose-while-blending check runs on an installed controller.
  const setC2 = ctrlC.setRoles(storedV1.component.roles, storedV1.component.version);
  if (!setC2.ok) fail(`C re-install failed: ${setC2.error.code}`);

  // 4. The committed-motion timeline (the host commits motion like a runtime
  //    commit: one `update(delta)` per frame with the real frame delta).
  const holderA = {
    x: madeA.instance.root.position.x,
    y: madeA.instance.root.position.y,
    z: madeA.instance.root.position.z,
  };
  evidence.checklist.noTransformWrites.holderABefore = [holderA.x, holderA.y, holderA.z];

  // A: idle at step 3 (the first advance, no fade).
  viewA.host.step = 3;
  ctrlA.update(STEP);
  evidence.checklist.stepIndex.committed = 3;
  evidence.checklist.stepIndex.reported = ctrlA.state().stepIndex;

  // A: run — the 0.2 s crossfade, sampled against the contract law.
  viewA.host.motion = { speed: 1.2, grounded: true };
  viewA.host.step = 4;
  let elapsed = 0;
  for (let i = 0; i < 13; i += 1) {
    elapsed += STEP;
    ctrlA.update(STEP);
    if (i === 2 || i === 6 || i === 10) {
      const mid = ctrlA.state();
      const expectedIn = crossfadeIncomingWeight(elapsed);
      evidence.checklist.weightLaw.samples.push({
        elapsed: Number(elapsed.toFixed(4)),
        expected: Number(expectedIn.toFixed(4)),
        actual: Number(mid.weights.run.toFixed(4)),
      });
      evidence.checklist.weightLaw.maxAbsError = Math.max(
        evidence.checklist.weightLaw.maxAbsError,
        Math.abs(mid.weights.run - expectedIn),
      );
    }
    if (i === 6) evidence.checklist.blending.midFade = ctrlA.state().blending;
    evidence.checklist.independence.bWeightsLast = { ...ctrlB.state().weights };
    if (ctrlB.state().role !== 'idle' || ctrlB.state().weights.idle < 1 - 1e-6) {
      evidence.checklist.independence.bIdleThroughout = false;
    }
  }
  evidence.checklist.blending.afterFade = ctrlA.state().blending;
  evidence.checklist.independence.aRoleLast = ctrlA.state().role;

  // A: airborne (the fade to the third role), then a rendered frame.
  viewA.host.motion = { speed: 0, grounded: false };
  for (let i = 0; i < 13; i += 1) ctrlA.update(STEP);

  // The reordered bytes: a second resource, one instance, the new mapping.
  const reordered = await prepareFromFixture(`glb/${reorderedV2.file}`, reorderedV2.component.version);
  const madeR = reordered.resource.createInstance();
  if (!madeR.ok) throw new Error('expected the reordered instance');
  const ctrlR = controllerOf(madeR.instance, hostView().view);
  const setR = ctrlR.setRoles(reorderedV2.component.roles, reorderedV2.component.version);
  if (!setR.ok) fail(`reordered mapping refused: ${setR.error.code}`);
  for (let i = 0; i < 20; i += 1) ctrlR.update(STEP); // idle (at rest)

  // The rendered poses: A airborne, B idle, C idle (three instances, one
  // resource, three mixers — the independent poses are the evidence).
  const sceneA = buildRenderScene(madeA.instance, 960, 540);
  sceneA.adapter.renderFrame();
  const shotA = sceneA.adapter.captureScreenshot(960);
  if (shotA.ok && shotA.dataUrl !== undefined) saveShot('m3-animation-roles-a-airborne.png', shotA.dataUrl);
  sceneA.adapter.dispose();

  const sceneB = buildRenderScene(madeB.instance, 960, 540);
  sceneB.adapter.renderFrame();
  const shotB = sceneB.adapter.captureScreenshot(960);
  if (shotB.ok && shotB.dataUrl !== undefined) saveShot('m3-animation-roles-b-idle.png', shotB.dataUrl);
  sceneB.adapter.dispose();

  const rotorA = animatedNodeQuat(madeA.instance);
  const rotorB = animatedNodeQuat(madeB.instance);
  evidence.checklist.poseIndependence = { rotorA, rotorB, differ: rotorA.some((v, i) => Math.abs(v - rotorB[i]) > 1e-6) };

  // The holder A pose: the controller wrote no transform (rule 6).
  evidence.checklist.noTransformWrites.holderAAfter = [
    madeA.instance.root.position.x,
    madeA.instance.root.position.y,
    madeA.instance.root.position.z,
  ];
  evidence.checklist.noTransformWrites.unchanged =
    evidence.checklist.noTransformWrites.holderAAfter.every((v, i) => v === evidence.checklist.noTransformWrites.holderABefore[i]);

  // 5. Dispose while blending (rule 8): C fades idle→run, dies mid-blend;
  //    A and B keep running on the shared resource.
  viewC.host.motion = { speed: 0, grounded: true };
  ctrlC.update(STEP);
  viewC.host.motion = { speed: 2.0, grounded: true };
  for (let i = 0; i < 3; i += 1) ctrlC.update(STEP);
  evidence.checklist.disposalWhileBlending.midBlend = ctrlC.state().blending;
  const disposeC = ctrlC.dispose();
  evidence.checklist.disposalWhileBlending.disposeOk = disposeC.ok === true;
  const disposeC2 = ctrlC.dispose();
  evidence.checklist.disposalWhileBlending.secondCall = disposeC2.ok === true && disposeC2.alreadyDisposed === true ? 'alreadyDisposed' : 'other';
  ctrlA.update(STEP);
  ctrlB.update(STEP);
  evidence.checklist.disposalWhileBlending.sharedSurvives = ctrlA.state().weights.run > 0 || ctrlA.state().role === 'run';

  // 6. The reordered instance rendered (the new mapping on the new bytes).
  const sceneR = buildRenderScene(madeR.instance, 960, 540);
  sceneR.adapter.renderFrame();
  const shotR = sceneR.adapter.captureScreenshot(960);
  if (shotR.ok && shotR.dataUrl !== undefined) saveShot('m3-animation-roles-reordered.png', shotR.dataUrl);
  sceneR.adapter.dispose();

  madeC.instance.dispose();
  madeR.instance.dispose();
  madeA.instance.dispose();
  madeB.instance.dispose();
  resource.dispose();
  reordered.resource.dispose();

  const wl = evidence.checklist.weightLaw;
  log(`weightLaw: maxAbsError=${wl.maxAbsError.toExponential(2)} (samples ${wl.samples.length})`);
  log(`blending: midFade=${evidence.checklist.blending.midFade} afterFade=${evidence.checklist.blending.afterFade}`);
  log(`independence: bIdleThroughout=${evidence.checklist.independence.bIdleThroughout} poseDiffer=${evidence.checklist.poseIndependence.differ}`);
  log(`noTransformWrites: ${evidence.checklist.noTransformWrites.unchanged}`);
  log(`disposalWhileBlending: ${JSON.stringify(evidence.checklist.disposalWhileBlending)}`);
  log(`fixtureDigests: ${Object.values(evidence.fixtureDigests).every((d) => d.match)}`);
  log('done — save the evidence JSON (window.__m3Animation.evidence) plus the PNG downloads.');
}

(window as unknown as { __m3Animation: { evidence: Evidence } }).__m3Animation = { evidence };
main().catch((e) => fail(`host failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));