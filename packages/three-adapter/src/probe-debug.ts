/**
 * The probe debug view (the editor's Scene view): every probe of the packed
 * tiles as a small sphere lit by its own light — the irradiance its
 * spherical harmonics give each direction, read from the same texture the
 * materials sample — with its validity as a rim: none for a valid probe,
 * yellow for one moved out of geometry, red for one filled from its
 * neighbours. Those sit inside geometry, so they are drawn over it (a second
 * instanced draw without the depth test). Rebuilt when the resident tiles
 * change (only the tiles near the camera are resident in a large world).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { PROBE_FILLED, PROBE_VALID } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { packedIrradiance, probeTextureNodes, samplePackedProbes, tableTexel, type ProbeLighting } from './probe-lighting';

const TSL: N = TSLTyped;
const { Fn, abs, attribute, float, int, mix, normalView, normalWorld, select, vec3 } = TSL;

/** A probe sphere's radius as a share of its tile's smallest spacing. */
const SPHERE_SHARE = 0.15;
/** Where the validity rim starts (1 − |n·view|). */
const RIM_FROM = 0.45;

export interface ProbeDebugView {
  /** Hang this in the scene (an overlay: never picked). */
  readonly object: THREE.Object3D;
  /** Follow the light's tiles (call per frame while shown). */
  update(): void;
  /** Probes drawn: all, and of those the ones moved or filled. */
  count(): number;
  invalid(): number;
  dispose(): void;
}

export function createProbeDebugView(light: ProbeLighting): ProbeDebugView {
  const group = new THREE.Group();
  group.name = 'probe debug';
  const sphere = new THREE.IcosahedronGeometry(1, 1);
  const t = probeTextureNodes(light);
  // Per probe: its tile's table row and its grid indices; its validity.
  const at = attribute('tlProbeAt', 'vec4');
  const validity = attribute('tlProbeValidity', 'float');
  const colour = Fn(() => {
    const of = tableTexel(t, int(at.x), 1);
    const rs = tableTexel(t, int(at.x), 2);
    // Diffuse light off a white surface: the irradiance over π.
    const lit = packedIrradiance(samplePackedProbes(t, at.yzw, of, rs), normalWorld).div(Math.PI);
    const rim = float(1).sub(abs(normalView.z)).greaterThan(RIM_FROM).and(validity.lessThan(PROBE_VALID));
    const tint = select(validity.greaterThan(PROBE_FILLED), vec3(1, 0.85, 0), vec3(1, 0.1, 0.1));
    return mix(lit, tint, select(rim, float(1), float(0)));
  })();
  const valid = new THREE.MeshBasicNodeMaterial();
  valid.colorNode = colour;
  const inside = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  inside.colorNode = colour;
  const meshes: THREE.InstancedMesh[] = [];
  let shown: readonly unknown[] | null = null;
  let total = 0;
  let invalid = 0;
  const clear = (): void => {
    for (const m of meshes) {
      group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    meshes.length = 0;
    total = 0;
    invalid = 0;
  };
  const rebuild = (): void => {
    clear();
    const kinds: { material: THREE.Material; at: number[]; validity: number[]; matrices: number[] }[] = [
      { material: valid, at: [], validity: [], matrices: [] },
      { material: inside, at: [], validity: [], matrices: [] },
    ];
    const matrix = new THREE.Matrix4();
    for (const tile of light.tiles) {
      const { min, max, resolution: r } = tile.grid;
      const step = [0, 1, 2].map((a) => (max[a]! - min[a]!) / (r[a]! - 1));
      const radius = Math.min(...step) * SPHERE_SHARE;
      for (let iz = 0; iz < r[2]; iz++) {
        for (let iy = 0; iy < r[1]; iy++) {
          for (let ix = 0; ix < r[0]; ix++) {
            const v = tile.validity[ix + iy * r[0] + iz * r[0] * r[1]]!;
            const k = kinds[v === PROBE_VALID ? 0 : 1]!;
            matrix.makeScale(radius, radius, radius).setPosition(min[0] + ix * step[0]!, min[1] + iy * step[1]!, min[2] + iz * step[2]!);
            for (const e of matrix.elements) k.matrices.push(e);
            k.at.push(tile.row, ix, iy, iz);
            k.validity.push(v);
          }
        }
      }
    }
    for (const k of kinds) {
      const n = k.validity.length;
      if (n === 0) continue;
      const geometry = sphere.clone();
      geometry.setAttribute('tlProbeAt', new THREE.InstancedBufferAttribute(new Float32Array(k.at), 4));
      geometry.setAttribute('tlProbeValidity', new THREE.InstancedBufferAttribute(new Float32Array(k.validity), 1));
      const m = new THREE.InstancedMesh(geometry, k.material, n);
      (m.instanceMatrix.array as Float32Array).set(k.matrices);
      m.instanceMatrix.needsUpdate = true;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      // The ones inside geometry last, over everything.
      m.renderOrder = k.material === inside ? 2 : 1;
      m.name = k.material === inside ? 'probe spheres (inside geometry)' : 'probe spheres';
      group.add(m);
      meshes.push(m);
      total += n;
      if (k.material === inside) invalid += n;
    }
  };
  return {
    object: group,
    update() {
      t.sync(light);
      if (light.tiles !== shown) {
        shown = light.tiles;
        rebuild();
      }
    },
    count: () => total,
    invalid: () => invalid,
    dispose() {
      clear();
      group.removeFromParent();
      sphere.dispose();
      valid.dispose();
      inside.dispose();
    },
  };
}
