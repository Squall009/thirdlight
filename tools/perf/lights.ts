/**
 * The many-lights perf class (`node tools/perf/run.mjs lights …`, lights-run.ts):
 * a field of N local lights over a lit floor and a grid of pillars, built
 * through the backend's commands so every run draws the same content.
 *
 * - N point and spot lights (two points to one spot, the spots pointing down
 *   with a tilt), on a jittered grid over the field at 1.5–3 m, each reaching
 *   `range` metres: with the default range a floor point sees about 4 lights
 *   at 64, 18 at 256 and 70 at 1,000 (`meanLightsReaching`), so the cost is
 *   the per-pixel light count, not just the list length.
 * - `shadowed` of them cast a shadow (spots and points alternating, spread
 *   evenly through the list).
 * - A few area lights (rects and lines) near the field's corners.
 * - A dim sun and a dark sky, so the local lights carry the picture.
 * - The floor is static; the pillars are not (so the lights reach them per
 *   pixel whatever the static surfaces' light path is).
 *
 * A scene holds at most the model's realtime point and spot lights per
 * scene, so the lights are spread over as many start scenes as that takes
 * (all loaded at once: the renderer then picks what it can draw). Pure: the
 * plan is fixed for a count and its options.
 */
import { MAX_LOCAL_LIGHTS } from '@thirdlight/project-model';

import type { EntityValue } from './generate';
import { lookRotation, LOOK_POST } from './look';

type Vec3 = [number, number, number];

export const LIGHTS_COUNTS = [64, 256, 1000] as const;

export const LIGHTS_SPEC = {
  /** The field's side (m), centred on the origin. */
  field: 48,
  /** Metres between pillars, and a pillar's footprint and height. */
  pillarStep: 6,
  pillar: [1, 2.4, 1] as Vec3,
  /** A local light's reach (m) unless `--range` says otherwise. */
  range: 8,
  /** Local lights casting a shadow unless `--shadowed` says otherwise. */
  shadowed: 8,
  /** Area lights: rects and lines, none shadowed (they are not local lights). */
  areaRects: 2,
  areaLines: 2,
  /** One spot per this many local lights; the rest are points. */
  spotEvery: 3,
  intensity: 6,
  eye: [0, 24, 36] as Vec3,
  at: [0, 0, -2] as Vec3,
} as const;

export interface LightsOptions {
  range: number;
  shadowed: number;
}

export const DEFAULT_LIGHTS_OPTIONS: LightsOptions = { range: LIGHTS_SPEC.range, shadowed: LIGHTS_SPEC.shadowed };

export interface LightsScene {
  sceneId: string;
  name: string;
  entities: EntityValue[];
}

export interface LightsPlan {
  count: number;
  options: LightsOptions;
  /** The first is `scene-main` (the floor, pillars, area lights and the first lights); all are start scenes. */
  scenes: LightsScene[];
  /** The local lights' places and reach, for the coverage figure. */
  locals: { at: Vec3; kind: 'point' | 'spot'; shadowed: boolean }[];
  counts: { point: number; spot: number; area: number; shadowedPoint: number; shadowedSpot: number };
  camera: { eye: Vec3; at: Vec3 };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const T = (at: Vec3): Record<string, unknown> => ({ position: at.map(r3), rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** A small deterministic generator (the plan must not change between runs). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A saturated colour for light `i` (hues spread round the wheel). */
function hueColor(i: number): string {
  const h = (i * 0.61803398875) % 1;
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return 0.7 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The indexes of `k` lights spread evenly through `n`. */
function spreadIndexes(n: number, k: number): Set<number> {
  const out = new Set<number>();
  const m = Math.min(n, Math.max(0, k));
  for (let j = 0; j < m; j += 1) out.add(Math.floor(((j + 0.5) * n) / m));
  return out;
}

export function lightsPlan(count: number, options: LightsOptions = DEFAULT_LIGHTS_OPTIONS): LightsPlan {
  if (!Number.isInteger(count) || count < 1) throw new Error(`lights: a count is a whole number ≥ 1, not ${count}`);
  const S = LIGHTS_SPEC;
  const rnd = mulberry32(43 + count);
  const half = S.field / 2;
  const main: EntityValue[] = [
    { id: 'floor', name: 'Floor', static: true, components: { transform: T([0, -0.1, 0]), box: { size: [S.field, 0.2, S.field] }, surface: { color: '#9a958c', roughness: 0.6, metalness: 0 } } },
  ];
  let pillarN = 0;
  for (let x = -half + S.pillarStep / 2; x < half; x += S.pillarStep) {
    for (let z = -half + S.pillarStep / 2; z < half; z += S.pillarStep) {
      pillarN += 1;
      main.push({ id: `pillar-${pillarN}`, name: `Pillar ${pillarN}`, components: { transform: T([x, S.pillar[1] / 2, z]), box: { size: [...S.pillar] }, surface: { color: '#b8b2a8', roughness: 0.5, metalness: 0 } } });
    }
  }
  // Area lights near the corners, shining down (a rect in its local XZ plane; a line along local X).
  for (let i = 0; i < S.areaRects + S.areaLines; i += 1) {
    const rect = i < S.areaRects;
    const [sx, sz] = [i % 2 === 0 ? -1 : 1, i < 2 ? -1 : 1];
    main.push({
      id: `area-${i + 1}`,
      name: `Area ${i + 1}`,
      components: {
        transform: T([sx * half * 0.7, 3.5, sz * half * 0.7]),
        light: rect ? { type: 'area', shape: 'rect', width: 2, height: 1, color: hueColor(1000 + i), intensity: 30, range: S.range, castShadow: false } : { type: 'area', shape: 'line', width: 4, color: hueColor(1000 + i), intensity: 20, range: S.range, castShadow: false },
      },
    });
  }
  // The local lights on a jittered grid: `side` cells per side, the first `count` cells in a shuffled order.
  const side = Math.ceil(Math.sqrt(count));
  const cell = S.field / side;
  const cells = Array.from({ length: side * side }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  const shadowed = spreadIndexes(count, options.shadowed);
  const locals: LightsPlan['locals'] = [];
  const lightEntities: EntityValue[] = [];
  const counts = { point: 0, spot: 0, area: S.areaRects + S.areaLines, shadowedPoint: 0, shadowedSpot: 0 };
  let shadowN = 0;
  for (let i = 0; i < count; i += 1) {
    const c = cells[i]!;
    const at: Vec3 = [-half + ((c % side) + 0.15 + 0.7 * rnd()) * cell, 1.5 + 1.5 * rnd(), -half + (Math.floor(c / side) + 0.15 + 0.7 * rnd()) * cell];
    const kind: 'point' | 'spot' = i % S.spotEvery === S.spotEvery - 1 ? 'spot' : 'point';
    const casts = shadowed.has(i);
    // Shadowed lights alternate spot and point whatever their place in the list, so both shadow kinds are measured.
    const k: 'point' | 'spot' = casts ? (shadowN++ % 2 === 0 ? 'spot' : 'point') : kind;
    const base = { color: hueColor(i), intensity: S.intensity, range: options.range, castShadow: casts };
    const tilt = (): number => r3((rnd() - 0.5) * 0.8);
    const light = k === 'spot' ? { type: 'spot', ...base, direction: [tilt(), -1, tilt()], angle: 50, penumbra: 0.3 } : { type: 'point', ...base };
    counts[k] += 1;
    if (casts) counts[k === 'spot' ? 'shadowedSpot' : 'shadowedPoint'] += 1;
    locals.push({ at, kind: k, shadowed: casts });
    lightEntities.push({ id: `light-${i + 1}`, name: `${k === 'spot' ? 'Spot' : 'Point'} ${i + 1}`, components: { transform: T(at), light } });
  }
  const scenes: LightsScene[] = [];
  for (let s = 0; s * MAX_LOCAL_LIGHTS < count; s += 1) {
    const part = lightEntities.slice(s * MAX_LOCAL_LIGHTS, (s + 1) * MAX_LOCAL_LIGHTS);
    scenes.push(s === 0 ? { sceneId: 'scene-main', name: 'Main', entities: [...main, ...part] } : { sceneId: `lights-${s + 1}`, name: `Lights ${s + 1}`, entities: part });
  }
  return { count, options, scenes, locals, counts, camera: { eye: S.eye, at: S.at } };
}

/** The mean number of local lights whose reach covers a floor point, over a grid of the field (cones ignored). */
export function meanLightsReaching(plan: Pick<LightsPlan, 'locals' | 'options'>, step = 1): number {
  const half = LIGHTS_SPEC.field / 2;
  let sum = 0;
  let n = 0;
  for (let x = -half + step / 2; x < half; x += step) {
    for (let z = -half + step / 2; z < half; z += step) {
      for (const l of plan.locals) if (Math.hypot(l.at[0] - x, l.at[1], l.at[2] - z) <= plan.options.range) sum += 1;
      n += 1;
    }
  }
  return Math.round((sum / n) * 10) / 10;
}

/** The camera's place and rotation for `setTransform`. */
export function lightsCamera(plan: LightsPlan): { position: Vec3; rotation: [number, number, number, number] } {
  return { position: plan.camera.eye, rotation: lookRotation(plan.camera.eye, plan.camera.at) };
}

/** The look of the class: a dim sun, a dark sky, the look scenes' post stack. */
export const LIGHTS_SUN = { type: 'directional', color: '#9fb0d0', intensity: 0.1, direction: [0.3, -0.8, -0.5], castShadow: true } as const;
export const LIGHTS_ENVIRONMENT = { sky: { mode: 'color', color: '#0b0e16', environmentIntensity: 0.2 }, post: LOOK_POST } as const;
