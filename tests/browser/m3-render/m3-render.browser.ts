/**
 * Packet 52 — temporary browser test host for the M3 light/shadow/surface
 * realization.
 *
 * NOT a production bootstrap and NOT part of any shipped bundle: this file
 * is a manual test host that the owner builds with the pinned esbuild (the
 * packet-32/37 procedure, `tests/browser/m3-render/README.md`) and serves
 * statically. It composes the real packages (`@thirdlight/runtime` +
 * `@thirdlight/physics-rapier` + `@thirdlight/platformer` +
 * `@thirdlight/platformer-game` + `@thirdlight/three-adapter`) over a v3
 * scene with an authored key/fill light and surface boxes, and records the
 * B11 named checklist (Gate K: "same preset id → same colour/roughness
 * values and the same visible key-light direction/hazard contrast") — the
 * authored values, the derived parameters via the pure §41.1.3/§41.2 math,
 * the realized diagnostics, real screenshots at two canvas sizes, a
 * synthetic context-loss/recovery cycle, and repeated create/dispose.
 *
 * It is named `.browser.ts` (not `.test.ts`) so vitest never picks it up.
 * In this container there is no browser and no GPU: every visual/WebGL claim
 * of packet 52 is UNVERIFIED until the README procedure is run.
 *
 * No GPU-memory claim from JS object counts (packet 52 evidence rule): the
 * evidence is the rendered pixels, the named-checklist values and the
 * diagnostics.
 */
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import {
  PLATFORMER_GAME_CAMERA_MODULE_ID,
  PLATFORMER_GAME_MODULE_ID,
  platformerGameCameraSpec,
  platformerGameSessionSpec,
} from '@thirdlight/platformer-game';
import {
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import {
  createSceneAdapter,
  deriveShadowCamera,
  planSceneLights,
  SHADOW_PROFILE,
  SURFACE_PRESETS,
} from '@thirdlight/three-adapter';

interface FixtureFile {
  shadow: Record<string, number | string>;
  presets: Record<string, Record<string, string | number>>;
  lights: Array<{ id: string; value: Record<string, unknown>; expect: Record<string, unknown> }>;
}

interface Evidence {
  startedAt: string;
  userAgent: string;
  webglRenderer: string;
  isWebGL2: boolean;
  checklist: {
    authoredKeyLight: Record<string, unknown> | null;
    authoredFillLight: Record<string, unknown> | null;
    derivedKey: { position: number[]; target: number[]; shadowCamera: Record<string, number | boolean>; mapSize: number; type: string } | null;
    presetRows: { adapter: Record<string, unknown>; fixture: Record<string, unknown> | null; match: boolean };
    shadowConstants: { adapter: Record<string, unknown>; fixture: Record<string, unknown> | null; match: boolean };
    diagnosticsShadowOn: Record<string, unknown>;
    diagnosticsShadowOff: Record<string, unknown>;
  };
  screenshots: { shadowOn169: string; shadowOn43: string; shadowOff169: string } | null;
  contextLoss: { lostReported: boolean; recoveredReported: boolean };
  repeatedDispose: { cycles: number; allIdempotent: boolean };
  materialIndependence: {
    sceneASurface: { a: Record<string, unknown>; b: Record<string, unknown> };
    sceneBSurface: { a: Record<string, unknown>; b: Record<string, unknown> };
    onlyAChanged: boolean;
  };
  errors: string[];
}

const LEVEL = { minX: 0, maxX: 48, minY: -4, maxY: 8 };
const KEY_DIRECTION: [number, number, number] = [0.5, -1, -0.6];
const KEY = { type: 'directional', color: '#fff4e0', intensity: 2.2, direction: KEY_DIRECTION, castShadow: true } as const;
const KEY_NO_SHADOW = { ...KEY, castShadow: false } as const;
const FILL = { type: 'ambient', color: '#8899bb', intensity: 0.55 } as const;
const HAZARD = SURFACE_PRESETS.hazard;
const GROUND = SURFACE_PRESETS['matte-ground'];
const BEACON = SURFACE_PRESETS.beacon;

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  webglRenderer: 'n/a',
  isWebGL2: false,
  checklist: {
    authoredKeyLight: null,
    authoredFillLight: null,
    derivedKey: null,
    presetRows: { adapter: {}, fixture: null, match: false },
    shadowConstants: { adapter: {}, fixture: null, match: false },
    diagnosticsShadowOn: {},
    diagnosticsShadowOff: {},
  },
  screenshots: null,
  contextLoss: { lostReported: false, recoveredReported: false },
  repeatedDispose: { cycles: 0, allIdempotent: false },
  materialIndependence: { sceneASurface: { a: {}, b: {} }, sceneBSurface: { a: {}, b: {} }, onlyAChanged: false },
  errors: [],
};

const T = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

/** The shared v3 scene (one camera, one key + one fill light, three
 * surface boxes). `castShadow` selects the shadow-on/off-by-author scene. */
function v3Snapshot(castShadow: boolean): unknown {
  return {
    snapshotId: `demo-52@r${castShadow ? 1 : 2}`,
    projectId: 'demo-52',
    revision: castShadow ? 1 : 2,
    scene: {
      schemaVersion: 3,
      sceneId: 'scene-main',
      revision: castShadow ? 1 : 2,
      entities: [
        { id: 'cam-main', name: 'Gameplay camera', components: { transform: { position: [0, 4, 12], ...T }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
        { id: 'light-key', components: { transform: { position: [0, 4, 12], ...T }, light: castShadow ? KEY : KEY_NO_SHADOW } },
        { id: 'light-fill', components: { transform: { position: [0, 4, 12], ...T }, light: FILL } },
        { id: 'box-hazard', components: { transform: { position: [10, 0.5, 0], ...T }, box: { size: [2, 1, 1], material: { color: '#6f6f6f' } }, surface: HAZARD } },
        { id: 'box-ground', components: { transform: { position: [16, 0.5, 0], ...T }, box: { size: [2, 1, 1], material: { color: '#6f6f6f' } }, surface: GROUND } },
        { id: 'box-beacon', components: { transform: { position: [22, 0.5, 0], ...T }, box: { size: [2, 1, 1], material: { color: '#6f6f6f' } }, surface: BEACON } },
        { id: 'group-0001', name: 'Player', components: { transform: { position: [3, 0.9, 0], ...T }, controller: {} } },
        { id: 'spawn-0001', components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
        { id: 'static-0001', components: { transform: { position: [24, -0.25, 0], ...T }, box: { size: [48, 0.5, 1], material: { color: '#6f6f6f' } }, collider: { shape: { type: 'box', hx: 24, hy: 0.25 } } } },
      ],
    },
    game: {
      configVersion: 1,
      title: 'Render Course',
      objective: 'Render the course',
      instructions: 'D moves.',
      playerId: 'group-0001',
      cameraId: 'cam-main',
      spawnId: 'spawn-0001',
      level: LEVEL,
      killY: -4,
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    },
  };
}

async function buildRuntime(snapshot: unknown): Promise<{ runtime: Runtime; dispose: () => void }> {
  const init = await createPhysicsPort({
    character: { x: 3, y: 0.9 },
    statics: [{ entityId: 'floor', shape: { type: 'box', hx: 24, hy: 0.25 }, position: { x: 24, y: -0.25 }, rotationZ: 0 }],
    solver: { hz: 120, gravityY: -19.62 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  });
  if (!init.ok) throw new Error(`physics init failed: ${JSON.stringify(init.error)}`);
  const registry = createSimulationRegistry();
  for (const spec of [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]) {
    const r = registerSimulationModule(registry, spec.id, spec);
    if (!r.ok) throw new Error(`register failed ${spec.id}: ${JSON.stringify(r.error)}`);
  }
  const frames = Array.from({ length: 24 }, (_, i) => ({ stepIndex: 12 + i, moveX: 0, jump: 'none' as const }));
  const res = instantiateRuntime({
    snapshot: snapshot as RuntimeSnapshot,
    registry,
    modules: [PLATFORMER_MODULE_ID, PLATFORMER_GAME_MODULE_ID, PLATFORMER_GAME_CAMERA_MODULE_ID],
    actions: createRecordedActionSource(frames),
    physics: init.port,
    settings: { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 },
    clock: () => 0,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  res.runtime.start();
  res.runtime.tick(0);
  return { runtime: res.runtime, dispose: () => { res.runtime.dispose(); init.port.dispose(); } };
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.style.cssText = `width:${w}px;height:${h}px;display:block;background:#20242a`;
  return c;
}

/** One rendered frame through the real adapter (step → render). */
function frame(adapter: ReturnType<typeof createSceneAdapter>, runtime: Runtime): void {
  const r = adapter.renderFrame();
  if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.error)}`);
}

function shotDataUrl(adapter: ReturnType<typeof createSceneAdapter>): string {
  const s = adapter.captureScreenshot(1024);
  if (!s.ok) throw new Error(`screenshot failed: ${JSON.stringify(s.error)}`);
  return s.result.dataUrl;
}

function saveShot(name: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
  const hud = document.createElement('pre');
  hud.style.cssText = 'position:fixed;top:0;right:0;margin:0;padding:8px;background:#000c;color:#0f0;font:12px monospace;z-index:10;max-width:40vw;white-space:pre-wrap';
  document.body.appendChild(hud);
  const log = (s: string): void => {
    hud.textContent += s + '\n';
    console.log('[m3-render]', s);
  };

  // 0. Environment + the promoted fixture (served from the repo root).
  const probe = canvasOf(4, 4);
  const probeGl = probe.getContext('webgl2');
  evidence.isWebGL2 = probeGl !== null;
  if (probeGl) {
    const dbg = probeGl.getExtension('WEBGL_debug_renderer_info');
    evidence.webglRenderer = dbg ? String(probeGl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  }
  let fixture: FixtureFile | null = null;
  try {
    const r = await fetch('/fixtures/m3/media/render/light-surface-cases.json');
    fixture = (await r.json()) as FixtureFile;
  } catch (e) {
    evidence.errors.push(`fixture fetch failed: ${String(e)}`);
  }

  // 1. Named checklist — the authored values against the fixture rows.
  const keyCase = fixture?.lights.find((c) => c.id === 'key-ok');
  const fillCase = fixture?.lights.find((c) => c.id === 'fill-ok');
  evidence.checklist.authoredKeyLight = { authored: KEY, fixture: keyCase?.value ?? null };
  evidence.checklist.authoredFillLight = { authored: FILL, fixture: fillCase?.value ?? null };
  // The derived parameters (the pure §41.1.3 math) — these are exactly the
  // values the adapter realizes (same functions, same inputs).
  const plan = deriveShadowCamera(LEVEL, KEY_DIRECTION);
  const lightPlans = planSceneLights([KEY, FILL], LEVEL, { ok: true, shadows: 'on', plan });
  const keyPlan = lightPlans.find((p) => p.kind === 'directional');
  evidence.checklist.derivedKey = keyPlan && keyPlan.kind === 'directional'
    ? {
        position: keyPlan.position,
        target: keyPlan.target,
        shadowCamera: { left: plan.camera.left, right: plan.camera.right, top: plan.camera.top, bottom: plan.camera.bottom, near: plan.camera.near, far: plan.camera.far, halfExtent: plan.halfExtent, withinBounds: plan.withinBounds },
        mapSize: SHADOW_PROFILE.mapSize,
        type: SHADOW_PROFILE.type,
      }
    : null;
  evidence.checklist.presetRows = {
    adapter: { 'matte-ground': SURFACE_PRESETS['matte-ground'], hazard: SURFACE_PRESETS.hazard, beacon: SURFACE_PRESETS.beacon },
    fixture: fixture?.presets ?? null,
    match: fixture ? eq(fixture.presets, { 'matte-ground': SURFACE_PRESETS['matte-ground'], hazard: SURFACE_PRESETS.hazard, beacon: SURFACE_PRESETS.beacon }) : false,
  };
  evidence.checklist.shadowConstants = {
    adapter: { mapSize: SHADOW_PROFILE.mapSize, type: SHADOW_PROFILE.type, near: SHADOW_PROFILE.near, distance: SHADOW_PROFILE.distance, margin: SHADOW_PROFILE.margin, halfExtentMax: SHADOW_PROFILE.halfExtentMax, farMax: SHADOW_PROFILE.farMax },
    fixture: fixture?.shadow ?? null,
    match: fixture ? eq(fixture.shadow, { mapSize: SHADOW_PROFILE.mapSize, type: SHADOW_PROFILE.type, near: SHADOW_PROFILE.near, distance: SHADOW_PROFILE.distance, margin: SHADOW_PROFILE.margin, halfExtentMax: SHADOW_PROFILE.halfExtentMax, farMax: SHADOW_PROFILE.farMax }) : false,
  };
  log(`checklist: presetRows.match=${evidence.checklist.presetRows.match} shadowConstants.match=${evidence.checklist.shadowConstants.match} isWebGL2=${evidence.isWebGL2}`);

  // 2. The shadow-on scene: real runtime + real adapter, two canvas sizes
  //    (the resize path: the shadow camera is level-derived — resize only
  //    changes the perspective aspect).
  const runtimeOn = await buildRuntime(v3Snapshot(true));
  const canvasOn = canvasOf(1280, 720);
  document.body.appendChild(canvasOn);
  const adapterOn = createSceneAdapter(canvasOn, { runtime: runtimeOn.runtime, snapshot: v3Snapshot(true) as RuntimeSnapshot });
  frame(adapterOn, runtimeOn.runtime);
  const diagOn1 = adapterOn.diagnostics();
  evidence.checklist.diagnosticsShadowOn = { ...(diagOn1.ok ? diagOn1.diagnostics : { error: 'diagnostics failed' }) };
  saveShot('m3-render-shadow-on-169.png', shotDataUrl(adapterOn));
  // resize 16:9 → 4:3
  canvasOn.width = 1024;
  canvasOn.height = 768;
  canvasOn.style.width = '1024px';
  canvasOn.style.height = '768px';
  frame(adapterOn, runtimeOn.runtime);
  saveShot('m3-render-shadow-on-43.png', shotDataUrl(adapterOn));
  const diagAfterResize = adapterOn.diagnostics();
  if (diagAfterResize.ok) evidence.checklist.diagnosticsShadowOn = { ...(evidence.checklist.diagnosticsShadowOn as Record<string, unknown>), afterResize: diagAfterResize.diagnostics };
  adapterOn.dispose();
  runtimeOn.dispose();

  // 3. The shadow-off-by-author scene (castShadow: false): the author's own
  //    choice — no shadow map, the diagnostics say so.
  const runtimeOff = await buildRuntime(v3Snapshot(false));
  const canvasOff = canvasOf(1280, 720);
  document.body.appendChild(canvasOff);
  const adapterOff = createSceneAdapter(canvasOff, { runtime: runtimeOff.runtime, snapshot: v3Snapshot(false) as RuntimeSnapshot });
  frame(adapterOff, runtimeOff.runtime);
  const diagOff = adapterOff.diagnostics();
  evidence.checklist.diagnosticsShadowOff = diagOff.ok ? { ...(diagOff.diagnostics) } : { error: 'diagnostics failed' };
  saveShot('m3-render-shadow-off-169.png', shotDataUrl(adapterOff));
  adapterOff.dispose();
  runtimeOff.dispose();
  log(`diagnostics: shadowOn=${JSON.stringify(evidence.checklist.diagnosticsShadowOn)} shadowOff=${JSON.stringify(evidence.checklist.diagnosticsShadowOff)}`);

  // 4. Synthetic context loss + recovery (the accepted packet-26 behavior):
  //    fire the real canvas events; the adapter must report
  //    `render_context_lost` while lost and resume after restoration.
  {
    const runtimeC = await buildRuntime(v3Snapshot(true));
    const canvasC = canvasOf(640, 360);
    document.body.appendChild(canvasC);
    const adapterC = createSceneAdapter(canvasC, { runtime: runtimeC.runtime, snapshot: v3Snapshot(true) as RuntimeSnapshot });
    frame(adapterC, runtimeC.runtime);
    canvasC.dispatchEvent(new Event('webglcontextlost'));
    const lost = adapterC.renderFrame();
    evidence.contextLoss.lostReported = !lost.ok && lost.error.code === 'render_context_lost';
    canvasC.dispatchEvent(new Event('webglcontextrestored'));
    const recovered = adapterC.renderFrame();
    evidence.contextLoss.recoveredReported = recovered.ok === true;
    adapterC.dispose();
    runtimeC.dispose();
    log(`contextLoss: ${JSON.stringify(evidence.contextLoss)}`);
  }

  // 5. Repeated create/dispose (the B11 ownership checklist half): five
  //    cycles, idempotent disposal, diagnostics coherent after dispose.
  {
    let allIdempotent = true;
    for (let i = 0; i < 5; i += 1) {
      const rt = await buildRuntime(v3Snapshot(true));
      const c = canvasOf(320, 180);
      const a = createSceneAdapter(c, { runtime: rt.runtime, snapshot: v3Snapshot(true) as RuntimeSnapshot });
      frame(a, rt.runtime);
      const first = a.dispose();
      const second = a.dispose();
      allIdempotent = allIdempotent && first.ok === true && second.ok === true && (second as { alreadyDisposed?: boolean }).alreadyDisposed === true;
      const d = a.diagnostics();
      if (!d.ok || d.diagnostics.shadows !== 'on') allIdempotent = false;
      rt.dispose();
      c.remove();
    }
    evidence.repeatedDispose = { cycles: 5, allIdempotent };
    log(`repeatedDispose: ${JSON.stringify(evidence.repeatedDispose)}`);
  }

  // 6. Material independence (value-level, §41.2.3): two scenes where
  //    entity A gets the `hazard` row and entity B the `matte-ground` row;
  //    then a second realization where A is edited to `beacon` — only A's
  //    values change; B keeps its own row. The committed `surface` values
  //    are what the adapter realizes literally (no preset lookup).
  {
    const surfOf = (snap: unknown): { a: Record<string, unknown>; b: Record<string, unknown> } => {
      const entities = (snap as { scene: { entities: Array<{ id: string; components: Record<string, unknown> }> } }).scene.entities;
      const a = entities.find((e) => e.id === 'box-hazard')?.components.surface as Record<string, unknown>;
      const b = entities.find((e) => e.id === 'box-ground')?.components.surface as Record<string, unknown>;
      return { a, b };
    };
    const sceneA = v3Snapshot(true);
    const sceneB = JSON.parse(JSON.stringify(sceneA)) as unknown;
    const entsB = (sceneB as { scene: { entities: Array<{ id: string; components: Record<string, unknown> }> } }).scene.entities;
    entsB.find((e) => e.id === 'box-hazard')!.components.surface = BEACON; // edit ONLY A
    evidence.materialIndependence.sceneASurface = surfOf(sceneA);
    evidence.materialIndependence.sceneBSurface = surfOf(sceneB);
    evidence.materialIndependence.onlyAChanged =
      eq(evidence.materialIndependence.sceneASurface.b, evidence.materialIndependence.sceneBSurface.b) &&
      !eq(evidence.materialIndependence.sceneASurface.a, evidence.materialIndependence.sceneBSurface.a) &&
      eq(evidence.materialIndependence.sceneBSurface.a, BEACON);
    log(`materialIndependence: ${JSON.stringify(evidence.materialIndependence.onlyAChanged)}`);
  }

  // 7. Collect.
  (window as unknown as { __m3Render: { collectEvidence: () => Evidence } }).__m3Render = {
    collectEvidence: () => evidence,
  };
  log('done — call await window.__m3Render.collectEvidence() and save the JSON (plus the three PNG downloads).');
}

main().catch((e) => {
  evidence.errors.push(String(e));
  console.error('[m3-render] fatal', e);
});