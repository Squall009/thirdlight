/**
 * Packet 69 — the in-page render probe (esbuild iife bundle; served by
 * `run.mts` and driven over CDP).
 *
 * The probe composes the ACCEPTED production stack in the real browser:
 * the real `instantiateRuntime` (M3 module set — platformer controller +
 * session + camera), the real `@thirdlight/physics-rapier` port, a real
 * `createSceneAdapter` carrying the `models` block (delivery.md (M4)
 * §2) with the real pinned GLTFLoader port (`./gltf-loader` subpath),
 * driven by ONE rAF consumer (the runtime's driver; the adapter's
 * `renderFrame` runs as its `onFrame` — no second loop; the rAF patch
 * below counts concurrent pending callbacks for the C13 assertion).
 *
 * The player is driven by a base-relative `ActionSource` (the
 * engine-level equivalent of the bridge's keyboard/gamepad frames — the
 * headless container has no physical input; the as-shipped keyboard-focus
 * defect D-63-2 is documented in the 63 baseline and outside this packet's
 * repair scope). The source runs the player +x over the accepted course
 * (run + jump the step-block + run + jump the hazard + a clean stop on the
 * platform — see `makeRecordedFrames`), and the production host's
 * Start-button path (`runtime.gameCommand('start')`, queued after the
 * models settle) starts the life.
 *
 * The models block is built exactly as the packet-70 production wrapper
 * will build it: the `assets` rows from the fixture index (the manifest
 * `assets` rows, kind "model"), the `animation` rows from the committed
 * `modelAnimation` entities, and `resolveBytes` serving wrapper-verified
 * bytes (the probe re-hashes each GLB against the row's
 * `sourceDigest` with WebCrypto before anything is handed to the
 * adapter — the adapter never re-hashes).
 *
 * Surface: `window.__tl69` (set with `ready: true` once the models have
 * settled, or with `fatal: { message }`). All failures are reported
 * in-band; the probe never throws unhandled.
 */
import {
  BUILTIN_MODULES,
  colliderRotationZ,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type ActionSource,
  type JumpPhase,
  type PhysicsPort,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { CONTROLLER_CONSTANTS, platformerSpec } from '@thirdlight/platformer';
import { platformerGameCameraSpec, platformerGameSessionSpec } from '@thirdlight/platformer-game';
import {
  createSceneAdapter,
  selectAnimationRole,
  type ModelAnimationRoles,
  type SceneAdapter,
  type SceneAdapterModels,
  type SceneAdapterModelsDiagnostics,
} from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';

// ---- the single rAF consumer (C13) -----------------------------------------
// The measurement tracks LIVE pending callbacks by id (a Set) and wraps
// `cancelAnimationFrame` too: the runtime cancels its driver on
// stop/dispose, and an unintercepted cancellation would leak the pending
// count (a disposed runtime's cancelled frame would count forever).
const rafLive = new Set<number>();
let rafPeak = 0;
let rafFired = 0;
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCaf = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const id = nativeRaf((t) => {
    rafLive.delete(id);
    rafFired += 1;
    return cb(t);
  });
  rafLive.add(id);
  if (rafLive.size > rafPeak) rafPeak = rafLive.size;
  return id;
};
window.cancelAnimationFrame = (id: number): void => {
  rafLive.delete(id);
  return nativeCaf(id);
};

const unhandled: string[] = [];
const state: Record<string, unknown> = {
  ready: false,
  fatal: null,
  unhandled,
  settleResult: null,
  raf: { peak: 0, fired: 0 },
  disposeCycles: 0,
};
window.addEventListener('unhandledrejection', (e) => {
  unhandled.push(String(e.reason ?? e));
  e.preventDefault();
});
(window as unknown as { __tl69?: unknown }).__tl69 = state;
function fatal(message: string): void {
  state.fatal = { message };
  state.ready = false;
}

// ---- module-level composition state (assigned by main) ----------------------
interface FixtureIndex {
  provenance: { finalRevision: number; projectId: string };
  settings: Record<string, number>;
  game: Record<string, unknown>;
  assetRows: Array<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number }>;
  animationRows: Array<{ entityId: string; assetId: string; version: number; roles: unknown }>;
  playerEntityId: string;
}
let indexDoc: FixtureIndex | null = null;
let snapshot: RuntimeSnapshot | null = null;
let models: SceneAdapterModels | null = null;
let physicsConfig: RapierPhysicsInitConfig | null = null;
let physics: PhysicsPort | null = null;
let runtime: Runtime | null = null;
let adapter: SceneAdapter | null = null;

// The canvas (created synchronously; the adapter renders into it).
const canvas = document.createElement('canvas') as HTMLCanvasElement;
canvas.width = 960;
canvas.height = 540;
canvas.style.cssText = 'position:fixed;inset:0;width:960px;height:540px;background:#0e1015';
document.body.appendChild(canvas);

// ---- helpers ----------------------------------------------------------------
async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(path, { credentials: 'omit' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The physics config (mirrors the accepted exporter helper: statics from
 * `collider` components, the character from the `controller` entity, the
 * settings-resolved solver + controller constants). */
function physicsConfigFromScene(): RapierPhysicsInitConfig | null {
  const doc = indexDoc;
  const snap = snapshot;
  if (doc === null || snap === null) return null;
  const settings = doc.settings;
  const gravityY = settings['gravity_y'];
  const climbDeg = settings['max_slope_climb_deg'];
  const slideDeg = settings['min_slope_slide_deg'];
  if (typeof gravityY !== 'number' || typeof climbDeg !== 'number' || typeof slideDeg !== 'number') {
    throw new Error('the fixture settings carry no gravity_y/slope keys');
  }
  const entities = (snap.scene as unknown as {
    entities: Array<{ id: string; components: Record<string, unknown>; parentId?: string | null }>;
  }).entities;
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  for (const entity of entities) {
    const components = entity.components ?? {};
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    if (components['collider'] !== undefined) {
      const collider = components['collider'] as { shape?: unknown };
      statics.push({
        entityId: entity.id,
        position: { x: position[0] ?? 0, y: position[1] ?? 0 },
        rotationZ: colliderRotationZ(transform?.rotation),
        shape: collider.shape as never,
      });
    }
    if (components['controller'] !== undefined) {
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        parentId: entity.parentId ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      };
    }
  }
  if (character === null) return null;
  return {
    character,
    statics,
    solver: { hz: 120, gravityY },
    controller: {
      offsetSkin: CONTROLLER_CONSTANTS.offsetSkin,
      groundSnap: CONTROLLER_CONSTANTS.groundSnap,
      maxSlopeClimbRad: (climbDeg * Math.PI) / 180,
      minSlopeSlideRad: (slideDeg * Math.PI) / 180,
      autostep: false,
    },
  };
}

function buildRuntime(): Runtime {
  const registry = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  const specs = [platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec];
  const modules: string[] = [];
  for (const spec of specs) {
    const r = registerSimulationModule(registry, spec.id, spec);
    if (r.ok === false) throw new Error(`registering ${spec.id} failed: ${r.error.message}`);
    modules.push(spec.id);
  }
  const res = instantiateRuntime({
    snapshot: snapshot as RuntimeSnapshot,
    registry,
    modules,
    actions: actionSource,
    physics: physics ?? undefined,
    settings: indexDoc?.settings ?? undefined,
    onFrame: () => {
      // The single rAF consumer stays the runtime's driver: this hook
      // piggybacks on it (no second loop). It re-bases the action source on
      // the first `playing` view (the start step) and drives the adapter.
      // (`getGameView()` returns the `{ ok, view }` result wrapper — the
      // state is on `wrapper.view`, not the wrapper.)
      const gv = runtime?.getGameView?.() ?? null;
      const view = gv !== null && gv.ok ? gv.view : null;
      if (view !== null && view.state === 'playing' && liveBaseStep === null) {
        liveBaseStep = view.stepIndex;
      }
      adapter?.renderFrame();
    },
  });
  if (res.ok === false) throw new Error(`instantiateRuntime failed: ${JSON.stringify(res.error)}`);
  return res.runtime;
}
function buildAdapter(rt: Runtime): SceneAdapter {
  return createSceneAdapter(canvas, {
    runtime: rt,
    snapshot: snapshot as RuntimeSnapshot,
    models: models as SceneAdapterModels,
    modelsLoader: createGltfLoaderPort(),
  });
}
function disposeAll(): { adapter: unknown; runtime: unknown; physics: unknown } {
  const out: { adapter: unknown; runtime: unknown; physics: unknown } = { adapter: null, runtime: null, physics: null };
  if (adapter !== null) {
    out.adapter = adapter.dispose();
    adapter = null;
  }
  if (runtime !== null) {
    out.runtime = runtime.dispose();
    runtime = null;
  }
  if (physics !== null) {
    out.physics = physics.dispose();
    physics = null;
  }
  return out;
}

// The designed input frames (built once; BASE-RELATIVE — see the action
// source below): relative steps 1..4000. The course (the fixture's
// accepted scene; the entity transform is the capsule CENTER — the
// physics port places the capsule collider centered on it): the ground
// box-0001 spans x∈[0,16] with top y=0 (the capsule rests at center
// y=0.91); the step-block box-0002 spans x∈[6,7] with top y=0.3 (a wall
// — autostep is off); the hazard box-0003 spans x∈[10.5, 11.3],
// y∈[0,0.25] (ground-level death); the ground ends at x=16 (the next
// ground box-0004 starts at x=17.5).
//
// Jump math (run_speed 4, jump_velocity 7, gravity_y −19.62, capsule half-
// extent 0.9, radius 0.3): a full-hold jump hangs ≈ 0.71 s (≈ 86 steps,
// ≈ 2.85 m at speed 4) and the arc clears a 0.3 m wall / 0.25 m hazard
// when the press happens in x∈[4.68,5.51] (block) / x∈[8.90,10.05]
// (hazard). CRITICAL: the controller's variable-height rule halves vy and
// clears the `airborne` flag on a `released` edge while ascending (F in
// `controller.ts`) — an early release both shortens the flight and makes
// the committed motion report `grounded` for the rest of the flight (no
// `airborne` role). So each jump is HELD through the apex (0.357 s = 43
// steps) and released only after landing — the committed selection then
// reads `airborne` for the whole arc.
function makeRecordedFrames(): ActionFrame[] {
  const frames: ActionFrame[] = [];
  // The motion starts at ≈ relative step 17 (the start boundary + the
  // accepted 12-step settle pre-roll — measured, and deterministic from
  // there): x(rel) = 3 + 4·(rel−17)/120. Jump 1: pressed 80 (x≈5.10 — the
  // window center), held 81–171, released 172 (after the ≈ relative 166
  // landing at x≈8.0, past the block face 7.0 + radius). Jump 2: pressed
  // 211 (x≈9.43 — the window center), held 212–302, released 303 (the arc
  // peaks over the hazard center x≈10.9 with ≈ 1.9 m of clearance; the
  // landing ≈ relative 297 at x≈12.3, past the zone end 11.3 + radius).
  // Move input released at relative 341 (x≈13.77; moveDecel 60 stops it in
  // ≈ 0.13 m → ≈ 13.9) — the player stands on the platform ≈ 2 m from the
  // ground edge (x=16): no death, a clean run + jump + run + jump + stop
  // evidence window.
  const jump = (at: number): JumpPhase => {
    if (at === 80 || at === 211) return 'pressed';
    if ((at > 80 && at <= 171) || (at > 211 && at <= 302)) return 'held';
    if (at === 172 || at === 303) return 'released';
    return 'none';
  };
  for (let i = 1; i <= 4000; i += 1) {
    frames.push({ stepIndex: i, moveX: i <= 340 ? 1 : 0, jump: jump(i) });
  }
  return frames;
}
// The action source (the engine-level equivalent of the bridge's keyboard/
// gamepad frames — the headless container has no physical input; the
// as-shipped keyboard-focus defect D-63-2 is documented in the 63 baseline
// and outside this packet's repair scope). It is BASE-RELATIVE by design:
// the simulation steps (physics included) even while the M3 session sits in
// `awaitingStart` (the session gate governs the game state, not the step
// loop), so absolute step-indexed input would race the non-deterministic
// models-settle duration. The source returns NEUTRAL frames until the game
// view first reports `playing`, then replays the designed frames relative
// to that start step (`liveBaseStep`, captured in `onFrame` — no second rAF
// consumer). The run is fully deterministic from there: fixed 120 Hz, the
// start boundary + the accepted 12-step settle pre-roll start the motion at
// ≈ start+17, and the same relative frames replay identically on every
// runtime recreation (the dispose cycles re-base on the new runtime's own
// start — a step-index regression resets the base).
let liveBaseStep: number | null = null;
let lastSampledStep = -1;
const actionSource: ActionSource = {
  sample: (stepIndex: number): ActionFrame => {
    if (stepIndex < lastSampledStep) {
      // A new runtime recreation (the step index restarted): re-base on its
      // own start.
      liveBaseStep = null;
      lastSampledStep = -1;
    }
    lastSampledStep = Math.max(lastSampledStep, stepIndex);
    const base = liveBaseStep;
    if (base === null) return { stepIndex, moveX: 0, jump: 'none' };
    const rel = stepIndex - base + 1; // the next sample after the start view
    const f = rel >= 1 && rel <= designedFrames.length ? designedFrames[rel - 1] : undefined;
    return f !== undefined ? { stepIndex, moveX: f.moveX, jump: f.jump } : { stepIndex, moveX: 0, jump: 'none' };
  },
  reset: (): void => { /* stateless: the base re-arms on each runtime start */ },
};
const designedFrames = makeRecordedFrames();

// ---- main --------------------------------------------------------------------
async function main(): Promise<void> {
  const sceneDoc = await fetchJson('./scene.json');
  indexDoc = (await fetchJson('./index.json')) as FixtureIndex;
  // The wrapper's read phase: each declared model asset is fetched exactly
  // once and re-hashed against the row's sourceDigest (a mismatch is fatal —
  // the adapter never receives unverified bytes).
  const bytesByKey = new Map<string, ArrayBuffer>();
  for (const row of indexDoc.assetRows) {
    const res = await fetch(`./assets/${row.assetId}.glb`, { credentials: 'omit' });
    if (!res.ok) throw new Error(`${row.assetId}: HTTP ${res.status}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    if (raw.byteLength !== row.sourceByteLength) throw new Error(`${row.assetId}: byte length ${raw.byteLength} !== ${row.sourceByteLength}`);
    const digest = await sha256Hex(raw);
    if (digest !== row.sourceDigest) throw new Error(`${row.assetId}: digest mismatch ${digest} !== ${row.sourceDigest}`);
    bytesByKey.set(`${row.assetId}@${row.version}`, raw.buffer);
  }
  models = {
    assets: indexDoc.assetRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest })),
    animation: indexDoc.animationRows.map((r) => ({ entityId: r.entityId, roles: r.roles as ModelAnimationRoles, version: r.version })),
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
      const buf = bytesByKey.get(`${assetId}@${version}`);
      if (buf === undefined) return Promise.reject(new Error(`no wrapper-verified bytes for ${assetId} v${version}`));
      return Promise.resolve(buf);
    },
  };
  snapshot = {
    snapshotId: `${indexDoc.provenance.projectId}@r${indexDoc.provenance.finalRevision}`,
    projectId: indexDoc.provenance.projectId,
    revision: indexDoc.provenance.finalRevision,
    scene: sceneDoc,
    game: indexDoc.game,
  } as unknown as RuntimeSnapshot;
  physicsConfig = physicsConfigFromScene();
  if (physicsConfig === null) {
    fatal('the fixture scene carries no controller entity');
    return;
  }
  const physicsInit = await createPhysicsPort(physicsConfig);
  if (!physicsInit.ok) {
    fatal(`physics init failed: ${physicsInit.error.code}`);
    return;
  }
  physics = physicsInit.port;
  runtime = buildRuntime();
  const startRes = runtime.start();
  if (startRes.ok === false) {
    const err = startRes.error;
    runtime.dispose();
    runtime = null;
    fatal(`runtime start failed: ${JSON.stringify(err)}`);
    return;
  }
  adapter = buildAdapter(runtime);
  // The models settle (the wrapper's `tl.ready` seam): all assets ready,
  // all instances attached, the controllers live. (`settleResult` — data, not
  // a method: a same-key method + data assignment would overwrite the
  // function on the published surface.)
  state.settleResult = (await adapter.modelsSettled?.()) ?? null;
  // The production host's Start-button path (the HUD's `onStart` →
  // `control('start')` → the runtime seam): the M3 session starts a life at
  // the next step boundary. It is queued AFTER the settle so the evidence
  // window (the run.mts capture, timed after `ready`) begins at the start of
  // the run — the simulation steps during `awaitingStart`, and the
  // base-relative action source keeps the character idle at the spawn until
  // this command lands.
  const startedCmd = runtime.gameCommand('start');
  if (startedCmd.ok === false) {
    fatal(`gameCommand start rejected: ${JSON.stringify(startedCmd.error)}`);
    return;
  }
  state.ready = true;
}
void main().catch((e) => fatal(`composition failed: ${String(e)}`));

// ---- the drive surface (CDP-evaluated) ---------------------------------------
interface ProbeState {
  stepIndex: number | null;
  runState: string | null;
  /** The action source's start base (the first `playing` view step). */
  baseStep: number | null;
  playerMotion: { speed: number; grounded: boolean } | null;
  playerRole: string | null;
  nonPlayerRole: string;
  playerPosition: { x: number; y: number } | null;
  models: SceneAdapterModelsDiagnostics | null;
}
type Tl69 = Record<string, unknown> & {
  state(): ProbeState;
  frames(n: number, everyMs: number): Promise<unknown>;
  rafStats(): unknown;
  disposeCycle(): Promise<unknown>;
};
const api: Tl69 = state as Tl69;

api.state = (): ProbeState => {
  const d = adapter?.diagnostics() ?? null;
  const gv = runtime?.getGameView() ?? null;
  const interp = runtime?.getInterpolatedState() ?? null;
  const view = gv !== null && gv.ok ? gv.view : null;
  const playerMotion = view?.playerMotion ?? null;
  const playerId = view?.playerId ?? indexDoc?.playerEntityId ?? null;
  const playerPos = interp !== null && interp.ok && playerId !== null
    ? (interp.state.transforms.find((t) => t.id === playerId) ?? null)
    : null;
  const playerX = playerPos === null ? null : (playerPos.position[0] ?? 0);
  const playerY = playerPos === null ? null : (playerPos.position[1] ?? 0);
  return {
    stepIndex: view?.stepIndex ?? null,
    runState: view?.state ?? null,
    baseStep: liveBaseStep,
    playerMotion: playerMotion === null ? null : { speed: playerMotion.speed, grounded: playerMotion.grounded },
    // The accepted pure selector applied to the committed motion (the probe
    // re-derives what the adapter's player controller consumes).
    playerRole: playerMotion === null ? null : selectAnimationRole(playerMotion),
    // The non-player animated entity always sees the neutral motion.
    nonPlayerRole: selectAnimationRole({ speed: 0, grounded: true }),
    playerPosition: playerPos === null ? null : { x: playerX as number, y: playerY as number },
    models: d === null || d.ok !== true ? null : d.diagnostics.models ?? null,
  };
};

api.rafStats = () => ({ peak: rafPeak, fired: rafFired, pending: rafLive.size });

// `n` frames spaced `everyMs` apart; each entry pairs the player's
// interpolated position with a canvas capture (the visible model/pose
// frame evidence) and a downscaled signature (for the non-blank + change
// assertions).
api.frames = async (n: number, everyMs: number) => {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, everyMs));
    const snap = api.state();
    let capture: unknown = null;
    let signature: unknown = null;
    if (adapter !== null) {
      const shot = adapter.captureScreenshot(320);
      capture = shot.ok === true ? { dataUrl: shot.result.dataUrl, byteSize: shot.result.byteSize } : { error: shot.error };
      const dataUrl = (capture as { dataUrl?: string }).dataUrl;
      if (typeof dataUrl === 'string') {
        try {
          const c = document.createElement('canvas') as HTMLCanvasElement;
          c.width = 48;
          c.height = 27;
          const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
          if (ctx !== null) {
            const img = new Image();
            img.src = dataUrl;
            await new Promise<void>((r) => {
              img.onload = () => r();
              img.onerror = () => r();
            });
            if (img.naturalWidth > 0) {
              ctx.drawImage(img, 0, 0, 48, 27);
              const data = ctx.getImageData(0, 0, 48, 27).data;
              let distinct = 0;
              const seen = new Set<number>();
              for (let p = 0; p < 48 * 27; p += 1) {
                const r = data[p * 4] ?? 0;
                const g = data[p * 4 + 1] ?? 0;
                const b = data[p * 4 + 2] ?? 0;
                const a = data[p * 4 + 3] ?? 0;
                seen.add(r * 512 + g * 2 + Math.round(b / 128));
                if (a > 8) distinct += 1;
              }
              signature = { distinctPixels: distinct, distinctColors: seen.size };
            }
          }
        } catch (e) {
          signature = { error: String(e) };
        }
      }
    }
    out.push({ index: i, t: performance.now(), ...snap, capture, signature });
  }
  return out;
};

// One dispose/recreate cycle (the ownership-baseline evidence): dispose the
// adapter + runtime + physics port, rebuild all three (the physics port is
// per-runtime — the recreation re-inits it), and re-settle. `buildRuntime`
// closes over the module-level `physics` binding, so the re-assignment
// below is visible to it.
api.disposeCycle = async () => {
  const disposals = disposeAll();
  if (physicsConfig !== null) {
    const reinit = await createPhysicsPort(physicsConfig);
    if (!reinit.ok) return { ok: false, code: `physics_reinit_${reinit.error.code}` };
    physics = reinit.port;
  }
  try {
    runtime = buildRuntime();
    const startRes = runtime.start();
    if (startRes.ok === false) {
      const err = startRes.error;
      runtime.dispose();
      runtime = null;
      return { ok: false, code: `runtime_start_${err.code}` };
    }
    const startCmd = runtime.gameCommand('start');
    if (startCmd.ok === false) {
      const err = startCmd.error;
      runtime.dispose();
      runtime = null;
      return { ok: false, code: `game_start_${err.code}` };
    }
    adapter = buildAdapter(runtime);
    const settle = (await adapter.modelsSettled?.()) ?? null;
    state.disposeCycles = (state.disposeCycles as number) + 1;
    return { ok: true, disposals, settle };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
};