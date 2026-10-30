/**
 * The tracer run's architecture and model cases (tracer-run.ts): a district
 * of generated buildings from the starter style, and a field of imported
 * static models (the starter character and generated props) traced by
 * their distance-field bricks, built here as an import builds them.
 */
import { mulberry32 } from '@thirdlight/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDistanceBricks, encodeDistanceBricks, readModelGeometry, type DistanceBricks } from '@thirdlight/project-model';
import { architectureStylesOf, expandArchitecture, type ArchitectureComponent } from '@thirdlight/runtime';

import { sceneView, traceRayCpu } from '../../packages/three-adapter/src/tracer-cpu';
import { TRACE_ARCH, TRACE_BRICKS, packTraceScene, worldToLocalOf } from '../../packages/three-adapter/src/tracer-scene';
import { traceArchitectureOf, traceModelInstancesOf } from '../../packages/three-adapter/src/tracer-sources';
import { REPO } from './backend';
import type { RaySource, TracerCaseSource } from './tracer-run';
import { propGlb } from './village-assets';

type V3 = [number, number, number];

/** Sources on the faces of boxes (centre, half, rotation) and on flat triangles. */
function archSources(arch: ReturnType<typeof traceArchitectureOf>, r: () => number): RaySource[] {
  const out: RaySource[] = [];
  for (const b of arch.boxes) {
    const [x, y, z, w] = b.rotation as [number, number, number, number];
    const axes: V3[] = [
      [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
      [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
      [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    ];
    // Texels in face order: a few per face, by its area (one per 0.25 m²).
    for (let f = 0; f < 6; f += 1) {
      const ax = f >> 1;
      const sg = f & 1 ? -1 : 1;
      const [ua, va] = [(ax + 1) % 3, (ax + 2) % 3];
      const n = axes[ax]!.map((v) => v * sg) as V3;
      const count = Math.min(64, Math.max(1, Math.round((4 * b.half[ua]! * b.half[va]!) / 0.25)));
      for (let k = 0; k < count; k += 1) {
        const su = (r() * 2 - 1) * b.half[ua]!;
        const sv = (r() * 2 - 1) * b.half[va]!;
        const p = [0, 1, 2].map((c) => b.center[c]! + n[c]! * b.half[ax]! + axes[ua]![c]! * su + axes[va]![c]! * sv) as V3;
        out.push({ p, n, kind: TRACE_ARCH });
      }
    }
  }
  const t = arch.triangles;
  for (let i = 0; i < t.length; i += 9) {
    const a: V3 = [t[i]!, t[i + 1]!, t[i + 2]!];
    const e1: V3 = [t[i + 3]! - a[0], t[i + 4]! - a[1], t[i + 5]! - a[2]];
    const e2: V3 = [t[i + 6]! - a[0], t[i + 7]! - a[1], t[i + 8]! - a[2]];
    const c: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...c) || 1;
    const count = Math.min(256, Math.max(1, Math.round(l / 2 / 0.25)));
    for (let k = 0; k < count; k += 1) {
      let u = r();
      let v = r();
      if (u + v > 1) [u, v] = [1 - u, 1 - v];
      out.push({ p: [a[0] + e1[0] * u + e2[0] * v, a[1] + e1[1] * u + e2[1] * v, a[2] + e1[2] * u + e2[2] * v], n: [c[0] / l, c[1] / l, c[2] / l], kind: TRACE_ARCH });
    }
  }
  return out;
}

/** 36 generated buildings (rooms, doors, hip roofs) on a 6 × 6 grid 16 m apart. */
function district(): TracerCaseSource {
  const styles = architectureStylesOf([]);
  const r = mulberry32(5);
  const objects: { component: ArchitectureComponent; origin: number[] }[] = [];
  for (let z = 0; z < 6; z += 1) {
    for (let x = 0; x < 6; x += 1) {
      const w = 6 + Math.floor(r() * 5);
      const d = 5 + Math.floor(r() * 4);
      const path = { points: [[0, 0, 0], [w, 0, 0], [w, 0, d], [0, 0, d]] as [number, number, number][], closed: true as const };
      const c: ArchitectureComponent = { elements: [], chunkSize: 16, buildings: [{ id: `b${x}-${z}`, preset: 'starter-room', outside: 'starter-hall', roof: { shape: 'hip' }, path }] } as ArchitectureComponent;
      const origin = [x * 16 - 48, 0, z * 16 - 48];
      objects.push({ component: expandArchitecture(c, origin, styles).component, origin });
    }
  }
  const arch = traceArchitectureOf(objects);
  console.log(`tracer: district ${arch.boxes.length} boxes, ${arch.triangles.length / 9} triangles`);
  return { name: 'arch', scene: { arch }, sources: archSources(arch, r) };
}

/** A model's bricks as the import makes them, with what it took. */
function bricksOf(name: string, glb: Uint8Array): DistanceBricks {
  const g = readModelGeometry(glb);
  if (!g.ok) throw new Error(`tracer: ${name}: ${g.message}`);
  const t0 = performance.now();
  const b = buildDistanceBricks(g.geometry);
  const ms = performance.now() - t0;
  const tris = g.geometry.primitives.filter((p) => !p.collision && !p.higherLod && !p.occluder).reduce((n, p) => n + p.triangles.length, 0);
  const sets = b.sets.map((s) => `${s.piece || 'whole'} ${s.dims.join('×')} bricks of ${(s.voxel * 100).toFixed(1)} cm, ${s.samples.length / 729} filled`).join('; ');
  console.log(`tracer: bricks of ${name} (${tris} triangles): ${sets}; ${encodeDistanceBricks(b).byteLength} B, made in ${ms.toFixed(0)} ms`);
  return b;
}

/** 400 placed models (four kinds, rotated and scaled) on a 100 m square; sources found on their surfaces by tracing in to them. */
function modelField(): TracerCaseSource {
  const kinds = [
    bricksOf('character.glb', new Uint8Array(readFileSync(join(REPO, 'templates', 'starter', 'assets', 'Character.glb')))),
    bricksOf('prop (3 parts, 48 × 32)', new Uint8Array(propGlb(11, { parts: 3, rings: 48, sides: 32, textureSize: 0 }))),
    bricksOf('prop (1 part, 24 × 16)', new Uint8Array(propGlb(12, { parts: 1, rings: 24, sides: 16, textureSize: 0 }))),
    bricksOf('prop (2 parts, 32 × 24)', new Uint8Array(propGlb(13, { parts: 2, rings: 32, sides: 24, textureSize: 0 }))),
  ];
  const r = mulberry32(8);
  const instances = [];
  const sources: RaySource[] = [];
  const probes: { pos: number[]; ext: number }[] = [];
  for (let i = 0; i < 400; i += 1) {
    const b = kinds[i % kinds.length]!;
    const pos = [(i % 20) * 5 - 50 + r(), 0, Math.floor(i / 20) * 5 - 50 + r()];
    const a = r() * Math.PI;
    const s = 0.8 + r() * 1.6;
    const toLocal = worldToLocalOf(pos, [0, Math.sin(a / 2), 0, Math.cos(a / 2)], [s, s, s]);
    instances.push(...traceModelInstancesOf(b, toLocal));
    probes.push({ pos, ext: Math.max(...b.sets[0]!.dims) * 8 * b.sets[0]!.voxel * s });
  }
  // Texels on the models' surfaces: probe rays from round each model in to it, kept where they hit.
  const view = sceneView(packTraceScene({ bricks: instances }));
  for (const { pos, ext } of probes) {
    for (let k = 0; k < 64; k += 1) {
      const ang = r() * Math.PI * 2;
      const o: V3 = [pos[0]! + Math.cos(ang) * ext, pos[1]! + r() * ext * 0.7, pos[2]! + Math.sin(ang) * ext];
      const d: V3 = [-Math.cos(ang), -0.1, -Math.sin(ang)];
      const l = Math.hypot(...d);
      const hit = traceRayCpu(view, o, [d[0] / l, d[1] / l, d[2] / l], 0, ext * 2);
      if (hit.kind !== TRACE_BRICKS) continue;
      sources.push({ p: [o[0] + (d[0] / l) * hit.t, o[1] + (d[1] / l) * hit.t, o[2] + (d[2] / l) * hit.t], n: hit.normal, kind: TRACE_BRICKS });
    }
  }
  return { name: 'bricks', scene: { bricks: instances }, sources };
}

export function extraTracerCases(): TracerCaseSource[] {
  return [district(), modelField()];
}
