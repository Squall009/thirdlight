/**
 * The clustered light lists' CPU cost (`node tools/perf/run.mjs clusters`):
 * the many-lights class's lights (lights.ts, 64, 256 and 1,000 point and
 * spot lights and its area lights) built and packed every frame on the main
 * thread, as the renderer will, with the camera swaying a little each frame
 * so nothing is reused that a moving camera would not reuse.
 *
 * Prints per count: lights handed in and packed, cells listed, build and
 * pack ms (mean and p95 over the frames), and the bytes a frame uploads
 * (the first frame grows the textures and uploads them whole; later frames
 * upload the written ranges). Node on this host's CPU; no browser.
 *
 *   --frames N     measured frames per round (default 600)
 *   --rounds N     rounds (default 3)
 */
import * as THREE from 'three';
import { CLUSTER_INDEX_WORDS, ClusterBuilder, ClusterLights, ClusterTextures, type ClusterLightValue } from '@thirdlight/three-adapter';
import { VIEW_LENS_DEFAULTS } from '@thirdlight/project-model';

import { LIGHTS_COUNTS, lightsPlan, type LightsPlan } from './lights';

/** The output's aspect the many-lights class is measured at (1920 × 1080). */
const ASPECT = 16 / 9;
const WARMUP_FRAMES = 120;

function hex(c: string, intensity: number): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  // sRGB to linear, then times the intensity, as the renderer's records carry it.
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [lin((n >> 16) & 255) * intensity, lin((n >> 8) & 255) * intensity, lin(n & 255) * intensity];
}

/** The class's lights as cluster values (every entity with a light component). */
function clusterValues(plan: LightsPlan): ClusterLightValue[] {
  const out: ClusterLightValue[] = [];
  for (const scene of plan.scenes) {
    for (const e of scene.entities) {
      const c = e.components as Record<string, Record<string, unknown> | undefined>;
      const l = c['light'];
      const at = (c['transform']?.['position'] as number[] | undefined) ?? [0, 0, 0];
      if (l === undefined) continue;
      const color = hex(l['color'] as string, l['intensity'] as number);
      const reach = l['range'] as number;
      if (l['type'] === 'point') out.push({ kind: 'point', position: at, reach, color });
      else if (l['type'] === 'spot') {
        const d = new THREE.Vector3(...(l['direction'] as [number, number, number])).normalize();
        const half = THREE.MathUtils.degToRad((l['angle'] as number) / 2);
        out.push({ kind: 'spot', position: at, reach, color, direction: d.toArray(), cosOuter: Math.cos(half), cosInner: Math.cos(half * (1 - (l['penumbra'] as number))) });
      } else if (l['type'] === 'area') {
        // Rect in its local XZ plane, a line along local X, both shining down (the class's transform has no rotation).
        const w = (l['width'] as number) / 2;
        const h = ((l['height'] as number | undefined) ?? 0) / 2;
        out.push({ kind: l['shape'] === 'line' ? 'line' : 'rect', position: at, reach, color, direction: [0, -1, 0], u: [w, 0, 0], v: [0, 0, h] });
      }
    }
  }
  return out;
}

function stats(xs: number[]): { mean: number; p95: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0 };
}

export async function runClusterBenchCli(argv: string[]): Promise<void> {
  const num = (name: string, d: number): number => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const frames = num('frames', 600);
  const rounds = num('rounds', 3);
  console.log(`clusters: ${frames} frames x ${rounds} rounds a count, ${WARMUP_FRAMES} warm-up frames, fov ${VIEW_LENS_DEFAULTS.fovY}, aspect 16:9`);
  for (const count of LIGHTS_COUNTS) {
    const plan = lightsPlan(count);
    const values = clusterValues(plan);
    const cam = new THREE.PerspectiveCamera(VIEW_LENS_DEFAULTS.fovY, ASPECT, VIEW_LENS_DEFAULTS.near, 500);
    const lights = new ClusterLights();
    for (const v of values) lights.add(v);
    for (let round = 0; round < rounds; round += 1) {
      const builder = new ClusterBuilder();
      const tex = new ClusterTextures();
      const buildMs: number[] = [];
      const packMs: number[] = [];
      let firstUpload = 0;
      let upload = 0;
      let last = { packed: 0, entries: 0, overflow: 0, rows: 0 };
      for (let f = 0; f < WARMUP_FRAMES + frames; f += 1) {
        const t = f / 60;
        cam.position.set(plan.camera.eye[0] + Math.sin(t) * 0.5, plan.camera.eye[1], plan.camera.eye[2] + Math.cos(t * 0.7) * 0.5);
        cam.lookAt(...plan.camera.at);
        cam.updateMatrixWorld();
        const camera = { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, near: cam.near, far: cam.far };
        const t0 = performance.now();
        const build = builder.build(lights, camera, CLUSTER_INDEX_WORDS);
        const t1 = performance.now();
        const r = tex.pack(build, lights);
        const t2 = performance.now();
        if (f === 0) firstUpload = r.uploadBytes;
        if (f >= WARMUP_FRAMES) {
          buildMs.push(t1 - t0);
          packMs.push(t2 - t1);
          upload += r.uploadBytes;
        }
        last = { packed: build.packed, entries: build.entries, overflow: build.overflow, rows: r.rows };
      }
      const b = stats(buildMs);
      const p = stats(packMs);
      const total = stats(buildMs.map((x, i) => x + packMs[i]!));
      console.log(
        `clusters ${count} (round ${round + 1}): ${lights.count} lights, ${last.packed} packed, ${last.entries} cells listed, overflow ${last.overflow}; ` +
          `build ${b.mean.toFixed(3)} ms (p95 ${b.p95.toFixed(3)}), pack ${p.mean.toFixed(3)} (p95 ${p.p95.toFixed(3)}), total ${total.mean.toFixed(3)} (p95 ${total.p95.toFixed(3)}); ` +
          `upload ${Math.round(upload / frames)} B a frame (first frame ${firstUpload} B), texture ${last.rows} rows`,
      );
    }
  }
}
