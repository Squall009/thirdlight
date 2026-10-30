/**
 * The clustered light lists against brute force, through the real build,
 * the real packing and the shader's decode written as plain code:
 *
 * - no false negative: over 10,000 random point, spot, rect and line lights
 *   and cameras (perspective, off-axis, orthographic), every cell any of
 *   whose corners or centre lies in a light's volume lists that light, read
 *   back from the packed textures (the false-positive share is printed);
 * - the cone and box tests against points sampled through random boxes;
 * - the records and lists round-trip through the decode, long lists too;
 * - over the index budget the lowest-ranked lights are the ones left out,
 *   never the nearest;
 * - the render size does not change the lists.
 *
 * Browser-free.
 */
import { mulberry32 } from '@thirdlight/shared';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { areaHitsBox, CLUSTER_SLICES, CLUSTER_SPOT, ClusterBuilder, ClusterLights, sphereHitsBox, spotHitsBox, type ClusterCamera, type ClusterLightValue } from './cluster-build';
import { CLUSTER_INDEX_WORDS, CLUSTER_LIGHT_TEXELS, CLUSTER_LONG_LIST, CLUSTER_CUBE_SHADOW_TEXELS, CLUSTER_SHADOW_TEXELS, ClusterShadows, ClusterTextures, decodeClusterCell, decodeClusterCubeShadow, decodeClusterLight, decodeClusterList, decodeClusterShadow } from './cluster-pack';

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

function unit(rnd: () => number): V3 {
  for (;;) {
    const v: V3 = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const l = len(v);
    if (l > 0.1 && l <= 1) return scale(v, 1 / l);
  }
}

/** A light value and the brute-force membership of its volume (world space). */
interface Probe {
  value: ClusterLightValue;
  /** A sphere holding the whole volume. */
  bound: number;
  inside(p: V3): boolean;
}

function randomLight(rnd: () => number, around: V3, spread: number): Probe {
  const kinds = ['point', 'spot', 'rect', 'line'] as const;
  const kind = kinds[Math.floor(rnd() * 4)]!;
  const c: V3 = [around[0] + (rnd() * 2 - 1) * spread, around[1] + (rnd() * 2 - 1) * spread * 0.4, around[2] + (rnd() * 2 - 1) * spread];
  const reach = 0.3 + rnd() * 12;
  const color: V3 = [rnd() * 5, rnd() * 5, rnd() * 5];
  if (kind === 'point') return { value: { kind, position: c, reach, color }, bound: reach, inside: (p) => len(sub(p, c)) <= reach };
  if (kind === 'spot') {
    const axis = unit(rnd);
    const cosOuter = Math.cos((2 + rnd() * 88) * (Math.PI / 180));
    return {
      value: { kind, position: c, reach, color, direction: axis, cosOuter, cosInner: Math.min(1, cosOuter + 0.05) },
      bound: reach,
      inside: (p) => {
        const d = sub(p, c);
        const l = len(d);
        return l <= reach && (l < 1e-9 || dot(d, axis) / l >= cosOuter);
      },
    };
  }
  const u = scale(unit(rnd), 0.05 + rnd() * 3);
  const across = norm(cross(u, unit(rnd)));
  const twoSided = rnd() < 0.3;
  if (kind === 'rect') {
    const v = scale(across, 0.05 + rnd() * 2);
    const facing = scale(norm(cross(u, v)), rnd() < 0.5 ? 1 : -1);
    return {
      value: { kind, position: c, reach, color, direction: facing, u, v, twoSided },
      bound: reach,
      inside: (p) => {
        const d = sub(p, c);
        return dot(d, d) <= reach * reach && (twoSided || dot(d, facing) >= 0);
      },
    };
  }
  // A line: within reach of its centre (where the loop cuts an area light off), on its facing side unless two-sided.
  const facing = across;
  return {
    value: { kind, position: c, reach, color, direction: facing, u, twoSided },
    bound: reach,
    inside: (p) => {
      const d = sub(p, c);
      return dot(d, d) <= reach * reach && (twoSided || dot(d, facing) >= 0);
    },
  };
}

function clusterCamera(cam: THREE.Camera & { near: number; far: number }): ClusterCamera {
  cam.updateMatrixWorld();
  return { view: cam.matrixWorldInverse.elements, projection: cam.projectionMatrix.elements, near: cam.near, far: cam.far };
}

/**
 * Every cell's corners and centre in world space, from the grid's planes
 * and the camera's inverse projection (not the build's own edge maths).
 */
function cellSamples(cam: THREE.Camera, tilesX: number, tilesY: number, planes: number[]): Float64Array {
  const inv = cam.projectionMatrixInverse;
  const at = (nx: number, ny: number, depth: number): THREE.Vector3 => {
    // The view ray through (nx, ny) cut at view z = -depth.
    const a = new THREE.Vector3(nx, ny, -1).applyMatrix4(inv);
    const b = new THREE.Vector3(nx, ny, 1).applyMatrix4(inv);
    const t = (-depth - a.z) / (b.z - a.z);
    return a.lerp(b, t).applyMatrix4(cam.matrixWorld);
  };
  const S = planes.length - 1;
  const out = new Float64Array(tilesX * tilesY * S * 9 * 3);
  let o = 0;
  for (let k = 0; k < S; k += 1) {
    for (let j = 0; j < tilesY; j += 1) {
      for (let i = 0; i < tilesX; i += 1) {
        const pts: THREE.Vector3[] = [];
        for (const dk of [k, k + 1]) for (const dj of [j, j + 1]) for (const di of [i, i + 1]) pts.push(at(-1 + (2 * di) / tilesX, -1 + (2 * dj) / tilesY, planes[dk]!));
        const centre = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / 8);
        for (const p of [...pts, centre]) {
          out[o++] = p.x;
          out[o++] = p.y;
          out[o++] = p.z;
        }
      }
    }
  }
  return out;
}

interface Round {
  cam: THREE.Camera & { near: number; far: number };
  probes: Probe[];
}

/** Build, pack, read every list back, and compare with brute force: [false negatives, listed pairs, listed pairs no sample reaches]. */
function checkRound(r: Round): { misses: string[]; listed: number; empty: number; packed: number } {
  const lights = new ClusterLights();
  for (const p of r.probes) lights.add(p.value);
  const build = new ClusterBuilder().build(lights, clusterCamera(r.cam), CLUSTER_INDEX_WORDS);
  const tex = new ClusterTextures();
  tex.pack(build, lights);
  const g = build.grid;
  const n = r.probes.length;
  const listed = new Uint8Array(n * g.clusters);
  for (let c = 0; c < g.clusters; c += 1) for (const slot of decodeClusterList(tex.data, tex.listWord, g.clusters, c)) listed[build.order[slot]! * g.clusters + c] = 1;
  const planes = [r.cam.near];
  for (let k = 1; k <= g.slices; k += 1) planes.push(g.sliceNear * (g.sliceFar / g.sliceNear) ** (k / g.slices));
  const samples = cellSamples(r.cam, g.tilesX, g.tilesY, planes);
  const misses: string[] = [];
  let listedN = 0;
  let empty = 0;
  const radius = new Float64Array(g.clusters);
  for (let cell = 0; cell < g.clusters; cell += 1) {
    const o = cell * 27;
    for (let q = 0; q < 8; q += 1) radius[cell] = Math.max(radius[cell]!, Math.hypot(samples[o + q * 3]! - samples[o + 24]!, samples[o + q * 3 + 1]! - samples[o + 25]!, samples[o + q * 3 + 2]! - samples[o + 26]!));
  }
  for (let li = 0; li < n; li += 1) {
    const p = r.probes[li]!;
    const c = p.value.position as V3;
    for (let cell = 0; cell < g.clusters; cell += 1) {
      const o = cell * 27;
      const has = listed[li * g.clusters + cell] === 1;
      if (has) listedN += 1;
      if (Math.hypot(samples[o + 24]! - c[0], samples[o + 25]! - c[1], samples[o + 26]! - c[2]) > p.bound + radius[cell]!) {
        if (has) empty += 1;
        continue;
      }
      let reached = false;
      for (let q = 0; q < 9 && !reached; q += 1) reached = p.inside([samples[o + q * 3]!, samples[o + q * 3 + 1]!, samples[o + q * 3 + 2]!]);
      if (reached && !has) misses.push(`${p.value.kind} light ${li} not in cell ${cell}`);
      if (has && !reached) empty += 1;
    }
  }
  return { misses, listed: listedN, empty, packed: build.packed };
}

describe('cluster lists', () => {
  it('list every light in every cell its volume reaches (10,000 random lights, no false negative)', () => {
    const rnd = mulberry32(43);
    let listed = 0;
    let empty = 0;
    let packed = 0;
    const misses: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const aspect = [16 / 9, 4 / 3, 21 / 9, 1, 9 / 16][round % 5]!;
      let cam: THREE.Camera & { near: number; far: number };
      if (round === 9) {
        const o = new THREE.OrthographicCamera(-20 * aspect, 20 * aspect, 20, -20, 0.1, 120);
        cam = o;
      } else {
        const p = new THREE.PerspectiveCamera(35 + rnd() * 60, aspect, round % 3 === 0 ? 0.05 : 0.3, 80 + rnd() * 200);
        // One off-axis view (the editor's split views and offsets use one).
        if (round === 4) p.setViewOffset(1920, 1080, 300, -120, 1280, 720);
        cam = p;
      }
      cam.position.set((rnd() * 2 - 1) * 20, 1 + rnd() * 10, (rnd() * 2 - 1) * 20);
      cam.lookAt(cam.position.x + (rnd() * 2 - 1) * 10, rnd() * 3, cam.position.z - 10 - rnd() * 10);
      (cam as THREE.PerspectiveCamera).updateProjectionMatrix();
      cam.updateMatrixWorld();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const around = cam.position.clone().addScaledVector(fwd, 18);
      const probes = Array.from({ length: 1000 }, () => randomLight(rnd, [around.x, around.y, around.z], 30));
      const r = checkRound({ cam, probes });
      misses.push(...r.misses);
      listed += r.listed;
      empty += r.empty;
      packed += r.packed;
    }
    console.log(`cluster lists: ${packed} of 10000 lights packed, ${listed} light-cell pairs listed, false-positive share ${(empty / Math.max(1, listed)).toFixed(3)}`);
    expect(misses.slice(0, 10)).toEqual([]);
    expect(packed).toBeGreaterThan(2000);
  }, 120_000);

  it('spend the slices where the lights reach: lights far from the eye get shallow cells and still no false negative', () => {
    const rnd = mulberry32(29);
    // A field of lights seen from high up and far back: none reaches nearer than ~20 m.
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500);
    cam.position.set(0, 24, 36);
    cam.lookAt(0, 0, -2);
    cam.updateMatrixWorld();
    const probes = Array.from({ length: 400 }, () => randomLight(rnd, [0, 2, -4], 20)).filter((p) => cam.position.distanceTo(new THREE.Vector3(...(p.value.position as V3))) - p.bound > 20);
    const r = checkRound({ cam, probes });
    expect(r.misses.slice(0, 10)).toEqual([]);
    const lights = new ClusterLights();
    for (const p of probes) lights.add(p.value);
    const build = new ClusterBuilder().build(lights, clusterCamera(cam), CLUSTER_INDEX_WORDS);
    // The first slice starts no farther than the nearest light's box and well past the fixed 0.25 m floor.
    expect(build.grid.sliceNear).toBeGreaterThan(10);
    expect(build.grid.sliceNear).toBeLessThan(build.grid.sliceFar / 2 + 1e-9);
  });

  it('the cone and box tests never miss a box a volume reaches', () => {
    const rnd = mulberry32(7);
    let missed = 0;
    let hits = 0;
    for (let n = 0; n < 6000; n += 1) {
      const lo: V3 = [(rnd() * 2 - 1) * 10, (rnd() * 2 - 1) * 10, -rnd() * 30];
      const size: V3 = [0.05 + rnd() * 4, 0.05 + rnd() * 4, 0.05 + rnd() * 6];
      const box = [lo[0], lo[1], lo[2], lo[0] + size[0], lo[1] + size[1], lo[2] + size[2]];
      const p = randomLight(rnd, [lo[0] + size[0] / 2, lo[1] + size[1] / 2, lo[2] + size[2] / 2], 8);
      // The tests take view-space values; here the view is the identity, so world is view.
      const lights = new ClusterLights();
      lights.add(p.value);
      const c = p.value.position as V3;
      let test: boolean;
      if (p.value.kind === 'point') test = sphereHitsBox(c[0], c[1], c[2], p.value.reach, box);
      else if (p.value.kind === 'spot') {
        const a = p.value.direction as V3;
        test = spotHitsBox(c[0], c[1], c[2], p.value.reach, a[0], a[1], a[2], p.value.cosOuter!, Math.sqrt(1 - p.value.cosOuter! ** 2), box);
      } else {
        const ax = [...lights.u.subarray(0, 3), ...lights.v.subarray(0, 3), ...norm(cross([lights.u[0]!, lights.u[1]!, lights.u[2]!], [lights.v[0]!, lights.v[1]!, lights.v[2]!]))];
        test = areaHitsBox(c[0], c[1], c[2], p.value.reach, ax, 0, p.value.twoSided === true, box);
      }
      let reached = false;
      const steps = 7;
      for (let i = 0; i <= steps && !reached; i += 1) {
        for (let j = 0; j <= steps && !reached; j += 1) {
          for (let k = 0; k <= steps && !reached; k += 1) reached = p.inside([lo[0] + (size[0] * i) / steps, lo[1] + (size[1] * j) / steps, lo[2] + (size[2] * k) / steps]);
        }
      }
      if (reached) hits += 1;
      if (reached && !test) missed += 1;
    }
    expect(hits).toBeGreaterThan(1000);
    expect(missed).toBe(0);
    // A 4 m wide panel reaching 1 m (facing +y): a box 1.5 m along its side is in front of the panel but past the reach
    // from its centre, where the loop lights nothing, so no cell there lists it; one by its centre does.
    const panel = [2, 0, 0, 0, 0, 0.5, 0, 1, 0];
    expect(areaHitsBox(0, 0, 0, 1, panel, 0, false, [1.4, 0.1, -0.1, 1.6, 0.3, 0.1])).toBe(false);
    expect(areaHitsBox(0, 0, 0, 1, panel, 0, false, [-0.1, 0.1, -0.1, 0.1, 0.3, 0.1])).toBe(true);
  });

  it('round-trip records and lists through the shader decode, long lists too', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 300);
    cam.position.set(3, 4, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const rnd = mulberry32(99);
    const lights = new ClusterLights();
    const values: ClusterLightValue[] = [];
    // Shadow records: a spot's world → atlas matrix (here a light's own random one), its tile and biases; or a light
    // seen through faces: world → its frame, depth terms and six face tiles (one missing).
    const shadows = new ClusterShadows();
    const shadowMatrices = new Map<number, { cube: boolean; m: THREE.Matrix4 }>();
    for (let i = 0; i < 300; i += 1) {
      const p = randomLight(rnd, [0, 0, 0], 12).value;
      p.mask = Math.floor(rnd() * 255) + 1;
      if (i % 5 === 0) {
        const m = new THREE.Matrix4().makePerspective(-0.5, 0.5, 0.5, -0.5, 0.5, 9).multiply(new THREE.Matrix4().makeRotationY(i).setPosition(i % 7, 1, -i % 5));
        p.shadow = shadows.add({ matrix: m.elements, rect: [i / 512, 0.25, 0.125], intensity: 0.5 + i / 1000, near: 0.5, far: 9, bias: -0.0002, normalBias: 0.002 });
        shadowMatrices.set(p.shadow, { cube: false, m });
      } else if (i % 5 === 2) {
        const m = new THREE.Matrix4().makeRotationY(i).setPosition(i % 7, 1, -i % 5).invert();
        const faces = [0, 1, 2, 3, 4, 5].map((f): [number, number] | null => (f === 2 ? null : [f / 8, i / 512]));
        p.shadow = shadows.addCube({ matrix: m.elements, near: 0.5, far: 9, bias: -0.0002, normalBias: 0.004, depth: [1.05, -0.5], intensity: 0.75, size: 1 / 32, faces });
        shadowMatrices.set(p.shadow, { cube: true, m });
      } else p.shadow = -1;
      p.cookie = p.kind === 'spot' && i % 3 === 0 ? i : -1;
      p.decay = [2, 1, 0, 1.5][i % 4]!;
      // Room keys up to the layer word's float precision (2^24 / 256 rooms), and unbounded point and spot lights.
      p.room = i % 4 === 0 ? -1 : (i * 211) % 65535;
      p.unbounded = (p.kind === 'point' || p.kind === 'spot') && i % 2 === 0;
      values.push(p);
      lights.add(p);
    }
    // 1,400 small lights round one point in front of the camera: that point's cell has a long list.
    for (let i = 0; i < 1400; i += 1) {
      const v: ClusterLightValue = { kind: 'point', position: [0.01 * (i % 10), 0.01 * Math.floor(i / 10) * 0.1, 0], reach: 1, color: [1, 1, 1] };
      values.push(v);
      lights.add(v);
    }
    const build = new ClusterBuilder().build(lights, clusterCamera(cam), CLUSTER_INDEX_WORDS);
    const tex = new ClusterTextures();
    const packed = tex.pack(build, lights, shadows);
    expect(build.overflow).toBe(0);
    // The shadow records sit between the light records and the headers.
    expect(packed.listWord).toBe((build.packed * CLUSTER_LIGHT_TEXELS + shadows.texels) * 4);
    expect(shadows.texels).toBe(60 * CLUSTER_SHADOW_TEXELS + 60 * CLUSTER_CUBE_SHADOW_TEXELS);
    // Records: what went in, in view space.
    const view = cam.matrixWorldInverse;
    for (let s = 0; s < build.packed; s += 1) {
      const v = values[build.order[s]!]!;
      const d = decodeClusterLight(tex.data, s);
      const at = new THREE.Vector3(...(v.position as V3)).applyMatrix4(view);
      expect(d.position[0]).toBeCloseTo(at.x, 4);
      expect(d.position[1]).toBeCloseTo(at.y, 4);
      expect(d.position[2]).toBeCloseTo(at.z, 4);
      expect(d.reach).toBeCloseTo(v.reach, 5);
      expect(d.color[1]).toBeCloseTo(v.color[1]!, 5);
      expect(d.kind).toBe(['point', 'spot', 'rect', 'line'].indexOf(v.kind));
      expect(d.twoSided).toBe(v.kind !== 'point' && v.kind !== 'spot' && v.twoSided === true);
      expect(d.decay).toBe(v.decay ?? 2);
      expect(d.mask).toBe(v.mask ?? 255);
      expect(d.room).toBe(v.room ?? -1);
      expect(d.unbounded).toBe(v.unbounded === true);
      const slot = v.shadow ?? -1;
      expect(d.shadow).toBe(slot < 0 ? -1 : build.packed * CLUSTER_LIGHT_TEXELS + slot);
      if (slot >= 0) {
        // The record's matrix takes a view-space point where the world matrix takes its world point.
        const { cube, m } = shadowMatrices.get(slot)!;
        const world = new THREE.Vector3(...(v.position as V3)).add(new THREE.Vector3(0.3, -0.7, 0.2));
        const viewP = world.clone().applyMatrix4(view);
        const want = new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(m);
        const r = cube ? decodeClusterCubeShadow(tex.data, d.shadow) : decodeClusterShadow(tex.data, d.shadow);
        const got = r.rows.map((row) => row[0]! * viewP.x + row[1]! * viewP.y + row[2]! * viewP.z + row[3]!);
        for (const [k, c] of (['x', 'y', 'z', 'w'] as const).slice(0, r.rows.length).entries()) expect(got[k]!).toBeCloseTo(want[c], 3);
        if (!cube) {
          const spot = r as ReturnType<typeof decodeClusterShadow>;
          expect(spot.rect[0]).toBeCloseTo(build.order[s]! / 512, 6);
          expect(spot.rect[1]).toBe(0.25);
          expect([spot.near, spot.far, spot.normalBias]).toEqual([0.5, 9, Math.fround(0.002)]);
        } else {
          const c = r as ReturnType<typeof decodeClusterCubeShadow>;
          expect([c.near, c.far, c.depth[0], c.depth[1], c.intensity, c.size]).toEqual([0.5, 9, Math.fround(1.05), -0.5, 0.75, 1 / 32]);
          expect(c.faces[2]).toBeNull();
          expect(c.faces[5]![0]).toBeCloseTo(5 / 8, 6);
          expect(c.faces[5]![1]).toBeCloseTo(build.order[s]! / 512, 6);
        }
      }
      if (d.kind === CLUSTER_SPOT) {
        const ax = new THREE.Vector3(...(v.direction as V3)).transformDirection(view);
        expect(d.axis![0]).toBeCloseTo(ax.x, 5);
        expect(d.axis![2]).toBeCloseTo(ax.z, 5);
        expect(d.cosOuter).toBeCloseTo(v.cosOuter!, 6);
        expect(d.cookie).toBe(v.cookie ?? -1);
      }
      if (d.kind >= 2) {
        // u × v along the facing, in view space.
        const f = new THREE.Vector3(...(v.direction as V3)).transformDirection(view);
        const n = new THREE.Vector3(...d.u!).cross(new THREE.Vector3(...d.v!));
        expect(n.dot(f)).toBeGreaterThan(0);
        expect(Math.hypot(...d.u!)).toBeCloseTo(len(v.u as V3), 4);
      }
    }
    // Lists: each cell's slots, in rank order, exactly the build's entries.
    const g = build.grid;
    const want: number[][] = Array.from({ length: g.clusters }, () => []);
    let e = 0;
    for (let s = 0; s < build.packed; s += 1) for (; e < build.entryEnd[s]!; e += 1) want[build.entryCluster[e]!]!.push(s);
    let longest = 0;
    for (let c = 0; c < g.clusters; c += 1) {
      const got = decodeClusterList(tex.data, tex.listWord, g.clusters, c);
      expect(got).toEqual(want[c]);
      longest = Math.max(longest, got.length);
    }
    expect(longest).toBeGreaterThan(CLUSTER_LONG_LIST);
    expect(packed.listWords).toBe(g.clusters + build.entries + want.filter((l) => l.length >= CLUSTER_LONG_LIST).length);
    expect(packed.listWord).toBe(build.packed * 16 + shadows.texels * 4);
    // A pixel at the long list's point reads it.
    const ndc = new THREE.Vector3(0, 0, 0).project(cam);
    const depth = -new THREE.Vector3(0, 0, 0).applyMatrix4(view).z;
    const cell = decodeClusterCell(g, (ndc.x + 1) / 2, (ndc.y + 1) / 2, depth);
    expect(decodeClusterList(tex.data, tex.listWord, g.clusters, cell).length).toBeGreaterThan(1400);
    expect(g.slices).toBe(CLUSTER_SLICES);
  });

  it('over the index budget, leave out the lowest-ranked lights, never the nearest', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 300);
    cam.position.set(0, 2, 0);
    cam.lookAt(0, 2, -10);
    cam.updateMatrixWorld();
    const rnd = mulberry32(5);
    const lights = new ClusterLights();
    for (let i = 0; i < 400; i += 1) lights.add({ kind: 'point', position: [(rnd() * 2 - 1) * 20, rnd() * 4, -5 - rnd() * 40], reach: 4 + rnd() * 6, color: [1 + rnd() * 20, 1, 1] });
    // The nearest light, dim: ranks first all the same.
    const nearest = lights.add({ kind: 'point', position: [0, 2, -1.5], reach: 3, color: [0.001, 0.001, 0.001] });
    const builder = new ClusterBuilder();
    const full = builder.build(lights, clusterCamera(cam), CLUSTER_INDEX_WORDS);
    const fullEntries = full.entries;
    const fullOrder = Array.from(full.order);
    const fullEnd = Array.from(full.entryEnd);
    expect(full.overflow).toBe(0);
    const clusters = full.grid.clusters;
    const maxTexels = 2 * clusters + Math.floor(fullEntries / 2);
    const cut = builder.build(lights, clusterCamera(cam), maxTexels);
    expect(cut.entries).toBe(Math.floor(fullEntries / 2));
    expect(cut.overflow).toBeGreaterThan(0);
    expect(Array.from(cut.order)).toEqual(fullOrder);
    expect(cut.order[0]).toBe(nearest);
    // Every light ranked above the cut keeps all its cells; those below lose some or all; the one at the cut keeps a part.
    let partial = 0;
    for (let s = 0; s < cut.packed; s += 1) {
      const had = fullEnd[s]! - (s === 0 ? 0 : fullEnd[s - 1]!);
      const has = cut.entryEnd[s]! - (s === 0 ? 0 : cut.entryEnd[s - 1]!);
      if (fullEnd[s]! <= cut.entries) expect(has).toBe(had);
      else {
        if (had > 0) expect(has).toBeLessThan(had);
        if (has > 0) partial += 1;
      }
    }
    expect(partial).toBeLessThanOrEqual(1);
    // Overflow: the first light that did not fit and every light after it.
    const first = fullEnd.findIndex((end) => end > cut.entries);
    expect(cut.overflow).toBe(cut.packed - first);
    const tex = new ClusterTextures();
    expect(tex.pack(cut, lights).listWords).toBeLessThanOrEqual(maxTexels);
  });

  it('give the same lists whatever the render size, and a pixel its cell from its share of the screen', () => {
    const rnd = mulberry32(11);
    const values = Array.from({ length: 200 }, () => randomLight(rnd, [0, 0, -15], 15).value);
    const lists: Uint32Array[] = [];
    // The camera's aspect is the output's; the render scale and dynamic resolution only change the drawn size.
    for (const [w, h] of [
      [1920, 1080],
      [1280, 720],
      [960, 540],
    ] as const) {
      const cam = new THREE.PerspectiveCamera(70, 1920 / 1080, 0.1, 200);
      cam.position.set(0, 1.7, 0);
      cam.lookAt(0, 1, -10);
      cam.updateMatrixWorld();
      const lights = new ClusterLights();
      for (const v of values) lights.add(v);
      const build = new ClusterBuilder().build(lights, clusterCamera(cam), CLUSTER_INDEX_WORDS);
      const tex = new ClusterTextures();
      const r = tex.pack(build, lights);
      lists.push(tex.data.slice(0, r.texels * 4));
      // A pixel centre at this size lands in the tile its NDC position does.
      for (let n = 0; n < 200; n += 1) {
        const px = Math.floor(rnd() * w);
        const py = Math.floor(rnd() * h);
        const fx = (px + 0.5) / w;
        const fy = (py + 0.5) / h;
        const cell = decodeClusterCell(build.grid, fx, fy, 5);
        expect(cell % build.grid.tilesX).toBe(Math.floor(((fx * 2 - 1 + 1) / 2) * build.grid.tilesX));
      }
    }
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
  });
});
