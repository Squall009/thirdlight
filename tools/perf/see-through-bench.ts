/**
 * See-through's occluder search on the CPU (`node tools/perf/run.mjs see-through-cpu`): a follow camera over a
 * hedge of 600 instanced bushes between it and the character, every frame with the members moved (a new stamp,
 * so nothing is reused), as an instanced draw that animates would; then the merge of those 600 boxes into the
 * shader's fixed number of occluder boxes. Prints the search's and the merge's ms (mean, p95, max) and the
 * occluders found. The unit test checks what the search finds; how long it takes reads the host's load, so it is
 * reported here, not asserted. Node on this host's CPU; no browser.
 *
 *   --frames N     measured frames per round (default 600)
 *   --rounds N     rounds (default 3)
 */
import * as THREE from 'three';
import { SEE_THROUGH_DEFAULTS, SEE_THROUGH_OCCLUDERS } from '@thirdlight/project-model';
import { SeeThroughView } from '@thirdlight/three-adapter';

import { mergeToFit, SEE_THROUGH_MEMBERS_KEY, type PackedBox, type SeeThroughMembers } from '../../packages/three-adapter/src/see-through-occluders';
import { summarize } from './stats';

const WARMUP_FRAMES = 60;

function arg(argv: readonly string[], name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? Number(argv[i + 1]) : fallback;
}

/** A hedge of 600 small bushes (10 across, 10 up, 6 deep) in front of a character at the origin. */
function hedge(): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) for (let k = 0; k < 6; k++) out.push(new THREE.Box3(new THREE.Vector3(-0.5 + i * 0.1, j * 0.3, 1 + k * 0.1), new THREE.Vector3(-0.42 + i * 0.1, j * 0.3 + 0.25, 1.08 + k * 0.1)));
  return out;
}

/** The follow camera: 9 m from the character's middle, 52° down. */
function followCamera(): THREE.PerspectiveCamera {
  const a = THREE.MathUtils.degToRad(52);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
  camera.position.set(0, 0.9 + 9 * Math.sin(a), 9 * Math.cos(a));
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function round(frames: number): { searchMs: number[]; mergeMs: number[]; occluders: number } {
  const hero = new THREE.Object3D();
  hero.updateMatrixWorld(true);
  const bushes = hedge();
  const draw = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 0.6));
  draw.position.set(0, 1.5, 1.3);
  draw.updateMatrixWorld(true);
  let stamp = 0;
  draw.userData[SEE_THROUGH_MEMBERS_KEY] = { count: () => bushes.length, box: (i, out) => (out.copy(bushes[i]!), true), stamp: () => stamp } satisfies SeeThroughMembers;
  const camera = followCamera();
  const view = new SeeThroughView(
    {
      matrix: (id, out) => (id === 'hero' ? (out.copy(hero.matrixWorld), true) : false),
      drawn: (id) => (id === 'hero' ? [hero] : []),
      components: () => ({ controller: { capsule: { radius: 0.3, height: 1.8, offset: [0, 0.9] } } }),
      cameraTarget: () => 'hero',
      occluderLayers: () => [],
    },
    { ...SEE_THROUGH_DEFAULTS, enabled: true, fadeTime: 0 },
  );
  const frame = (): { contextNode: { value: object; needsUpdate: boolean } } => ({ contextNode: { value: {}, needsUpdate: false } });
  view.update(frame(), camera, 0);
  view.fill(camera);
  view.bitsFor(draw, camera);
  const searchMs: number[] = [];
  for (let f = 0; f < WARMUP_FRAMES + frames; f++) {
    stamp += 1;
    const t = performance.now();
    view.update(frame(), camera, 32 + f * 16);
    if (f >= WARMUP_FRAMES) searchMs.push(performance.now() - t);
    // Drawn this frame, as a renderer draws it: a member draw not drawn for a while is let go.
    view.fill(camera);
    view.bitsFor(draw, camera);
  }
  const occluders = view.diagnostics().subjects[0]?.occluders ?? 0;
  const mergeMs: number[] = [];
  for (let f = 0; f < Math.max(10, frames / 10); f++) {
    const many: PackedBox[] = bushes.map((b) => ({ min: b.min.clone(), max: b.max.clone(), nudge: 0, fade: 1 }));
    const t = performance.now();
    mergeToFit(many, SEE_THROUGH_OCCLUDERS);
    mergeMs.push(performance.now() - t);
  }
  return { searchMs, mergeMs, occluders };
}

export async function runSeeThroughBenchCli(argv: readonly string[]): Promise<void> {
  const frames = arg(argv, 'frames', 600);
  const rounds = arg(argv, 'rounds', 3);
  const fmt = (xs: number[]): string => {
    const s = summarize(xs);
    return `mean ${s.mean.toFixed(3)} p95 ${s.p95.toFixed(3)} max ${s.max.toFixed(3)} ms`;
  };
  for (let r = 1; r <= rounds; r++) {
    const { searchMs, mergeMs, occluders } = round(frames);
    console.log(`see-through-cpu round ${r}: search over 600 instanced members (${occluders} occluders found) ${fmt(searchMs)}; merge of 600 boxes into ${SEE_THROUGH_OCCLUDERS} ${fmt(mergeMs)}`);
  }
}
