/**
 * Octahedral impostors — a far copy of a model drawn as one quad that
 * shows the model as it looks from that side, so a landscape's distant
 * trees cost two triangles each instead of their coarsest mesh.
 *
 * The bake: the model's most detailed level, wearing its own materials, is
 * drawn once from {@link IMPOSTOR_FRAMES}² directions over the upper
 * hemisphere (a hemi-octahedral grid) into an atlas of two textures: its
 * albedo with its coverage, and its normal in the model's frame. Drawn
 * with the page's renderer (either backend), so the look is the project's
 * materials; once per model and page, never per frame.
 *
 * The draw: the quad stands at the copy's bounding sphere facing the camera;
 * the three grid frames around the view direction (in the copy's own frame,
 * so a turned copy shows its turned side) are sampled where the quad's point
 * projects into each and blended by the view's place between them; the
 * blend's normal lights it as a mesh is lit. A scatter rule's
 * `impostorSize` puts the quad in as the copies' farthest level.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { INSTANCE_MATRIX_ATTRIBUTE } from './attribute-instancing';
import { releaseMrtContexts } from './dispose';
import type { N } from './effects-tsl';
import { KEEP_MATERIAL_KEY } from './material-keys';
import type { ModelInstance } from './visual';

const TSL: N = TSLTyped;

/** Frames per side of the atlas (an even count: no frame looks straight down, where a frame's basis turns). */
export const IMPOSTOR_FRAMES = 8;
/** Pixels per side of a frame. */
export const IMPOSTOR_FRAME_PIXELS = 128;

/** The unit direction (y up) a point of the hemi-octahedral square [0, 1]² stands for. */
export function hemiOctDecode(u: number, v: number): [number, number, number] {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const px = (x + y) / 2;
  const pz = (x - y) / 2;
  const d: [number, number, number] = [px, 1 - Math.abs(px) - Math.abs(pz), pz];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** A direction's point in the hemi-octahedral square (directions below the horizon are taken at it). */
export function hemiOctEncode(x: number, y: number, z: number): [number, number] {
  const s = Math.abs(x) + Math.max(0, y) + Math.abs(z) || 1;
  const px = x / s;
  const pz = z / s;
  return [(px + pz) * 0.5 + 0.5, (px - pz) * 0.5 + 0.5];
}

/** A baked model: its atlas, its frames per side and the sphere the frames frame (model space). */
export interface ImpostorAtlas {
  readonly target: THREE.RenderTarget;
  readonly frames: number;
  readonly center: THREE.Vector3;
  readonly radius: number;
  /** Milliseconds the bake took on the main thread. */
  readonly ms: number;
}

/**
 * Bake `source` (the model's most detailed meshes in its own frame, wearing
 * its materials) into an atlas with `renderer` (synchronously: its draws are
 * a few dozen small ones; the materials' programs for the atlas's outputs are
 * built on the first one).
 */
export function bakeImpostor(renderer: THREE.WebGPURenderer, source: THREE.Object3D, frames = IMPOSTOR_FRAMES, framePixels = IMPOSTOR_FRAME_PIXELS): ImpostorAtlas {
  const t0 = performance.now();
  source.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(source).getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  const size = frames * framePixels;
  const target = new THREE.RenderTarget(size, size, { count: 2, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  target.textures[0]!.name = 'output';
  target.textures[1]!.name = 'normal';
  for (const t of target.textures) t.colorSpace = THREE.NoColorSpace;
  // Albedo (sRGB-encoded: 8 bits keep the darks) with full coverage where the model is, and the surface normal in
  // the model's frame (its meshes' own normals turned by their place in it: the normal maps' detail is far below
  // a far copy's pixels).
  const normal = TSL.normalize(TSL.modelWorldMatrix.mul(TSL.vec4(TSL.normalLocal, 0)).xyz);
  const outputs = TSL.mrt({ output: TSL.vec4(TSL.pow(TSL.max(TSL.diffuseColor.rgb, 0), TSL.vec3(1 / 2.2)), 1), normal: TSL.vec4(normal.mul(0.5).add(0.5), 1) });
  const scene = new THREE.Scene();
  scene.add(source);
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, radius * 0.01, radius * 4);
  const r = renderer as unknown as { getMRT(): unknown; setMRT(m: unknown): void; autoClear: boolean; getClearColor(c: THREE.Color): THREE.Color; getClearAlpha(): number };
  const target0 = renderer.getRenderTarget();
  const mrt0 = r.getMRT();
  const autoClear0 = r.autoClear;
  const clearColor0 = r.getClearColor(new THREE.Color());
  const clearAlpha0 = r.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    r.setMRT(outputs);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    r.autoClear = false;
    for (let j = 0; j < frames; j++) {
      for (let i = 0; i < frames; i++) {
        const [dx, dy, dz] = hemiOctDecode(i / (frames - 1), j / (frames - 1));
        camera.position.set(sphere.center.x + dx * radius * 2, sphere.center.y + dy * radius * 2, sphere.center.z + dz * radius * 2);
        camera.up.set(0, 1, 0);
        camera.lookAt(sphere.center);
        camera.updateMatrixWorld();
        target.viewport.set(i * framePixels, j * framePixels, framePixels, framePixels);
        target.scissor.set(i * framePixels, j * framePixels, framePixels, framePixels);
        renderer.render(scene, camera);
      }
    }
  } finally {
    target.viewport.set(0, 0, size, size);
    target.scissor.set(0, 0, size, size);
    renderer.setRenderTarget(target0);
    r.setMRT(mrt0);
    r.autoClear = autoClear0;
    renderer.setClearColor(clearColor0, clearAlpha0);
    scene.remove(source);
    releaseMrtContexts(renderer, outputs);
  }
  return { target, frames, center: sphere.center.clone(), radius, ms: performance.now() - t0 };
}

/** The impostor's direction encoding in the shader (`hemiOctEncode`). */
function encodeNode(d: N): N {
  const s = TSL.abs(d.x).add(TSL.max(d.y, 0)).add(TSL.abs(d.z)).max(1e-6);
  const px = d.x.div(s);
  const pz = d.z.div(s);
  return TSL.vec2(px.add(pz).mul(0.5).add(0.5), px.sub(pz).mul(0.5).add(0.5));
}

/** `hemiOctDecode` in the shader. */
function decodeNode(uv: N): N {
  const x = uv.x.mul(2).sub(1);
  const y = uv.y.mul(2).sub(1);
  const px = x.add(y).mul(0.5);
  const pz = x.sub(y).mul(0.5);
  return TSL.normalize(TSL.vec3(px, TSL.float(1).sub(TSL.abs(px)).sub(TSL.abs(pz)), pz));
}

/** A frame's right and up in the model's frame: the bake camera's (`lookAt` with +y up). */
function frameBasis(d: N): { right: N; up: N } {
  const right = TSL.normalize(TSL.vec3(d.z, 0, d.x.negate()).add(TSL.vec3(1e-6, 0, 0)));
  return { right, up: TSL.cross(d, right) };
}

/**
 * The quad that draws `atlas` as a far level of an instance set (a part
 * at the model's origin: the set's copy matrices place it). Its geometry's
 * bounding sphere is the model's, so the draws cull it as they cull the mesh.
 */
export function impostorMesh(atlas: ImpostorAtlas, name: string): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2, 2);
  geometry.boundingSphere = new THREE.Sphere(atlas.center.clone(), atlas.radius);
  geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(atlas.center, new THREE.Vector3(2, 2, 2).multiplyScalar(atlas.radius));
  const material = new THREE.MeshStandardNodeMaterial();
  material.name = `impostor:${name}`;
  material.roughness = 0.9;
  material.metalness = 0;
  material.alphaTest = 0.5;
  const n = atlas.frames;
  const albedo = atlas.target.textures[0]!;
  const normals = atlas.target.textures[1]!;
  const center = TSL.uniform(atlas.center.clone());
  const radius = TSL.uniform(atlas.radius);
  // The copy's matrix columns (the instance set's): its place, turn and size in the set's chunk.
  const c0 = TSL.attribute(`${INSTANCE_MATRIX_ATTRIBUTE}0`, 'vec4').xyz;
  const c1 = TSL.attribute(`${INSTANCE_MATRIX_ATTRIBUTE}1`, 'vec4').xyz;
  const c2 = TSL.attribute(`${INSTANCE_MATRIX_ATTRIBUTE}2`, 'vec4').xyz;
  const c3 = TSL.attribute(`${INSTANCE_MATRIX_ATTRIBUTE}3`, 'vec4').xyz;
  const scale = TSL.length(c0).max(1e-6);
  const toLocal = (v: N): N => TSL.vec3(TSL.dot(c0, v), TSL.dot(c1, v), TSL.dot(c2, v)).div(scale.mul(scale));
  // The sphere's centre in the chunk's space, the camera there, and the quad facing it (world up).
  const mid = c0.mul(center.x).add(c1.mul(center.y)).add(c2.mul(center.z)).add(c3);
  const eye = TSL.modelWorldMatrixInverse.mul(TSL.vec4(TSL.cameraPosition, 1)).xyz;
  const toEye = TSL.normalize(eye.sub(mid));
  const bRight = TSL.normalize(TSL.cross(TSL.vec3(0, 1, 0), toEye).add(TSL.vec3(1e-5, 0, 0)));
  const bUp = TSL.cross(toEye, bRight);
  const corner = TSL.attribute('position', 'vec3');
  const offset = bRight.mul(corner.x).add(bUp.mul(corner.y)).mul(radius).mul(scale);
  (material as unknown as { positionNode: N }).positionNode = mid.add(offset);
  // The view direction in the copy's own frame picks the frames; the three around it, and how much of each.
  const viewLocal = TSL.normalize(toLocal(toEye));
  const grid = encodeNode(viewLocal).mul(n - 1);
  const f0 = TSL.clamp(TSL.floor(grid), TSL.vec2(0, 0), TSL.vec2(n - 2, n - 2));
  const fr = grid.sub(f0);
  const upper = fr.x.add(fr.y).greaterThan(1);
  const fa = TSL.select(upper, f0.add(TSL.vec2(1, 1)), f0);
  const fb = f0.add(TSL.vec2(1, 0));
  const fc = f0.add(TSL.vec2(0, 1));
  const weights = TSL.select(upper, TSL.vec3(fr.x.add(fr.y).sub(1), TSL.float(1).sub(fr.y), TSL.float(1).sub(fr.x)), TSL.vec3(TSL.float(1).sub(fr.x).sub(fr.y), fr.x, fr.y));
  // Where the quad's point falls in each frame (an orthographic view along the frame's direction).
  const local = toLocal(offset);
  const frameUv = (f: N): N => {
    const { right, up } = frameBasis(decodeNode(f.div(n - 1)));
    return TSL.vec2(TSL.dot(local, right), TSL.dot(local, up)).div(radius.mul(2)).add(0.5);
  };
  const vA = TSL.varying(TSL.vec4(fa, frameUv(fa)));
  const vB = TSL.varying(TSL.vec4(fb, frameUv(fb)));
  const vC = TSL.varying(TSL.vec4(fc, frameUv(fc)));
  const vW = TSL.varying(weights);
  // Each frame's texel (outside its frame: nothing), weighted by coverage. A render target's rows run from the
  // top as the frames were drawn into its viewports, a texture's v from the bottom: the atlas is read upside down.
  const at = (v: N): N => {
    const p = v.xy.add(TSL.clamp(v.zw, 0.002, 0.998)).div(n);
    return TSL.vec2(p.x, TSL.float(1).sub(p.y));
  };
  const inside = (v: N): N => TSL.step(0, v.z).mul(TSL.step(v.z, 1)).mul(TSL.step(0, v.w)).mul(TSL.step(v.w, 1));
  // The atlas is drawn over a cleared (zero) background, so its mip levels hold colour and normal times
  // coverage: summed as they are and divided by the summed coverage, a small far copy keeps its colour.
  const wa = vW.x.mul(inside(vA));
  const wb = vW.y.mul(inside(vB));
  const wc = vW.z.mul(inside(vC));
  const sa = TSL.texture(albedo, at(vA));
  const sb = TSL.texture(albedo, at(vB));
  const sc = TSL.texture(albedo, at(vC));
  const cover = sa.a.mul(wa).add(sb.a.mul(wb)).add(sc.a.mul(wc));
  const encoded = sa.rgb.mul(wa).add(sb.rgb.mul(wb)).add(sc.rgb.mul(wc)).div(cover.max(1e-4));
  material.colorNode = TSL.vec4(TSL.pow(TSL.clamp(encoded, 0, 1), TSL.vec3(2.2)), 1);
  (material as unknown as { opacityNode: N }).opacityNode = cover;
  // The normals' coverage is the albedo's (their own alpha is not cleared with them).
  const na = TSL.texture(normals, at(vA)).rgb;
  const nb = TSL.texture(normals, at(vB)).rgb;
  const nc = TSL.texture(normals, at(vC)).rgb;
  const nEncoded = na.mul(wa).add(nb.mul(wb)).add(nc.mul(wc)).div(cover.max(1e-4));
  const nLocal = TSL.normalize(nEncoded.mul(2).sub(1).add(TSL.vec3(0, 1e-4, 0)));
  // The model-frame normal turned with the copy, into the view.
  const nChunk = c0.mul(nLocal.x).add(c1.mul(nLocal.y)).add(c2.mul(nLocal.z));
  (material as unknown as { normalNode: N }).normalNode = TSL.normalize(TSL.modelViewMatrix.mul(TSL.vec4(nChunk, 0)).xyz);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `impostor:${name}`;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Its material is its own: a project's material mapping never dresses it.
  mesh.userData[KEEP_MATERIAL_KEY] = true;
  return mesh;
}

/** Free a baked atlas and its quad's material and geometry. */
export function disposeImpostor(atlas: ImpostorAtlas, mesh: THREE.Mesh | null): void {
  atlas.target.dispose();
  if (mesh !== null) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

/** What the store needs from its host. */
export interface ImpostorStoreDeps {
  /** The page's renderer (null: none yet; the bake waits). */
  renderer(): THREE.WebGPURenderer | null;
  /** The model (null while it loads; `onReady` then). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Dress the bake's meshes with the asset's materials; returns what takes them off. */
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
}

/** What the store holds (diagnostics). */
export interface ImpostorStoreDiagnostics {
  baked: number;
  waiting: number;
  failed: number;
  /** The atlases' bytes on the GPU (with their mips), and the longest bake (ms, main thread). */
  bytes: number;
  bakeMsMax: number;
}

interface Entry {
  readonly assetId: string;
  readonly piece: string | undefined;
  state: 'waiting' | 'ready' | 'failed';
  atlas: ImpostorAtlas | null;
  mesh: THREE.Mesh | null;
  readonly waiters: Set<() => void>;
}

/**
 * The page's impostors, one per model: baked when first asked for, one a
 * frame (`update`, before the frame's draw: the bake draws with the page's
 * renderer), kept for the page's life.
 */
export class ImpostorStore {
  private readonly entries = new Map<string, Entry>();
  private bakeMsMax = 0;

  constructor(private readonly deps: ImpostorStoreDeps) {}

  /** The impostor quad of a model (null while it is baked, or when it cannot be: `onReady` once it is there). */
  get(assetId: string, piece: string | undefined, onReady: () => void): THREE.Mesh | null {
    const key = `${assetId}\u0000${piece ?? ''}`;
    let e = this.entries.get(key);
    if (e === undefined) this.entries.set(key, (e = { assetId, piece, state: 'waiting', atlas: null, mesh: null, waiters: new Set() }));
    if (e.state === 'waiting') e.waiters.add(onReady);
    return e.mesh;
  }

  /** Bake one waiting model whose model has loaded (call once a frame, outside any draw); returns whether one was baked. */
  update(): boolean {
    for (const e of this.entries.values()) {
      if (e.state !== 'waiting') continue;
      const renderer = this.deps.renderer();
      if (renderer === null) return false;
      const template = this.deps.template(e.assetId, e.piece, () => undefined);
      if (template === null) continue;
      this.bake(e, renderer, template);
      return true;
    }
    return false;
  }

  diagnostics(): ImpostorStoreDiagnostics {
    let baked = 0;
    let waiting = 0;
    let failed = 0;
    let bytes = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'ready') baked += 1;
      else if (e.state === 'waiting') waiting += 1;
      else failed += 1;
      // Two RGBA8 textures with their mips (a third more).
      if (e.atlas !== null) bytes += Math.round((e.atlas.target.width * e.atlas.target.height * 4 * 2 * 4) / 3);
    }
    return { baked, waiting, failed, bytes, bakeMsMax: Math.round(this.bakeMsMax * 100) / 100 };
  }

  dispose(): void {
    for (const e of this.entries.values()) if (e.atlas !== null) disposeImpostor(e.atlas, e.mesh);
    this.entries.clear();
  }

  private bake(e: Entry, renderer: THREE.WebGPURenderer, template: ModelInstance): void {
    // The model's most detailed meshes in its own frame (shared geometry and materials), dressed as the copies are.
    template.glbRoot.updateMatrixWorld(true);
    const rootInverse = new THREE.Matrix4().copy(template.glbRoot.matrixWorld).invert();
    const source = new THREE.Group();
    const add = (mesh: THREE.Mesh): void => {
      const copy = new THREE.Mesh(mesh.geometry, mesh.material);
      copy.matrixAutoUpdate = false;
      copy.matrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
      source.add(copy);
    };
    const walk = (node: THREE.Object3D): void => {
      const lod = node as THREE.LOD;
      if (lod.isLOD === true && lod.levels.length > 0) {
        lod.levels[0]!.object.traverse((o) => void ((o as THREE.Mesh).isMesh === true && add(o as THREE.Mesh)));
        return;
      }
      if ((node as THREE.Mesh).isMesh === true) add(node as THREE.Mesh);
      for (const c of node.children) walk(c);
    };
    walk(template.glbRoot);
    const undress = this.deps.dress?.(source, e.assetId) ?? null;
    try {
      const atlas = bakeImpostor(renderer, source);
      e.atlas = atlas;
      e.mesh = impostorMesh(atlas, `${e.assetId}${e.piece !== undefined ? `:${e.piece}` : ''}`);
      e.state = 'ready';
      this.bakeMsMax = Math.max(this.bakeMsMax, atlas.ms);
    } catch (err) {
      console.warn(`impostor of ${e.assetId}: ${err instanceof Error ? err.message : String(err)}; its copies keep their meshes`);
      e.state = 'failed';
    } finally {
      undress?.();
    }
    const waiters = [...e.waiters];
    e.waiters.clear();
    for (const w of waiters) w();
  }
}
