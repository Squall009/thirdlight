/**
 * Packet 32 — temporary browser test host for the M2 controller course.
 *
 * NOT a production bootstrap and NOT part of any shipped bundle: this file is
 * a manual test host that the packet-37 desktop procedure builds with esbuild
 * and serves statically. It composes the real packages
 * (`@thirdlight/platformer` + `@thirdlight/runtime` + `@thirdlight/physics-rapier`
 * + `@thirdlight/input`) exactly as the preview will, renders the frozen
 * course with three.js, and records the per-step action frames + authoritative
 * character positions that the acceptance row A12/A13 requires **from a real
 * browser with a physical keyboard and a physical gamepad**.
 *
 * It is named `.browser.ts` (not `.test.ts`) so vitest never picks it up.
 * In this container there is no browser and no hardware: every browser /
 * gamepad / visual claim of packet 32 is UNVERIFIED until a human runs the
 * procedure in `tests/browser/m2-controller/README.md`.
 */
import * as THREE from 'three';
import { attachBrowserInput } from '@thirdlight/input';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import {
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type Runtime,
} from '@thirdlight/runtime';

interface CourseFile {
  solver: { hz: 120; gravityY: number };
  character: { start: { x: number; y: number } };
  controller: {
    offsetSkin: 0.01;
    groundSnap: 0.1;
    maxSlopeClimbRad: number;
    minSlopeSlideRad: number;
    autostep: false;
  };
  settings: Record<string, number>;
  statics: { entityId: string; shape: { type: 'box'; hx: number; hy: number }; position: { x: number; y: number }; rotationZ: number }[];
}

interface Evidence {
  startedAt: string;
  userAgent: string;
  webglRenderer: string;
  secureContext: boolean;
  gamepadApi: boolean;
  gamepads: { index: number; id: string; mapping: string }[];
  course: string;
  steps: number;
  frames: { stepIndex: number; moveX: number; jump: string }[];
  positions: { stepIndex: number; x: number; y: number; z: number }[];
  zLocked: boolean;
}

const evidence: Evidence = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  webglRenderer: 'n/a',
  secureContext: window.isSecureContext === true,
  gamepadApi: typeof navigator.getGamepads === 'function',
  gamepads: [],
  course: '/fixtures/m2/course/course.json',
  steps: 0,
  frames: [],
  positions: [],
  zLocked: true,
};

const hud = document.createElement('pre');
hud.style.cssText = 'position:fixed;top:0;left:0;margin:0;padding:8px;background:#000c;color:#0f0;font:12px monospace;z-index:10';
document.body.appendChild(hud);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
evidence.webglRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';

async function main(): Promise<void> {
  const course = (await (await fetch(evidence.course)).json()) as CourseFile;
  const start = course.character.start;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101014);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0.5, 4);

  for (const spec of course.statics) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(spec.shape.hx * 2, spec.shape.hy * 2, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x556677, wireframe: true }),
    );
    mesh.position.set(spec.position.x, spec.position.y, 0);
    mesh.rotation.z = spec.rotationZ;
    scene.add(mesh);
  }
  const character = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, 1.2, 8, 16),
    new THREE.MeshBasicMaterial({ color: 0xff8844, wireframe: true }),
  );
  scene.add(character);

  const init = await createPhysicsPort({
    character: { x: start.x, y: start.y },
    statics: course.statics as never,
    solver: course.solver,
    controller: course.controller,
  });
  if (!init.ok) {
    hud.textContent = `physics init failed: ${JSON.stringify(init.error)}`;
    return;
  }

  const input = attachBrowserInput(window, {
    onDiagnostic: (event) => console.info('[thirdlight-input]', event.code, event.reason ?? ''),
  });
  // Record exactly what the runtime sampled (one frame per executed step).
  const recordingSource = {
    sample: (stepIndex: number) => {
      const frame = input.sample(stepIndex);
      if (evidence.frames.length < 20_000) evidence.frames.push(frame);
      return frame;
    },
    reset: (reason?: string) => input.reset?.(reason),
    diagnostics: () => input.diagnostics?.(),
  };

  const registry = createSimulationRegistry();
  registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
  const snapshot = {
    snapshotId: 'demo-0001@r4',
    projectId: 'demo-0001',
    revision: 4,
    scene: {
      schemaVersion: 2,
      sceneId: 'scene-main',
      revision: 4,
      entities: [
        {
          id: 'cam-main',
          components: {
            transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
          },
        },
        ...course.statics.map((spec, i) => {
          const half = spec.rotationZ / 2;
          return {
            id: `col-${String(i).padStart(4, '0')}`,
            components: {
              transform: {
                position: [spec.position.x, spec.position.y, 0],
                rotation: [0, 0, Math.sin(half), Math.cos(half)],
                scale: [1, 1, 1],
              },
              collider: { shape: spec.shape },
            },
          };
        }),
        {
          id: 'char-0001',
          components: {
            transform: { position: [start.x, start.y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            controller: {},
          },
        },
      ],
    },
  };

  let runtime: Runtime | null = null;
  const result = instantiateRuntime({
    snapshot,
    registry,
    modules: [PLATFORMER_MODULE_ID],
    actions: recordingSource,
    physics: init.port,
    settings: course.settings,
    driver: { kind: 'raf' },
    onFrame: () => {
      const state = runtime?.getInterpolatedState();
      if (!state?.ok) return;
      const t = state.state.transforms.find((x) => x.id === 'char-0001');
      if (!t) return;
      if (state.state.stepIndex !== evidence.steps) {
        evidence.steps = state.state.stepIndex;
        if (evidence.positions.length < 20_000) {
          evidence.positions.push({
            stepIndex: state.state.stepIndex,
            x: t.position[0] as number,
            y: t.position[1] as number,
            z: t.position[2] as number,
          });
        }
      }
      character.position.set(t.position[0] as number, t.position[1] as number, (t.position[2] as number) ?? 0);
      if (t.position[2] !== 0 || t.rotation.join() !== '0,0,0,1' || t.scale.join() !== '1,1,1') {
        evidence.zLocked = false;
      }
      renderer.render(scene, camera);
      const d = runtime?.getDiagnostics();
      if (d?.ok) {
        hud.textContent = JSON.stringify(
          {
            state: d.diagnostics.state,
            stepIndex: d.diagnostics.stepIndex,
            detectedGamepads: evidence.gamepads,
            position: t.position.map((v) => Number(v.toFixed(4))),
            zLocked: evidence.zLocked,
            errors: d.diagnostics.errorCount,
          },
          null,
          1,
        );
      }
    },
  });
  if (!result.ok) {
    hud.textContent = `instantiateRuntime failed: ${JSON.stringify(result.error)}`;
    return;
  }
  runtime = result.runtime;
  const started = runtime.start();
  if (!started.ok) hud.textContent = `start failed: ${JSON.stringify(started.error)}`;

  const poll = (): void => {
    if (typeof navigator.getGamepads === 'function') {
      evidence.gamepads = Array.from(navigator.getGamepads())
        .filter((p): p is Gamepad => p !== null)
        .map((p) => ({ index: p.index, id: p.id, mapping: p.mapping }));
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

/** Copy the recorded evidence JSON to the clipboard (or expose it). */
export async function collectEvidence(): Promise<string> {
  const json = JSON.stringify(evidence, null, 2);
  await navigator.clipboard?.writeText(json).catch(() => undefined);
  return json;
}

(window as unknown as { __m2Controller: unknown }).__m2Controller = {
  evidence,
  collectEvidence,
};

void main();
