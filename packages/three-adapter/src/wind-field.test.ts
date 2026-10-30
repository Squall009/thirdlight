/**
 * The wind map round the view against the CPU reference (`windAt`): zones
 * laid on by priority, blending in over their edge, a turned box and a
 * sphere; the map filled only when a zone, the wind or the eye's square
 * changes; the neutral gust pattern tiles; and the foliage shader's vertex
 * stage builds with the field (WGSL).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { fillWindMap, orderWindZones, placeWindZone, windAt, windValues, windZoneWeight, WIND_MAP_CHANNELS, type WindZoneComponent } from '@thirdlight/project-model';

import { createMaterialLibrary } from './material-library';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';
import { makeWindNoise, WIND_MAP_TEXEL_M, WIND_MAP_TEXELS, WIND_NOISE_TEXELS, WindField, type WindZoneLike } from './wind-field';

const GLOBAL = { direction: [1, 0] as [number, number], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 };

/** A world matrix: at (x, z), turned `yaw` radians about up, scaled `s`. */
function matrix(x: number, z: number, yaw = 0, s = 1): number[] {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, 3, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s)).toArray();
}

const ZONES: WindZoneLike[] = [
  // A calm, turned box, low priority.
  { key: 'b-box', zone: { shape: 'box', size: [60, 10, 30], blend: 8, strength: 0, gust: 0.1 }, matrix: matrix(10, -6, 0.6) },
  // A gale sphere over part of it, higher priority: it wins where both are whole.
  { key: 'a-sphere', zone: { shape: 'sphere', radius: 14, blend: 6, priority: 2, strength: 4, direction: [0, 1], speed: 12 }, matrix: matrix(22, 0) },
  // Same priority as the box: laid after it by key ('c' > 'b').
  { key: 'c-box', zone: { shape: 'box', size: [12, 4, 12], blend: 0, turbulence: 1 }, matrix: matrix(-14, -10, 0, 1.5) },
];

const placed = () => orderWindZones(ZONES.map((z) => placeWindZone(z.zone, z.key, z.matrix)));

describe('the wind map', () => {
  it('holds the reference wind at every texel centre', () => {
    const n = 48;
    const texel = 2;
    const out = new Float32Array(n * n * WIND_MAP_CHANNELS);
    const g = windValues(GLOBAL);
    const zones = placed();
    fillWindMap(out, g, zones, -48, -48, texel, n);
    let inZones = 0;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const ref = windAt(g, zones, -48 + (i + 0.5) * texel, -48 + (j + 0.5) * texel);
        const o = (j * n + i) * WIND_MAP_CHANNELS;
        const got = [...out.subarray(o, o + WIND_MAP_CHANNELS)];
        const want = [ref.dirX, ref.dirZ, ref.strength, ref.gust, ref.speed, ref.scale, ref.turbulence, ref.deviation];
        for (let c = 0; c < WIND_MAP_CHANNELS; c += 1) expect(got[c]).toBeCloseTo(want[c]!, 6);
        if (ref.strength !== g.strength || ref.turbulence !== g.turbulence) inZones += 1;
      }
    }
    expect(inZones).toBeGreaterThan(200);
  });

  it('lays zones on by priority, then key, each fading in over its blend inside its edge', () => {
    const g = windValues(GLOBAL);
    const zones = placed();
    // The sphere's centre: whole, over the box (priority 2 over 0).
    const centre = windAt(g, zones, 22, 0);
    expect([centre.strength, centre.dirX, centre.dirZ, centre.speed, centre.deviation]).toEqual([4, 0, 1, 12, 1]);
    // The sphere sets no gust: the box's (laid on first, part way into its blend there) shows through.
    const box = zones.find((z) => z.key === 'b-box')!;
    expect(centre.gust).toBeCloseTo(0.4 + (0.1 - 0.4) * windZoneWeight(box, 22, 0), 9);
    expect(windZoneWeight(box, 22, 0)).toBeGreaterThan(0);
    // Half way through the sphere's blend (3 m inside its 14 m edge) and outside the box: smoothstep(0.5) = 0.5 of it.
    const sphereOnly = windAt(g, zones, 22, 11);
    const inBox = (x: number, z: number): boolean => Math.min(box.halfX - Math.abs((x - box.x) * box.ax + (z - box.z) * box.az), box.halfZ - Math.abs(-(x - box.x) * box.az + (z - box.z) * box.ax)) > 0;
    expect(inBox(22, 11)).toBe(false);
    expect(sphereOnly.strength).toBeCloseTo(0.5 + (4 - 0.5) * 0.5, 9);
    expect(sphereOnly.deviation).toBeCloseTo(0.5, 9);
    // Outside every zone: the global wind exactly, the pattern untouched.
    const outside = windAt(g, zones, -60, 40);
    expect(outside).toEqual({ ...g, deviation: 0 });
    // The scaled box: a hard edge (blend 0) at 1.5 × 6 m from its centre.
    expect(windAt(g, zones, -14 + 8.9, -10).turbulence).toBe(1);
    expect(windAt(g, zones, -14 + 9.1, -10).turbulence).toBe(g.turbulence);
    // A strength-only zone leaves the pattern where it is (no flow reads there).
    expect(windAt(g, zones, -14, -10).deviation).toBe(0);
  });

  it('the field fills its map round the eye only when a zone, the wind or the eye\'s square changes', () => {
    const field = new WindField(TSL.uniform(0), async () => null, () => {}, () => {});
    field.setGlobal(GLOBAL);
    field.setZones(ZONES);
    field.setEye(3, 4);
    expect(field.state()).toMatchObject({ zones: 3, mapOn: true, fills: 1 });
    const read = (tex: 'mapA' | 'mapB', i: number, j: number): number[] => {
      const data = ((field as unknown as Record<string, THREE.DataTexture>)[tex]!.image.data as Uint16Array).subarray((j * WIND_MAP_TEXELS + i) * 4, (j * WIND_MAP_TEXELS + i) * 4 + 4);
      return [...data].map((h) => THREE.DataUtils.fromHalfFloat(h));
    };
    const [cx, cz] = field.state().centre;
    const x0 = cx - (WIND_MAP_TEXELS * WIND_MAP_TEXEL_M) / 2;
    const z0 = cz - (WIND_MAP_TEXELS * WIND_MAP_TEXEL_M) / 2;
    const g = windValues(GLOBAL);
    for (const [i, j] of [[37, 32], [34, 31], [28, 29], [10, 50]] as const) {
      const ref = windAt(g, placed(), x0 + (i + 0.5) * WIND_MAP_TEXEL_M, z0 + (j + 0.5) * WIND_MAP_TEXEL_M);
      const got = [...read('mapA', i, j), ...read('mapB', i, j)];
      const want = [ref.dirX, ref.dirZ, ref.strength, ref.gust, ref.speed, ref.scale, ref.turbulence, ref.deviation];
      for (let c = 0; c < 8; c += 1) expect(Math.abs(got[c]! - want[c]!)).toBeLessThanOrEqual(Math.abs(want[c]!) * 1e-3 + 1e-3);
    }
    // The same zones (new arrays, same values) and an eye in the same square: no fill.
    field.setZones(ZONES.map((z) => ({ ...z, matrix: [...(z.matrix as number[])] })));
    field.setEye(10, -5);
    expect(field.state().fills).toBe(1);
    // A zone moved, the eye across a square, the wind changed: a fill each.
    field.setZones(ZONES.map((z, k) => (k === 0 ? { ...z, matrix: matrix(11, -6, 0.6) } : z)));
    field.setEye(10, -5);
    field.setEye(60, -5);
    field.setGlobal({ ...GLOBAL, strength: 1 });
    field.setEye(60, -5);
    expect(field.state().fills).toBe(4);
    // Far from every zone: the map is off (the shaders read the global wind alone) and not filled.
    field.setEye(5000, 5000);
    expect(field.state()).toMatchObject({ mapOn: false, fills: 4 });
    field.dispose();
  });

  it('scrolls the gust pattern by the speed over time: a wind change, instant or blended, neither jumps nor races it', () => {
    const field = new WindField(TSL.uniform(0), async () => null, () => {}, () => {});
    const scroll = (): number => ((field as unknown as { scroll: { value: THREE.Vector4 } }).scroll.value.x);
    // The x travel (m) a frame moved the pattern, wrapped to the nearest (the scroll is kept in pattern widths).
    let last = NaN;
    const step = (): number => {
      const now = scroll();
      const d = now - last;
      last = now;
      return (d - Math.round(d)) * field.global().scale;
    };
    const dt = 1 / 60;
    let t = 600;
    field.setGlobal({ ...GLOBAL, speed: 6 } as never);
    field.tick(t);
    step();
    // Steady: 6 m/s, every frame.
    for (let i = 0; i < 30; i++) {
      field.tick((t += dt));
      expect(step()).toBeCloseTo(6 * dt, 6);
    }
    // A blend down to 2 m/s over 2 s (a new wind every frame): each frame moves it by that frame's speed.
    for (let i = 1; i <= 120; i++) {
      const speed = 6 + ((2 - 6) * i) / 120;
      field.setGlobal({ ...GLOBAL, speed } as never);
      field.tick((t += dt));
      const d = step();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(6 * dt + 1e-6);
    }
    // An instant change to 10 m/s: no jump, the new speed from here on.
    field.setGlobal({ ...GLOBAL, speed: 10 } as never);
    field.tick((t += dt));
    expect(step()).toBeLessThanOrEqual(10 * dt + 1e-6);
    field.tick((t += dt));
    expect(step()).toBeCloseTo(10 * dt, 6);
    field.dispose();
  });

  it('reports the strongest wind a zone may bring (what bounds a foliage draw\'s sway)', () => {
    const field = new WindField(TSL.uniform(0), async () => null, () => {}, () => {});
    field.setGlobal(GLOBAL);
    expect(field.maxAmount()).toBeCloseTo(0.9, 9);
    field.setZones(ZONES);
    expect(field.maxAmount()).toBeCloseTo(4.4, 9);
    field.dispose();
  });
});

describe('the neutral gust pattern', () => {
  it('spans the whole range and tiles (its edges meet as smoothly as its inside)', () => {
    const n = WIND_NOISE_TEXELS;
    const t = makeWindNoise();
    expect(Math.min(...t)).toBe(0);
    expect(Math.max(...t)).toBe(255);
    let inside = 0;
    let seam = 0;
    for (let y = 0; y < n; y += 1) {
      inside = Math.max(inside, Math.abs(t[y * n + 64]! - t[y * n + 63]!));
      seam = Math.max(seam, Math.abs(t[y * n]! - t[y * n + n - 1]!));
    }
    expect(seam).toBeLessThanOrEqual(inside * 1.5 + 2);
    expect(makeWindNoise()).toEqual(t);
  });
});

describe('the foliage shader with the wind field', () => {
  it('builds its vertex stage reading the map and the gust pattern, weighted by COLOR_0 and the height above the root', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([{ materialId: 'grass', name: 'grass', shader: 'foliage', params: {}, textures: {} }]);
    const geometry = new THREE.PlaneGeometry(0.2, 0.8);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes['position']!.count * 4).fill(1), 4));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    lib.apply(mesh, { '*': 'grass' });
    const zone: WindZoneComponent = { shape: 'sphere', radius: 5, direction: [0, 1] };
    lib.setWindZones([{ key: 'z', zone, matrix: matrix(0, 0) }]);
    lib.setViewEye(0, 1, 0);
    expect(lib.windState().mapOn).toBe(true);
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    // The map's two textures and the gust pattern are read with an explicit level in the vertex stage.
    expect((wgsl.match(/textureSampleLevel/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Foliage reads its object's frame: never merged into world space with other objects.
    expect((mesh.material as THREE.Material).userData['__tlObjectFrame']).toBe(true);
    lib.dispose();
  });
});
