/**
 * The probe bake ("Bake probes"): the indirect light at every probe of a
 * scene's probe tiles, from its static objects and its baked/mixed lights.
 *
 * It draws on the caller's WebGPU renderer (the Scene view's: the objects'
 * materials and textures are already there) into a scene of its own that
 * holds only what the bake sees — the static meshes with their materials,
 * the baked and mixed directional, point and spot lights with shadows — so
 * nothing else needs hiding (meshes of one material merged, so a cube face
 * is a few draws). Per probe a small cube map is rendered and
 * projected to L2 spherical harmonics on the GPU (the projection three's
 * `LightProbeGrid` uses), then read back.
 *
 * - Sky: what a probe sees where no object is — the sky's environment map
 *   (or the sky colour) plus the baked/mixed ambient and hemisphere lights as
 *   light from all directions. Surfaces are not lit by the sky directly
 *   (that light would reach them through closed walls); they get it with the
 *   bounces.
 * - Bounces: each extra pass draws the surfaces lit by the previous pass's
 *   probes too (the probe lighting the game draws with, probe-lighting.ts),
 *   one bounce per pass.
 * - Walls: the validity captures also read how far each probe sees along
 *   the axes; an edge between two probes that each see a surface before the
 *   other is cut there (`edgeWalls`), and the probe lighting keeps samples on
 *   their side of it.
 * - Validity: first a cube map of front faces (black) and back faces (white)
 *   at each probe. A probe seeing back faces in more than
 *   `PROBE_VALIDITY_THRESHOLD` of its directions is inside geometry; it is
 *   moved away from the back faces by a quarter, then half a spacing (a
 *   virtual offset: the probe keeps its grid place, its light is captured
 *   where it is free). A probe still inside is not captured and is filled
 *   from its valid neighbours (dilation), so light never comes from inside a
 *   wall.
 *
 * Browser-only (WebGPU; the WebGL 2 backend cannot read back cube captures
 * at this rate, and the bake stays the Scene view's work).
 */
import * as THREE from 'three';
import { Fn, Loop, array, cameraPosition, cubeTexture, float, frontFacing, int, normalWorldGeometry, pmremTexture, positionWorld, screenCoordinate, select, uniform, vec3, vec4 } from 'three/tsl';
import { CubeRenderTarget, MeshBasicNodeMaterial, NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { PROBE_FILLED, PROBE_MOVED, PROBE_VALID, PROBE_VALIDITY_THRESHOLD, probeCount, type ProbeGridBox, type ProbeGridRecord } from '@thirdlight/runtime';

import { aimBakeDirectional, bakeLocalLight, fittedBakeDirectional, readFloatTarget, type BakeLightInput } from './lightmap-baker';
import { atlasFromSamples, packProbeTexels } from './probe-artifact';
import { ProbeLighting } from './probe-lighting';
import { mergeLayout, mergeWorldGeometry, OBJECT_FRAME_KEY } from './static-merge';

export interface ProbeBakeMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material | THREE.Material[];
  /** Mesh space → world. */
  readonly matrixWorld: THREE.Matrix4;
}

export interface ProbeBakeInput {
  /** The Scene view's renderer (WebGPU backend). */
  readonly renderer: WebGPURenderer;
  readonly meshes: readonly ProbeBakeMesh[];
  /** The baked and mixed lights. */
  readonly lights: readonly BakeLightInput[];
  /** The sky the probes see: an environment map (PMREM) or a colour. */
  readonly sky: { readonly environment: THREE.Texture | null; readonly intensity: number; readonly color: THREE.Color | null; /** The sky's turn about +Y (radians; the live scene's `environmentRotation`). */ readonly rotation?: number };
  readonly grids: readonly ProbeGridBox[];
  readonly bounces: number;
  readonly onProgress?: (text: string, fraction: number) => void;
  readonly signal?: AbortSignal;
}

export interface BakedProbeTile {
  /** 27 floats per probe: the nine SH coefficients' RGB. */
  readonly sh: Float32Array;
  /** PROBE_VALID, PROBE_MOVED or PROBE_FILLED per probe. */
  readonly validity: Float32Array;
  /** 6 floats per probe: per axis, whether a surface cuts the edge to the next probe (1 or 0) and where (`edgeWalls`). */
  readonly walls: Float32Array;
}

export type ProbeBakeResult =
  | { ok: true; tiles: BakedProbeTile[]; millis: number; probes: number; moved: number; filled: number; captures: number }
  | { ok: false; code: 'bake_cancelled' | 'bake_unsupported' | 'bake_failed'; message: string };

/** Cube map face size of a radiance capture (pixels); a probe's SH needs only the low frequencies. */
const CUBE_SIZE = 16;
/** Directions integrated per projection (equal-area Fibonacci sphere). */
const SH_SAMPLES = 256;
/** Probes captured between read-backs (rows of the projection target). */
const CHUNK = 256;
/** Meshes of at most this many vertices are merged for the bake (props); larger ones are drawn as they are. */
const MERGE_VERTICES_MAX = 16_384;
/**
 * The world cell merged meshes share (m): small enough that a cube face still
 * leaves most of a level out of its view, large enough to gather a street's props.
 */
const MERGE_CELL_M = 16;
/** The virtual offsets tried, in spacings, away from the back faces. */
const OFFSET_STEPS = [0.25, 0.5];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Columns of a projection row: the nine SH coefficients, then what the probe sees along +x, −x, +y, −y, +z, −z. */
const ROW = 15;
const AXES: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** The SH DC basis times the sphere's area: a direction share of 1 everywhere projects to this. */
const DC_OF_ONE = 0.282095 * 4 * Math.PI;

/**
 * Projects the captured cube map to one SH coefficient per fragment (its
 * column); the last six columns read what the probe sees straight along each
 * axis. Alpha carries the row's marker.
 */
function projectionMaterial(cube: THREE.Texture, marker: ReturnType<typeof uniform>): NodeMaterial {
  const cubeNode = cubeTexture(cube as THREE.CubeTexture);
  const m = new NodeMaterial();
  m.outputNode = Fn(() => {
    const coef = int(screenCoordinate.x).toVar();
    const axis = array(AXES.map(([x, y, z]) => vec3(x, y, z))).element((coef.sub(9) as never as { max(v: number): { min(v: number): never } }).max(0).min(5));
    const along = cubeNode.sample(axis).level(float(0));
    const accum = vec3(0).toVar();
    Loop(SH_SAMPLES, ({ i }: { i: unknown }) => {
      const fi = float(i as never);
      const z = float(1).sub(fi.mul(2).add(1).div(SH_SAMPLES));
      const r = z.mul(z).oneMinus().max(0).sqrt();
      const phi = fi.mul(GOLDEN_ANGLE);
      const dir = vec3(r.mul(phi.cos()), z, r.mul(phi.sin())).toVar();
      const radiance = cubeNode.sample(dir).level(float(0)).rgb;
      const x = dir.x;
      const y = dir.y;
      const zc = dir.z;
      const basis = array([
        float(0.282095),
        y.mul(0.488603),
        zc.mul(0.488603),
        x.mul(0.488603),
        x.mul(y).mul(1.092548),
        y.mul(zc).mul(1.092548),
        zc.mul(zc).mul(3).sub(1).mul(0.315392),
        x.mul(zc).mul(1.092548),
        x.mul(x).sub(y.mul(y)).mul(0.546274),
      ]).element((coef as never as { min(v: number): never }).min(8));
      accum.addAssign(radiance.mul(basis));
    });
    return select(coef.lessThan(9), vec4(accum.mul((4 * Math.PI) / SH_SAMPLES), marker as never), vec4(along.rgb, marker as never));
  })();
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

/** What a probe sees where no object is: the sky's map or colour, plus the ambient and hemisphere lights as radiance. */
function skyNode(sky: ProbeBakeInput['sky'], lights: readonly BakeLightInput[]): ReturnType<typeof vec3> {
  const dir = normalWorldGeometry.normalize();
  // The bake scene has no environment of its own, so three's environment rotation is not applied here:
  // the map is sampled the way the live scene's turned sky shows it (Ry(θ)ᵀ·d, as `materialEnvRotation`).
  const turn = sky.rotation ?? 0;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const lookup = turn === 0 ? dir : vec3(dir.x.mul(c).sub(dir.z.mul(s)), dir.y, dir.x.mul(s).add(dir.z.mul(c)));
  let node = sky.environment !== null ? pmremTexture(sky.environment, lookup, float(0)).rgb.mul(sky.intensity) : sky.color !== null ? vec3(sky.color.r, sky.color.g, sky.color.b) : vec3(0);
  for (const l of lights) {
    // Radiance L from every direction gives an open surface the irradiance π·L: an ambient light of
    // intensity I is L = I/π. A hemisphere light's up/down difference is scaled by 3/2 so the irradiance
    // it gives (2/3 of the radiance's linear term) matches three's hemisphere light.
    if (l.type === 'ambient') {
      const c = new THREE.Color(l.color).multiplyScalar(l.intensity / Math.PI);
      node = node.add(vec3(c.r, c.g, c.b));
    } else if (l.type === 'hemisphere') {
      const s = new THREE.Color(l.color).multiplyScalar(l.intensity / Math.PI);
      const g = new THREE.Color(l.groundColor ?? '#444444').multiplyScalar(l.intensity / Math.PI);
      const mean = vec3((s.r + g.r) / 2, (s.g + g.g) / 2, (s.b + g.b) / 2);
      const slope = vec3(0.75 * (s.r - g.r), 0.75 * (s.g - g.g), 0.75 * (s.b - g.b));
      node = node.add(mean.add(slope.mul(dir.y)));
    }
  }
  return node as ReturnType<typeof vec3>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Fill invalid probes from valid neighbours (26-neighbourhood), ring by ring; probes no valid probe reaches stay dark. */
function dilate(sh: Float32Array, validity: Float32Array, resolution: readonly number[]): number {
  const [nx, ny, nz] = resolution as [number, number, number];
  const known = new Uint8Array(validity.length);
  for (let i = 0; i < known.length; i++) known[i] = validity[i] !== PROBE_FILLED ? 1 : 0;
  let filled = 0;
  for (;;) {
    const next: number[] = [];
    const sums: Float32Array[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = ix + iy * nx + iz * nx * ny;
          if (known[i] === 1) continue;
          const sum = new Float32Array(27);
          let n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const x = ix + dx;
                const y = iy + dy;
                const z = iz + dz;
                if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
                const j = x + y * nx + z * nx * ny;
                if (known[j] !== 1) continue;
                for (let k = 0; k < 27; k++) sum[k]! += sh[j * 27 + k]!;
                n++;
              }
            }
          }
          if (n === 0) continue;
          for (let k = 0; k < 27; k++) sum[k]! /= n;
          next.push(i);
          sums.push(sum);
        }
      }
    }
    if (next.length === 0) return filled;
    next.forEach((i, k) => {
      sh.set(sums[k]!, i * 27);
      known[i] = 1;
    });
    filled += next.length;
  }
}

/**
 * Each probe's walls from what the probes see straight along the axes
 * (`along`: 6 distances a probe, +x −x +y −y +z −z, 0 where nothing is hit):
 * the edge from a probe to the next one along an axis is cut when each of
 * the two sees a surface before the other; the cut is where its two
 * surfaces' middle is, as a share of the edge (0…1). `out`: 6 floats a probe,
 * per axis the cut flag (1 or 0) and the share.
 */
export function edgeWalls(grid: ProbeGridBox, along: Float32Array, out: Float32Array): void {
  const n = grid.resolution as readonly number[];
  const [nx, ny] = n as [number, number, number];
  const step = [0, 1, 2].map((a) => (grid.max[a]! - grid.min[a]!) / (n[a]! - 1));
  const offset = [1, nx, nx * ny];
  out.fill(0);
  for (let i = 0; i < along.length / 6; i++) {
    const at = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      if (at[a]! >= n[a]! - 1) continue;
      const s = step[a]!;
      const fromLo = along[i * 6 + a * 2]!;
      const fromHi = along[(i + offset[a]!) * 6 + a * 2 + 1]!;
      if (!(fromLo > 0 && fromLo < s && fromHi > 0 && fromHi < s)) continue;
      out[i * 6 + a * 2] = 1;
      out[i * 6 + a * 2 + 1] = (fromLo / s + (1 - fromHi / s)) / 2;
    }
  }
}

export async function bakeProbeGrids(input: ProbeBakeInput): Promise<ProbeBakeResult> {
  const started = performance.now();
  const renderer = input.renderer;
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) return { ok: false, code: 'bake_unsupported', message: 'baking probes needs WebGPU (baked probes still draw on WebGL 2)' };
  if (input.grids.length === 0) return { ok: false, code: 'bake_failed', message: 'no probes to bake: mark objects Static or add a probe volume' };
  if (renderer.library.getLightNodeClass(ProbeLighting as never) === null) return { ok: false, code: 'bake_unsupported', message: 'the renderer cannot draw probe lighting' };

  const disposables: { dispose(): void }[] = [];
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const bounds = new THREE.Box3();
  // A lightmapped copy shows its baked light (and may skip ambient light): the bake draws the surface without it.
  const withoutLightmaps = new Map<THREE.Material, THREE.Material>();
  const bakeMaterial = (m: THREE.Material): THREE.Material => {
    if ((m as { lightMap?: THREE.Texture | null }).lightMap == null) return m;
    let c = withoutLightmaps.get(m);
    if (c === undefined) {
      c = m.clone();
      (c as unknown as { lightMap: THREE.Texture | null }).lightMap = null;
      withoutLightmaps.set(m, c);
      disposables.push(c);
    }
    return c;
  };
  const addMesh = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], matrixWorld: THREE.Matrix4): void => {
    const mesh = new THREE.Mesh(geometry, Array.isArray(material) ? material.map(bakeMaterial) : bakeMaterial(material));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrixWorld);
    mesh.matrixWorld.copy(matrixWorld);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    if (geometry.boundingBox !== null) bounds.union(geometry.boundingBox.clone().applyMatrix4(matrixWorld));
  };
  // Every cube face draws the static scene around the probe: small meshes of one material and vertex layout
  // are merged in world space per world cell first, so a face costs a few draws instead of one per prop (a
  // village of placed props: hundreds). Large meshes stay as they are, and cells stay small: merged across a
  // level, a face would draw every triangle instead of the ones in its view (a block ground: twice the time).
  const groups = new Map<string, { material: THREE.Material; parts: ProbeBakeMesh[] }>();
  for (const m of input.meshes) {
    const small = m.geometry.getAttribute('position')?.count <= MERGE_VERTICES_MAX;
    const layout = !small || Array.isArray(m.material) || m.material.userData[OBJECT_FRAME_KEY] === true ? null : mergeLayout(m.geometry);
    if (layout === null) {
      addMesh(m.geometry, m.material, m.matrixWorld);
      continue;
    }
    // By the middle of its world bounds (block chunks share their layer's origin).
    if (m.geometry.boundingBox === null) m.geometry.computeBoundingBox();
    const c = m.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(m.matrixWorld);
    const cell = `${Math.floor(c.x / MERGE_CELL_M)},${Math.floor(c.y / MERGE_CELL_M)},${Math.floor(c.z / MERGE_CELL_M)}`;
    const key = `${(m.material as THREE.Material).uuid}|${layout}|${cell}`;
    let g = groups.get(key);
    if (g === undefined) groups.set(key, (g = { material: m.material as THREE.Material, parts: [] }));
    g.parts.push(m);
  }
  const identity = new THREE.Matrix4();
  for (const g of groups.values()) {
    if (g.parts.length === 1) {
      addMesh(g.parts[0]!.geometry, g.material, g.parts[0]!.matrixWorld);
      continue;
    }
    const merged = mergeWorldGeometry(g.parts);
    disposables.push(merged);
    addMesh(merged, g.material, identity);
  }
  for (const g of input.grids) bounds.union(new THREE.Box3(new THREE.Vector3(...g.min), new THREE.Vector3(...g.max)));
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2);
  const shadowed: (THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight)[] = [];
  for (const l of input.lights) {
    if (l.type === 'directional') {
      const d = fittedBakeDirectional(center, radius);
      d.color.set(l.color);
      d.intensity = l.intensity;
      aimBakeDirectional(d, center, radius, new THREE.Vector3(...(l.direction ?? [0, -1, 0])).normalize());
      scene.add(d, d.target);
      shadowed.push(d);
    } else if (l.type === 'point' || l.type === 'spot') {
      const local = bakeLocalLight(l);
      scene.add(local);
      if (local instanceof THREE.SpotLight) scene.add(local.target);
      shadowed.push(local);
    }
  }
  // The scene holds still during the bake: every shadow map is drawn once, not per cube face.
  const freezeShadows = (): void => {
    for (const l of shadowed) {
      l.shadow.autoUpdate = false;
      l.shadow.needsUpdate = true;
    }
  };

  const cubeTarget = new CubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cubeCamera = new THREE.CubeCamera(0.02, radius * 4, cubeTarget as never);
  const marker = uniform(0);
  const projection = projectionMaterial(cubeTarget.texture, marker);
  const quad = new QuadMesh(projection);
  const batch = new THREE.RenderTarget(ROW, CHUNK, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
  // Back faces seen (red) and how far the surface is (green: the axis reads give the cell walls).
  const backFaces = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  backFaces.colorNode = vec3(frontFacing.select(float(0), float(1)), positionWorld.distance(cameraPosition), 0);
  const sky = skyNode(input.sky, input.lights);
  disposables.push(cubeTarget, projection, batch, backFaces);
  for (const l of shadowed) disposables.push(l);

  const saved = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
  let captures = 0;
  const total = input.grids.reduce((n, g) => n + probeCount(g), 0);
  const passes = 1 + input.bounces;
  /** Work units for the progress bar: the validity pass and each radiance pass over every probe. */
  const units = total * (1 + passes);
  let done = 0;
  const progress = (text: string): void => input.onProgress?.(text, Math.min(0.99, done / units));

  /**
   * Capture cube maps at these points and read back their nine SH
   * coefficients (RGB, 27 floats a point); `along` (when given) gets the
   * green channel seen along each axis (6 floats a point).
   */
  const capture = async (points: Float32Array, along?: Float32Array): Promise<Float32Array> => {
    const n = points.length / 3;
    const out = new Float32Array(n * 27);
    for (let start = 0; start < n; start += CHUNK) {
      if (input.signal?.aborted === true) throw new DOMException('cancelled', 'AbortError');
      const count = Math.min(CHUNK, n - start);
      for (let k = 0; k < count; k++) {
        const p = (start + k) * 3;
        cubeCamera.position.set(points[p]!, points[p + 1]!, points[p + 2]!);
        cubeCamera.updateMatrixWorld();
        renderer.autoClear = true;
        cubeCamera.update(renderer as never, scene);
        renderer.autoClear = false;
        marker.value = k + 1;
        batch.viewport.set(0, k, ROW, 1);
        renderer.setRenderTarget(batch);
        quad.render(renderer);
        captures++;
      }
      renderer.setRenderTarget(saved.target);
      const raw = await readFloatTarget(renderer, batch);
      // Rows are matched by their marker, whichever way up the read-back is.
      for (let row = 0; row < CHUNK; row++) {
        const k = Math.round(raw[(row * ROW + 0) * 4 + 3]!) - 1;
        if (k < 0 || k >= count) continue;
        for (let c = 0; c < 9; c++) for (let ch = 0; ch < 3; ch++) out[(start + k) * 27 + c * 3 + ch] = raw[(row * ROW + c) * 4 + ch]!;
        if (along !== undefined) for (let a = 0; a < 6; a++) along[(start + k) * 6 + a] = raw[(row * ROW + 9 + a) * 4 + 1]!;
      }
      done += count;
      await tick();
    }
    return out;
  };

  const tiles: { grid: ProbeGridBox; spacing: number; at: Float32Array; validity: Float32Array; sh: Float32Array; walls: Float32Array }[] = input.grids.map((grid) => {
    const n = probeCount(grid);
    const [nx, ny, nz] = grid.resolution;
    const at = new Float32Array(n * 3);
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = ix + iy * nx + iz * nx * ny;
          at[i * 3] = grid.min[0] + ((grid.max[0] - grid.min[0]) * ix) / (nx - 1);
          at[i * 3 + 1] = grid.min[1] + ((grid.max[1] - grid.min[1]) * iy) / (ny - 1);
          at[i * 3 + 2] = grid.min[2] + ((grid.max[2] - grid.min[2]) * iz) / (nz - 1);
        }
      }
    }
    const spacing = Math.min(...[0, 1, 2].map((a) => (grid.max[a]! - grid.min[a]!) / (grid.resolution[a]! - 1)));
    return { grid, spacing, at, validity: new Float32Array(n).fill(PROBE_VALID), sh: new Float32Array(n * 27), walls: new Float32Array(n * 6) };
  });

  // The bounce passes light the surfaces with the previous pass's probes, sampled as the game samples them
  // (walls kept: bounce light must not leak into a closed room either).
  let bounceLight: ProbeLighting | null = null;
  const dropBounceLight = (): void => {
    if (bounceLight === null) return;
    scene.remove(bounceLight);
    bounceLight.dispose();
    bounceLight = null;
  };
  let moved = 0;
  let filled = 0;
  try {
    freezeShadows();
    // ---- validity: back faces seen, and a virtual offset for probes inside geometry ----
    scene.overrideMaterial = backFaces;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    for (const t of tiles) {
      progress('finding probes inside geometry…');
      let points = t.at;
      let index = Array.from({ length: t.validity.length }, (_, i) => i);
      const along = new Float32Array(t.validity.length * 6);
      const sh = await capture(points, along);
      edgeWalls(t.grid, along, t.walls);
      const share = (k: number): number => sh[k * 27]! / DC_OF_ONE;
      // The back faces' mean direction (the SH's first band: y, z, x), away from which a probe moves.
      const away = (k: number): THREE.Vector3 => new THREE.Vector3(sh[k * 27 + 9]!, sh[k * 27 + 3]!, sh[k * 27 + 6]!).negate();
      let inside = index.filter((_, k) => share(k) > PROBE_VALIDITY_THRESHOLD);
      const dirs = new Map(inside.map((i) => [i, away(i)]));
      for (const i of inside) t.validity[i] = PROBE_FILLED;
      for (const step of OFFSET_STEPS) {
        index = inside.filter((i) => dirs.get(i)!.lengthSq() > 1e-12);
        if (index.length === 0) break;
        points = new Float32Array(index.length * 3);
        index.forEach((i, k) => {
          const d = dirs.get(i)!.clone().normalize().multiplyScalar(step * t.spacing);
          points[k * 3] = t.at[i * 3]! + d.x;
          points[k * 3 + 1] = t.at[i * 3 + 1]! + d.y;
          points[k * 3 + 2] = t.at[i * 3 + 2]! + d.z;
        });
        const tried = await capture(points);
        done -= index.length;
        const free = new Set<number>();
        index.forEach((i, k) => {
          if (tried[k * 27]! / DC_OF_ONE > PROBE_VALIDITY_THRESHOLD) return;
          free.add(i);
          t.validity[i] = PROBE_MOVED;
          t.at.set(points.subarray(k * 3, k * 3 + 3), i * 3);
        });
        inside = inside.filter((i) => !free.has(i));
      }
      for (const v of t.validity) {
        if (v === PROBE_MOVED) moved++;
        else if (v === PROBE_FILLED) filled++;
      }
    }

    // ---- radiance: direct light and the sky, then one bounce per pass ----
    scene.overrideMaterial = null;
    scene.backgroundNode = sky as never;
    for (let pass = 0; pass < passes; pass++) {
      for (const t of tiles) {
        progress(pass === 0 ? 'capturing direct light…' : `bounce ${pass} of ${input.bounces}…`);
        const live = Array.from({ length: t.validity.length }, (_, i) => i).filter((i) => t.validity[i] !== PROBE_FILLED);
        const points = new Float32Array(live.length * 3);
        live.forEach((i, k) => points.set(t.at.subarray(i * 3, i * 3 + 3), k * 3));
        const sh = await capture(points);
        done += t.validity.length - live.length;
        const next = new Float32Array(t.sh.length);
        live.forEach((i, k) => next.set(sh.subarray(k * 27, k * 27 + 27), i * 27));
        dilate(next, t.validity, t.grid.resolution);
        t.sh.set(next);
      }
      if (pass + 1 < passes) {
        // The next pass's surfaces are lit by these probes too.
        if (bounceLight === null) {
          bounceLight = new ProbeLighting();
          scene.add(bounceLight);
        }
        bounceLight.setTiles(
          tiles.map((t, i) => ({ sceneId: '', grid: { ...t.grid, asset: String(i) } as ProbeGridRecord, atlas: atlasFromSamples(packProbeTexels(t.sh, t.validity, t.walls).samples, t.grid.resolution), validity: t.validity })),
        );
      }
    }
    input.onProgress?.('done', 1);
    const millis = Math.round(performance.now() - started);
    return { ok: true, tiles: tiles.map((t) => ({ sh: t.sh, validity: t.validity, walls: t.walls })), millis, probes: total, moved, filled, captures };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { ok: false, code: 'bake_cancelled', message: 'the bake was cancelled' };
    return { ok: false, code: 'bake_failed', message: (e as Error).message };
  } finally {
    dropBounceLight();
    renderer.setRenderTarget(saved.target);
    renderer.autoClear = saved.autoClear;
    renderer.setClearColor(saved.clear, saved.alpha);
    for (const d of disposables) d.dispose();
  }
}
