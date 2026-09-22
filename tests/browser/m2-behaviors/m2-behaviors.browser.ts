/**
 * Packet 34 — manual browser host for trusted behavior execution.
 *
 * NOT a production bootstrap and NOT part of any shipped bundle: the packet-37
 * desktop procedure builds this file with esbuild and serves it statically
 * together with `fixtures/m2/behaviors/valid/sample.output.js`. It is named
 * `.browser.ts` (not `.test.ts`) so vitest never picks it up.
 *
 * In this container there is no browser: every browser claim of packet 34 is
 * UNVERIFIED until a human runs the procedure in
 * `tests/browser/m2-behaviors/README.md`. The Node test host
 * (`behavior-host.test.ts`, `node:vm`) is the in-container execution evidence.
 *
 * What this host proves when run in a real browser:
 *
 *  1. the compiled artifact loads through the browser's real module system
 *     (blob URL + dynamic `import`), which is the only way the play page loads
 *     a published behavior — the runtime host itself never evaluates source;
 *  2. the declared numeric property (`speed`) measurably changes the play
 *     state (the box's x position) after a FRESH instantiation;
 *  3. the normative trust notice renders verbatim before any acknowledgment.
 *
 * It deliberately contains NO unbounded-loop behavior: runtime.md §14.1.1
 * documents that a same-thread loop cannot be preempted, and no packet may run
 * one in a live user's browser.
 */
import * as THREE from 'three';
import {
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type BehaviorArtifact,
  type SimulationModuleSpec,
} from '@thirdlight/runtime';
import { BEHAVIOR_TRUST_NOTICE } from '../../../packages/editor/src/session/behavior-publication';

const DT = 1 / 120;
const STEPS = 40;

interface SampleOutputDeclaration {
  properties: { key: string; label: string; type: string; default: number }[];
}

async function loadArtifact(): Promise<{ namespace: unknown; declaration: SampleOutputDeclaration }> {
  const [sourceRes, indexRes] = await Promise.all([
    fetch('/fixtures/m2/behaviors/valid/sample.output.js'),
    fetch('/fixtures/m2/behaviors/expected.json'),
  ]);
  const source = await sourceRes.text();
  const index = (await indexRes.json()) as { declaration: SampleOutputDeclaration };
  // The browser's real ESM loader: the compiled artifact is a module, never
  // evaluated source text. The blob URL is revoked right after the import.
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const namespace = (await import(/* @vite-ignore */ url)) as unknown;
    return { namespace, declaration: index.declaration };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sceneFor(speed: number): unknown {
  const transform = (position: number[]): unknown => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return {
    schemaVersion: 2,
    sceneId: 'scene-main',
    revision: 1,
    entities: [
      {
        id: 'cam-main',
        components: { transform: transform([0, 0.5, 4]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
      },
      {
        id: 'box-0001',
        components: {
          transform: transform([0, 0, 0]),
          box: { size: [1, 1, 1], material: { color: '#ffb347' } },
          behavior: { behaviorId: 'behavior-0100', values: { speed } },
        },
      },
    ],
  };
}

/** The play-side consumer: moves its owned box by the committed control_move. */
function consumerSpec(): SimulationModuleSpec {
  return {
    id: 'thirdlight.test:move-consumer',
    phases: ['transform'],
    create() {
      return {
        transformOwners: ['box-0001'],
        step(phase, ctx): void {
          if (phase !== 'transform') return;
          const move = ctx.intents.move ?? ctx.action.moveX;
          const t = ctx.state.curr.get('box-0001');
          if (t) t.position[0] = t.position[0] + move * DT;
        },
      };
    },
  };
}

function measure(namespace: unknown, declaration: SampleOutputDeclaration, speed: number): number {
  const artifact: BehaviorArtifact = {
    behaviorId: 'behavior-0100',
    sourceDigest: '0'.repeat(64),
    manifestDigest: '0'.repeat(64),
    outputDigest: '0'.repeat(64),
    ownedTransforms: [],
    requiredModules: ['@thirdlight/runtime'],
    enginePins: [],
    namespace,
  };
  const registry = createSimulationRegistry();
  const behavior = createBehaviorModuleSpec({ declaration: { properties: declaration.properties as never }, artifact });
  registerSimulationModule(registry, behavior.id, behavior);
  const consumer = consumerSpec();
  registerSimulationModule(registry, consumer.id, consumer);
  const res = instantiateRuntime({
    snapshot: { snapshotId: 'demo-0001@r1', projectId: 'demo-0001', revision: 1, scene: sceneFor(speed) },
    registry,
    modules: [behavior.id, consumer.id],
    driver: { kind: 'manual' },
    clock: () => 0,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  rt.start();
  rt.tick(0); // 12-step settle pre-roll
  for (let i = 1; i <= STEPS; i += 1) {
    const r = rt.tick(i * DT);
    if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
  }
  const state = rt.getInterpolatedState();
  if (!state.ok) throw new Error('state failed');
  const x = state.state.transforms.find((t) => t.id === 'box-0001')?.position[0] ?? 0;
  rt.dispose();
  return x;
}

async function main(): Promise<void> {
  const root = document.getElementById('tl-behavior-host');
  if (!root) throw new Error('missing #tl-behavior-host');

  const { namespace, declaration } = await loadArtifact();
  const xLow = measure(namespace, declaration, 3.5);
  const xHigh = measure(namespace, declaration, 6.5);

  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 240;
  root.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
  camera.position.set(0, 1, 5);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  const low = new THREE.Mesh(geometry, material);
  low.position.set(xLow, 0.5, 0);
  const high = new THREE.Mesh(geometry, material.clone());
  high.position.set(xHigh, -0.5, 0);
  scene.add(low, high);
  renderer.render(scene, camera);

  const report = {
    kind: 'packet-34-browser-host',
    speedLow: 3.5,
    speedHigh: 6.5,
    steps: STEPS,
    xLow,
    xHigh,
    changed: xHigh !== xLow,
  };
  const pre = document.createElement('pre');
  pre.id = 'tl-behavior-report';
  pre.textContent = `P34_BROWSER_MEASUREMENT ${JSON.stringify(report)}`;
  root.append(pre);

  const notice = document.createElement('blockquote');
  notice.id = 'tl-behavior-trust-notice';
  notice.textContent = BEHAVIOR_TRUST_NOTICE.join('\n\n');
  root.append(notice);

  // eslint-disable-next-line no-console
  console.log(pre.textContent);
}

void main();
