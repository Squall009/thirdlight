/**
 * Packet 55 — temporary browser test host for the full local game shell
 * (delivery.md §3.1/§4; B04/B08/B09/B13/B15).
 *
 * NOT a production bootstrap and NOT part of any shipped bundle: a manual
 * test host the owner builds with the pinned esbuild (the packet-32/37
 * procedure, `tests/browser/m3-shell/README.md`) and serves statically. It
 * composes the REAL packages through `createGameHost` — the single
 * production composition (the host owns the registry/instantiateRuntime/
 * frame wiring), the real three-adapter on a real canvas, the real Rapier
 * port, the real `attachBrowserInput` owner (window listeners), and the
 * real packet-54 audio owner over the environment's AudioContext — and
 * records the packet-55 named checklist: the title HUD (text nodes, the
 * authored strings), the Enter/Space/KeyM menu channel, the §4.2
 * fresh-release no-phantom-jump, the start/won/win/replay loop, the sound
 * status across a LOCAL click unlock (and the blocked status before it),
 * the hidden-tab resume, and a DOM screenshot distinct from the canvas
 * pixels (B04: the HUD is DOM, the game is WebGL).
 *
 * It is named `.browser.ts` (not `.test.ts`) so vitest never picks it up.
 * In this container there is no browser/GPU/audio device (packet-38
 * baseline §1): every physical/visual/audible claim of packet 55 is
 * UNVERIFIED until the README procedure is run.
 *
 * Cue bytes: the real committed fixture WAVs (fixtures/m3/media/wav),
 * fetched same-origin by the page and handed to the host through the
 * injected `readArtifact` (the host itself never fetches).
 */
import { createPhysicsPort, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { attachBrowserInput } from '@thirdlight/input';
import {
  browserContextFactory,
  createGameAudioOwner,
  createGameHost,
  type GameHostConfig,
} from '@thirdlight/game-host';
import { createSceneAdapter } from '@thirdlight/three-adapter';
import type { GameplaySettings, RuntimeSnapshot } from '@thirdlight/runtime';

// --- the course (the tests/m3-shell harness pattern) -----------------------

const SETTINGS: GameplaySettings = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};
const SOLVER = { hz: 120, gravityY: -19.62 } as const;
const CONTROLLER_CFG = {
  offsetSkin: 0.01,
  groundSnap: 0.1,
  maxSlopeClimbRad: Math.PI / 4,
  minSlopeSlideRad: Math.PI / 6,
  autostep: false,
} as const;
const STATIC: RapierStaticColliderSpec = {
  entityId: 'floor',
  shape: { type: 'box', hx: 24, hy: 0.25 },
  position: { x: 24, y: -0.25 },
  rotationZ: 0,
};
const T = { rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

const SNAPSHOT: RuntimeSnapshot = {
  snapshotId: 'shell-browser@r1',
  projectId: 'shell-browser',
  revision: 1,
  scene: {
    schemaVersion: 3,
    sceneId: 'scene-main',
    revision: 1,
    entities: [
      {
        id: 'cam-main',
        name: 'Gameplay camera',
        components: {
          transform: { position: [0, 4, 12], ...T },
          camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
          cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: 0, maxX: 48, minY: -4, maxY: 8 } },
        },
      },
      { id: 'group-0001', name: 'Player', components: { transform: { position: [3, 0.9, 0], ...T }, controller: {} } },
      { id: 'spawn-0001', components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
      { id: 'spawn-0002', components: { transform: { position: [22, 0.91, 0], ...T }, playerSpawn: {} } },
      {
        id: 'zone-checkpoint',
        components: {
          transform: { position: [22, 1, 0], ...T },
          gameZone: {
            role: 'checkpoint',
            size: [2, 2],
            safeSpawnId: 'spawn-0002',
            activation: { emissive: '#ff0000', emissiveIntensity: 2, cueAssetId: null },
          },
        },
      },
      {
        id: 'zone-goal',
        components: { transform: { position: [44.5, 1, 0], ...T }, gameZone: { role: 'goal', size: [1, 2] } },
      },
      {
        id: 'static-0001',
        components: {
          transform: { position: [24, -0.25, 0], ...T },
          box: { size: [48, 0.5, 1], material: { color: '#6f6f6f' } },
          collider: { shape: { type: 'box', hx: 24, hy: 0.25 } },
        },
      },
    ],
  },
  game: {
    configVersion: 1,
    title: 'M3 Shell (packet 55)',
    objective: 'Reach the goal zone at the right edge',
    instructions: 'A/D or the D-pad to move. Space or the confirm button to jump. Enter/Space/confirm to start & replay. M to mute.',
    playerId: 'group-0001',
    cameraId: 'cam-main',
    spawnId: 'spawn-0001',
    level: { minX: 0, maxX: 48, minY: -4, maxY: 8 },
    killY: -4,
    cues: { start: 'cue-start', jump: 'cue-jump', checkpoint: 'cue-checkpoint', death: 'cue-death', goal: 'cue-goal' },
  },
} as unknown as RuntimeSnapshot;

const CUE_BASE = 'fixtures/m3/media/wav/';
const CUE_PATHS: Record<string, string> = {
  'cue-start': 'cue-start.wav',
  'cue-jump': 'cue-jump.wav',
  'cue-checkpoint': 'cue-checkpoint.wav',
  'cue-death': 'cue-death.wav',
  'cue-goal': 'cue-goal.wav',
};

// --- the page ----------------------------------------------------------------

const page = document.createElement('div');
page.style.cssText = 'font-family: system-ui, sans-serif; background: #10141a; color: #e8ecf1; padding: 16px; min-height: 100vh;';
const title = document.createElement('h1');
title.textContent = 'Thirdlight M3 shell host (packet 55)';
page.appendChild(title);
const status = document.createElement('pre');
status.style.cssText = 'white-space: pre-wrap; font-size: 12px; color: #9fb4c8; max-height: 180px; overflow: auto;';
page.appendChild(status);
const hudContainer = document.createElement('div');
hudContainer.style.cssText = 'border: 1px solid #33415599; padding: 8px; margin: 8px 0; max-width: 640px;';
page.appendChild(hudContainer);
const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 360;
canvas.style.cssText = 'border: 1px solid #334155; display: block;';
page.appendChild(canvas);
const hint = document.createElement('p');
hint.textContent =
  'CLICK ANYWHERE (or press a key) to unlock audio (local gesture). Then Enter/Space at the title starts; ' +
  'M mutes; Enter/Space at the win screen replays. A physical gamepad, if present, uses the standard mapping.';
page.appendChild(hint);
document.body.appendChild(page);

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  secureContext: window.isSecureContext,
  hasGamepads: typeof navigator.getGamepads === 'function',
  hasAudioContext: typeof window.AudioContext === 'function',
  steps: [] as string[],
};
const note = (s: string): void => {
  evidence.steps.push(s);
  status.textContent = evidence.steps.slice(-12).join('\n');
  console.info('[m3-shell]', s);
};
(window as unknown as { __m3shell: Record<string, unknown> }).__m3shell = evidence; // the evidence JSON (packet-55 README step 4)

async function main(): Promise<void> {
  // 1. The wrapper builds the platform specifics.
  const physicsInit = await createPhysicsPort({
    character: { x: 3, y: 0.9 },
    statics: [STATIC],
    solver: SOLVER,
    controller: CONTROLLER_CFG,
  });
  if (!physicsInit.ok) throw new Error(`physics init failed: ${JSON.stringify(physicsInit.error)}`);
  note(`physics: ${physicsInit.port.implementation ?? 'port'}`);

  const input = attachBrowserInput(canvas, { window, document, navigator });
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() });
  let adapterRef: { captureScreenshot(maxWidth?: number): unknown; dispose(): unknown } | null = null;

  // 2. The single production composition (the host owns it).
  const config: GameHostConfig = {
    snapshot: SNAPSHOT,
    settings: SETTINGS,
    physics: physicsInit.port,
    adapter: (runtime) => {
      const a = createSceneAdapter(canvas, { runtime, snapshot: SNAPSHOT });
      adapterRef = a;
      return a;
    },
    input,
    audio,
    readArtifact: async (path: string): Promise<ArrayBuffer> => {
      const res = await fetch(CUE_BASE + path);
      if (!res.ok) throw new Error(`cue fetch failed: ${path} (${res.status})`);
      return res.arrayBuffer();
    },
    container: hudContainer,
    // The wrapper passes the verified manifest buildId (CC-55-1). In this
    // test host the snapshot is synthetic: a stable test identity.
    buildId: 'shell-browser-build-1',
    assetPaths: Object.fromEntries(Object.entries(CUE_PATHS).map(([id, file]) => [id, file])),
    document: document as never,
  };
  const host = createGameHost(config);
  const mount = host.mount();
  if (!mount.ok) throw new Error(`mount failed: ${JSON.stringify(mount.error)}`);
  note('mounted: HUD + runtime + adapter (the host composition)');

  const soundStatus = (): string => JSON.stringify(host.observe().ok ? host.observe().observation.sound : null);
  const before = host.observe();
  note(`title: state=${before.ok ? before.observation.state : '?'} sound=${soundStatus()}`);
  note(`HUD text: ${hudContainer.textContent?.slice(0, 160)}`);

  // 3. The local unlock (the wrapper's one-shot gesture wiring).
  const unlockOnce = (): void => {
    void audio.unlock().then((st) => {
      note(`audio unlock (local gesture): ${JSON.stringify(st)} → ${soundStatus()}`);
    });
  };
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  // 4. The win/replay loop evidence (observed, never scripted input).
  let lastState = '';
  const interval = window.setInterval(() => {
    const res = host.observe();
    if (!res.ok) return;
    const obs = res.observation;
    const line = `${obs.state} run=${obs.runId} step=${obs.stepIndex} deaths=${obs.deathCount} sound=${JSON.stringify(obs.sound)}`;
    if (line !== lastState) {
      lastState = line;
      note(`observed: ${line}`);
    }
  }, 500);
  window.addEventListener('pagehide', () => window.clearInterval(interval), { once: true });

  // 5. A DOM screenshot distinct from the canvas pixels (B04): the HUD is
  //    DOM; the game is WebGL. The screenshot below is the CANVAS (WebGL);
  //    the HUD text evidence is the DOM half.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'F12' && e.code !== 'F9') return;
      // F9: capture the canvas screenshot into the evidence (bounded).
      if (e.code !== 'F9' || adapterRef === null) return;
      const shot = adapterRef.captureScreenshot(512) as { ok: boolean; result?: { byteSize: number } };
      if (shot.ok && shot.result) note(`canvas screenshot captured: ${shot.result.byteSize} bytes (WebGL half; the DOM half is the HUD text evidence)`);
    },
    { once: false },
  );
}

void main().catch((error: unknown) => {
  note(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
});
