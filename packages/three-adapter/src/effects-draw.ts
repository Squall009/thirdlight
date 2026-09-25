/**
 * Phase 20.2: drawing effect particles — the Output blocks of a system as
 * three.js node materials, fed by either executor:
 *
 * - `CpuParticleSource`: the CPU evaluator's typed arrays copied each frame
 *   into instanced attributes (the living particles, back to front when the
 *   output blends with alpha);
 * - `GpuParticleSource`: the WebGPU executor's storage buffers read in the
 *   vertex stage (slot order from its sort pass; dead slots collapse).
 *
 * Renderers: billboards (camera-facing, velocity-aligned or turning around
 * a fixed axis; flipbook frames over the life or at a frame rate; blending
 * modes; soft particles against the scene depth on WebGPU), mesh particles
 * (a model asset per particle, scaled by its size and turned by its
 * rotation about the up axis), ribbons/trails (camera-facing strips built on
 * the CPU) and lights (a shared pool of point lights on the oldest
 * particles). Shading: built-in unlit or lit particle materials, or a
 * project material (its graph; the particle colour multiplies it).
 *
 * Every mesh here sits at the identity transform: the vertex stage computes
 * world positions (a local-space system through its origin matrix).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { billboardAxes, flipbookFrame, flipbookRect, lightParticles, ribbonOrder, type CompiledNode, type SystemState } from '@thirdlight/effects';

import type { GpuSystem } from './effects-gpu';
import type { N } from './effects-tsl';

const TSL: N = TSLTyped;
const { float, vec2, vec3, vec4, select, uniform, varying } = TSL;

/** Per-instance particle data for the vertex stage: vec4 nodes. */
export interface ParticleData {
  posAge: N;
  velLife: N;
  color: N;
  sizeRot: N;
  /** 1 for a living particle, 0 for a dead slot (GPU; always 1 on the CPU). */
  alive: N;
}

export interface ParticleSource {
  readonly kind: 'cpu' | 'gpu';
  readonly capacity: number;
  readonly space: 'local' | 'world';
  data(): ParticleData;
  /** Instances to draw this frame. */
  count(): number;
}

/** The CPU evaluator's particles as instanced attributes (refilled by `fill`). */
export class CpuParticleSource implements ParticleSource {
  readonly kind = 'cpu' as const;
  readonly capacity: number;
  readonly space: 'local' | 'world';
  private readonly attrs: { posAge: THREE.InstancedBufferAttribute; velLife: THREE.InstancedBufferAttribute; color: THREE.InstancedBufferAttribute; sizeRot: THREE.InstancedBufferAttribute };
  private drawn = 0;
  private order: number[] = [];
  private readonly nodes: ParticleData;

  constructor(readonly sys: SystemState) {
    this.capacity = sys.capacity;
    this.space = sys.program.space;
    const make = (): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.capacity) * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrs = { posAge: make(), velLife: make(), color: make(), sizeRot: make() };
    this.nodes = {
      posAge: TSL.instancedDynamicBufferAttribute(this.attrs.posAge, 'vec4'),
      velLife: TSL.instancedDynamicBufferAttribute(this.attrs.velLife, 'vec4'),
      color: TSL.instancedDynamicBufferAttribute(this.attrs.color, 'vec4'),
      sizeRot: TSL.instancedDynamicBufferAttribute(this.attrs.sizeRot, 'vec4'),
      alive: float(1),
    };
  }

  data(): ParticleData {
    return this.nodes;
  }

  count(): number {
    return this.drawn;
  }

  /** Copy the living particles (back to front from `eye` when sorted; `toWorld` maps a local position). */
  fill(sorted: boolean, eye: THREE.Vector3, toWorld: THREE.Matrix4 | null): void {
    const s = this.sys;
    const n = s.count;
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    if (sorted && n > 1) {
      const d = new Float32Array(n);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.set(s.position[i * 3]!, s.position[i * 3 + 1]!, s.position[i * 3 + 2]!);
        if (toWorld !== null) v.applyMatrix4(toWorld);
        d[i] = v.distanceToSquared(eye);
      }
      order.sort((a, b) => d[b]! - d[a]!);
    }
    const pa = this.attrs.posAge.array as Float32Array;
    const vl = this.attrs.velLife.array as Float32Array;
    const co = this.attrs.color.array as Float32Array;
    const sr = this.attrs.sizeRot.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      pa[k * 4] = s.position[i * 3]!;
      pa[k * 4 + 1] = s.position[i * 3 + 1]!;
      pa[k * 4 + 2] = s.position[i * 3 + 2]!;
      pa[k * 4 + 3] = s.age[i]!;
      vl[k * 4] = s.velocity[i * 3]!;
      vl[k * 4 + 1] = s.velocity[i * 3 + 1]!;
      vl[k * 4 + 2] = s.velocity[i * 3 + 2]!;
      vl[k * 4 + 3] = s.lifetime[i]!;
      co[k * 4] = s.color[i * 4]!;
      co[k * 4 + 1] = s.color[i * 4 + 1]!;
      co[k * 4 + 2] = s.color[i * 4 + 2]!;
      co[k * 4 + 3] = s.color[i * 4 + 3]!;
      sr[k * 4] = s.size[i]!;
      sr[k * 4 + 1] = s.baseSize[i]!;
      sr[k * 4 + 2] = s.rotation[i]!;
      sr[k * 4 + 3] = s.spin[i]!;
    }
    this.drawn = n;
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges();
      if (n > 0) a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
  }
}

/** The WebGPU executor's particles (slot order from its sort pass when it has one). */
export class GpuParticleSource implements ParticleSource {
  readonly kind = 'gpu' as const;
  readonly capacity: number;
  readonly space: 'local' | 'world';
  private readonly nodes: ParticleData;

  constructor(gpu: GpuSystem) {
    this.capacity = gpu.capacity;
    this.space = gpu.program.space;
    const d = gpu.draw;
    this.nodes = {
      posAge: d.posAge.toAttribute(),
      velLife: d.velLife.toAttribute(),
      color: d.color.toAttribute(),
      sizeRot: d.sizeRot.toAttribute(),
      // Dead slots were gathered with size 0.
      alive: float(1),
    };
  }

  data(): ParticleData {
    return this.nodes;
  }

  count(): number {
    return this.capacity;
  }
}

export interface DrawContext {
  /** WebGPU: soft particles read the scene depth. */
  webgpu: boolean;
  loadTexture(assetId: string): Promise<THREE.Texture | null>;
  loadModel(assetId: string): Promise<THREE.Object3D | null>;
  /** A project material's compiled material (null: none / not a graph or shader material yet). */
  projectMaterial(materialId: string): THREE.Material | null;
  /** The shared point-light pool. */
  lights: LightPool;
}

/** An Output block drawn for one system of one playing effect. */
export interface OutputRenderer {
  readonly object: THREE.Object3D | null;
  /** Once per frame, after the step (CPU sources are already filled). */
  update(frame: FrameInfo): void;
  /** Whether it blends order-dependently (its source is sorted back to front). */
  readonly sorted: boolean;
  dispose(): void;
}

export interface FrameInfo {
  camera: THREE.Camera;
  /** Local → world of the effect (identity for world-space systems). */
  originMatrix: THREE.Matrix4;
  visible: boolean;
  /** An Output input read once per frame (its field or its wire; see `EffectInstance.outputInput`). */
  input(block: CompiledNode, key: string): number[];
}

const BLEND_SORTED = new Set(['alpha', 'premultiplied']);

/** Whether an output block blends order-dependently (alpha or premultiplied over). */
export function outputSorted(block: CompiledNode): boolean {
  if (block.type === 'output.light') return false;
  return BLEND_SORTED.has(String(block.fields['blend'] ?? 'alpha'));
}

function applyBlend(m: THREE.Material, blend: string): void {
  m.transparent = blend !== 'opaque';
  m.depthWrite = blend === 'opaque';
  m.side = THREE.DoubleSide;
  switch (blend) {
    case 'additive':
      m.blending = THREE.AdditiveBlending;
      break;
    case 'premultiplied':
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
    case 'multiply':
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.DstColorFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
    case 'opaque':
      m.blending = THREE.NoBlending;
      m.alphaTest = 0.5;
      break;
    default:
      m.blending = THREE.NormalBlending;
  }
}

/** Camera axes in world space from the view matrix rows. */
function cameraAxes(): { right: N; up: N; forward: N } {
  const V = TSL.cameraViewMatrix;
  const right = vec3(V.element(0).x, V.element(1).x, V.element(2).x);
  const up = vec3(V.element(0).y, V.element(1).y, V.element(2).y);
  const back = vec3(V.element(0).z, V.element(1).z, V.element(2).z);
  return { right, up, forward: back.negate() };
}

/** The shading of a particle material: built-in unlit/lit, or a project material. */
function shadedMaterial(ctx: DrawContext, block: CompiledNode): { material: THREE.NodeMaterial; base: N | null; baseOpacity: N | null } {
  const shading = String(block.fields['shading'] ?? 'unlit');
  if (shading === 'material') {
    const src = ctx.projectMaterial(String(block.fields['material'] ?? ''));
    if (src !== null && (src as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
      const m = (src as THREE.NodeMaterial).clone() as THREE.NodeMaterial;
      const own = m as unknown as { colorNode: N; opacityNode: N };
      return { material: m, base: own.colorNode ?? null, baseOpacity: own.opacityNode ?? null };
    }
  }
  if (shading === 'lit') {
    const m = new THREE.MeshStandardNodeMaterial();
    m.roughness = 1;
    m.metalness = 0;
    return { material: m, base: null, baseOpacity: null };
  }
  return { material: new THREE.MeshBasicNodeMaterial(), base: null, baseOpacity: null };
}

/** Billboards: one quad per particle. */
class BillboardRenderer implements OutputRenderer {
  readonly object: THREE.Mesh;
  readonly sorted: boolean;
  private readonly material: THREE.NodeMaterial;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly originU = uniform(new THREE.Matrix4());
  private readonly axisU = uniform(new THREE.Vector3(0, 1, 0));
  private readonly softU = uniform(0.25);
  private readonly textureNode: N;
  private disposed = false;

  constructor(private readonly src: ParticleSource, private readonly block: CompiledNode, ctx: DrawContext) {
    const f = block.fields;
    const blend = String(f['blend'] ?? 'alpha');
    this.sorted = outputSorted(block);
    const { material, base, baseOpacity } = shadedMaterial(ctx, block);
    this.material = material;
    const d = src.data();
    const local = src.space === 'local';
    const M = this.originU;
    const center = local ? M.mul(vec4(d.posAge.xyz, 1)).xyz : d.posAge.xyz;
    const velW = local ? M.mul(vec4(d.velLife.xyz, 0)).xyz : d.velLife.xyz;
    const cam = cameraAxes();
    const orient = String(f['orient'] ?? 'camera');
    let right: N = cam.right;
    let up: N = cam.up;
    if (orient === 'velocity' || orient === 'axis') {
      const dirW = orient === 'velocity' ? velW : local ? M.mul(vec4(this.axisU, 0)).xyz : this.axisU;
      const lenDir = TSL.length(dirW);
      const upA = dirW.div(TSL.max(lenDir, 1e-12));
      const r = TSL.cross(upA, cam.forward);
      const lenR = TSL.length(r);
      const ok = lenDir.greaterThan(1e-6).and(lenR.greaterThan(1e-9));
      right = select(ok, r.div(TSL.max(lenR, 1e-12)), cam.right);
      up = select(ok, upA, cam.up);
    }
    const rot = d.sizeRot.z.mul(Math.PI / 180);
    const corner = TSL.positionGeometry.xy;
    const c = TSL.cos(rot);
    const s = TSL.sin(rot);
    const size = d.sizeRot.x.mul(d.alive);
    const q = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(size);
    material.positionNode = center.add(right.mul(q.x)).add(up.mul(q.y));
    if (material instanceof THREE.MeshStandardNodeMaterial || String(f['shading']) === 'material') {
      const nW = TSL.cross(right, up);
      material.normalNode = TSL.normalize(TSL.cameraViewMatrix.mul(vec4(nW, 0)).xyz);
    }
    // Flipbook frame (over the life or at a frame rate) → the UV rectangle (frames left→right, top→bottom).
    const cols = Math.max(1, Math.round(Number(f['columns'] ?? 1)));
    const rows = Math.max(1, Math.round(Number(f['rows'] ?? 1)));
    const frames = cols * rows;
    let uvNode: N = TSL.uv();
    if (f['flipbook'] !== 'none' && frames > 1) {
      const age = d.posAge.w;
      const life = d.velLife.w;
      const frame = f['flipbook'] === 'overLife' ? TSL.min(float(frames - 1), TSL.floor(TSL.clamp(select(life.greaterThan(0), age.div(life), float(1)), 0, 1).mul(frames))) : TSL.mod(TSL.floor(TSL.max(age, 0).mul(Number(f['fps'] ?? 12))), frames);
      const col = TSL.mod(frame, cols);
      const row = TSL.mod(TSL.floor(frame.div(cols)), rows);
      const u0 = col.div(cols);
      const v0 = float(1).sub(row.add(1).div(rows));
      uvNode = vec2(u0, v0).add(TSL.uv().mul(vec2(1 / cols, 1 / rows)));
    }
    const vUv = varying(uvNode);
    const vColor = varying(d.color);
    this.textureNode = TSL.texture(WHITE, vUv);
    const tex = String(f['texture'] ?? '');
    if (tex !== '') {
      void ctx.loadTexture(tex).then((t) => {
        if (t === null || this.disposed) return;
        t.colorSpace = THREE.SRGBColorSpace;
        this.textureNode.value = t;
        material.needsUpdate = true;
      });
    }
    const rgb = vColor.xyz.mul(this.textureNode.xyz);
    const alpha = vColor.w.mul(this.textureNode.w);
    const tinted = base !== null ? vec4(base).xyz.mul(rgb) : rgb;
    const colour = blend === 'multiply' ? tinted.mul(alpha) : tinted;
    material.colorNode = vec4(colour, 1);
    let opacity: N = alpha;
    if (baseOpacity !== null) opacity = opacity.mul(baseOpacity);
    // Soft particles (WebGPU): fade where the quad meets the scene, over the soft distance.
    if (f['soft'] === true && ctx.webgpu) {
      const sceneZ = TSL.perspectiveDepthToViewZ(TSL.viewportDepthTexture().x, TSL.cameraNear, TSL.cameraFar);
      opacity = opacity.mul(TSL.clamp(TSL.positionView.z.sub(sceneZ).div(this.softU), 0, 1));
    }
    material.opacityNode = opacity;
    applyBlend(material, blend);
    this.object = new THREE.Mesh(this.geometry, material);
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.name = `effect billboard ${block.id}`;
  }

  update(frame: FrameInfo): void {
    (this.originU.value as THREE.Matrix4).copy(frame.originMatrix);
    const axis = frame.input(this.block, 'axis');
    (this.axisU.value as THREE.Vector3).set(axis[0] ?? 0, axis[1] ?? 1, axis[2] ?? 0);
    this.softU.value = Math.max(0.001, frame.input(this.block, 'softDistance')[0] ?? 0.25);
    const n = this.src.count();
    (this.object as unknown as { count: number }).count = n;
    this.object.visible = frame.visible && n > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** A 1×1 white texture: an untextured particle reads white. */
const WHITE = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

/** Mesh particles: every mesh of a model asset drawn per particle. */
class MeshParticleRenderer implements OutputRenderer {
  readonly object = new THREE.Group();
  readonly sorted: boolean;
  private readonly originU = uniform(new THREE.Matrix4());
  private readonly parts: { mesh: THREE.Mesh; material: THREE.Material; geometry: THREE.BufferGeometry }[] = [];
  private disposed = false;

  constructor(private readonly src: ParticleSource, private readonly block: CompiledNode, ctx: DrawContext) {
    this.sorted = outputSorted(block);
    this.object.name = `effect meshes ${block.id}`;
    this.object.matrixAutoUpdate = false;
    const model = String(block.fields['model'] ?? '');
    if (model === '') return;
    void ctx.loadModel(model).then((root) => {
      if (root === null || this.disposed) return;
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh !== true) return;
        const geometry = m.geometry.clone();
        geometry.applyMatrix4(m.matrixWorld);
        const own = Array.isArray(m.material) ? m.material[0]! : m.material;
        const material = this.material(ctx, own);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.parts.push({ mesh, material, geometry });
        this.object.add(mesh);
      });
    });
  }

  private material(ctx: DrawContext, own: THREE.Material): THREE.NodeMaterial {
    const f = this.block.fields;
    const shading = String(f['shading'] ?? 'unlit');
    let m: THREE.NodeMaterial;
    let base: N = TSL.materialColor;
    let baseOpacity: N = TSL.materialOpacity;
    const project = shading === 'material' ? ctx.projectMaterial(String(f['material'] ?? '')) : null;
    if (project !== null && (project as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
      m = (project as THREE.NodeMaterial).clone() as THREE.NodeMaterial;
      const n = m as unknown as { colorNode: N; opacityNode: N };
      if (n.colorNode) base = n.colorNode;
      if (n.opacityNode) baseOpacity = n.opacityNode;
    } else if (shading === 'lit') {
      m = new THREE.MeshStandardNodeMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(m, own as THREE.MeshStandardMaterial);
    } else {
      const b = new THREE.MeshBasicNodeMaterial();
      const src = own as THREE.MeshStandardMaterial;
      if (src.map) b.map = src.map;
      if (src.color) b.color.copy(src.color);
      m = b;
    }
    const d = this.src.data();
    const local = this.src.space === 'local';
    const M = this.originU;
    const center = local ? M.mul(vec4(d.posAge.xyz, 1)).xyz : d.posAge.xyz;
    const rot = d.sizeRot.z.mul(Math.PI / 180);
    const c = TSL.cos(rot);
    const s = TSL.sin(rot);
    const turn = (v: N): N => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
    const scale = d.sizeRot.x.mul(d.alive);
    // Local → world scale of a local-space system (uniform scale assumed for the model).
    m.positionNode = center.add(turn(TSL.positionGeometry).mul(scale));
    m.normalNode = TSL.normalize(TSL.cameraViewMatrix.mul(vec4(turn(TSL.normalGeometry), 0)).xyz);
    const vColor = varying(d.color);
    m.colorNode = vec4(vec4(base).xyz.mul(vColor.xyz), 1);
    m.opacityNode = baseOpacity.mul(vColor.w);
    applyBlend(m, String(f['blend'] ?? 'alpha'));
    return m;
  }

  update(frame: FrameInfo): void {
    (this.originU.value as THREE.Matrix4).copy(frame.originMatrix);
    const n = this.src.count();
    for (const p of this.parts) (p.mesh as unknown as { count: number }).count = n;
    this.object.visible = frame.visible && n > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    for (const p of this.parts) {
      p.geometry.dispose();
      p.material.dispose();
    }
  }
}

/**
 * Ribbons and trails (CPU particles): trail = a strip through each
 * particle's recorded positions (newest first, fading to the tail); ribbon =
 * one strip joining the particles in birth order. Strips face the camera;
 * width = the particle size × the block's width.
 */
class RibbonRenderer implements OutputRenderer {
  readonly object: THREE.Mesh;
  readonly sorted = false;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.NodeMaterial;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly uvs: Float32Array;
  private readonly indices: Uint32Array;
  private readonly maxPoints: number;
  private disposed = false;

  constructor(private readonly sys: SystemState, private readonly block: CompiledNode, ctx: DrawContext) {
    const trail = block.fields['mode'] !== 'ribbon';
    const segs = trail ? Math.max(2, sys.trailSegments) : 1;
    this.maxPoints = trail ? sys.capacity * segs : sys.capacity;
    const verts = this.maxPoints * 2;
    this.positions = new Float32Array(verts * 3);
    this.colors = new Float32Array(verts * 4);
    this.uvs = new Float32Array(verts * 2);
    this.indices = new Uint32Array(Math.max(1, this.maxPoints) * 6);
    const pos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    const uv = new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('color', col);
    this.geometry.setAttribute('uv', uv);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    const { material, base } = shadedMaterial(ctx, block);
    this.material = material;
    const texNode = TSL.texture(WHITE, TSL.uv());
    const tex = String(block.fields['texture'] ?? '');
    if (tex !== '') {
      void ctx.loadTexture(tex).then((t) => {
        if (t === null || this.disposed) return;
        t.colorSpace = THREE.SRGBColorSpace;
        texNode.value = t;
        material.needsUpdate = true;
      });
    }
    const vc = TSL.attribute('color', 'vec4');
    const rgb = vc.xyz.mul(texNode.xyz);
    const blend = String(block.fields['blend'] ?? 'alpha');
    const tinted = base !== null ? vec4(base).xyz.mul(rgb) : rgb;
    const alpha = vc.w.mul(texNode.w);
    material.colorNode = vec4(blend === 'multiply' ? tinted.mul(alpha) : tinted, 1);
    material.opacityNode = alpha;
    if (material instanceof THREE.MeshStandardNodeMaterial) material.normalNode = vec3(0, 0, 1);
    applyBlend(material, blend);
    this.object = new THREE.Mesh(this.geometry, material);
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.name = `effect ribbon ${block.id}`;
  }

  update(frame: FrameInfo): void {
    const s = this.sys;
    const width = frame.input(this.block, 'width')[0] ?? 1;
    const eye = new THREE.Vector3().setFromMatrixPosition(frame.camera.matrixWorld);
    const M = s.program.space === 'local' ? frame.originMatrix : null;
    const trail = this.block.fields['mode'] !== 'ribbon';
    const strips: { points: THREE.Vector3[]; colors: number[][]; widths: number[] }[] = [];
    const pointOf = (x: number, y: number, z: number): THREE.Vector3 => {
      const v = new THREE.Vector3(x, y, z);
      return M !== null ? v.applyMatrix4(M) : v;
    };
    if (trail && s.trail !== null && s.trailCount !== null) {
      const S = s.trailSegments;
      for (let i = 0; i < s.count; i++) {
        const n = s.trailCount[i]!;
        if (n < 1) continue;
        const points = [pointOf(s.position[i * 3]!, s.position[i * 3 + 1]!, s.position[i * 3 + 2]!)];
        for (let k = 0; k < n; k++) points.push(pointOf(s.trail[(i * S + k) * 3]!, s.trail[(i * S + k) * 3 + 1]!, s.trail[(i * S + k) * 3 + 2]!));
        const c = [s.color[i * 4]!, s.color[i * 4 + 1]!, s.color[i * 4 + 2]!, s.color[i * 4 + 3]!];
        // Fading to the tail: alpha × (1 − k / n).
        const colors = points.map((_, k) => [c[0]!, c[1]!, c[2]!, c[3]! * (1 - k / points.length)]);
        strips.push({ points, colors, widths: points.map(() => s.size[i]! * width) });
      }
    } else {
      const order = ribbonOrder(s);
      if (order.length >= 2) {
        strips.push({
          points: order.map((i) => pointOf(s.position[i * 3]!, s.position[i * 3 + 1]!, s.position[i * 3 + 2]!)),
          colors: order.map((i) => [s.color[i * 4]!, s.color[i * 4 + 1]!, s.color[i * 4 + 2]!, s.color[i * 4 + 3]!]),
          widths: order.map((i) => s.size[i]! * width),
        });
      }
    }
    let v = 0;
    let idx = 0;
    const tangent = new THREE.Vector3();
    const toEye = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (const st of strips) {
      const n = st.points.length;
      if (n < 2 || v + n * 2 > this.maxPoints * 2) continue;
      const first = v;
      for (let k = 0; k < n; k++) {
        const p = st.points[k]!;
        const a = st.points[Math.max(0, k - 1)]!;
        const b = st.points[Math.min(n - 1, k + 1)]!;
        tangent.subVectors(b, a);
        toEye.subVectors(eye, p);
        side.crossVectors(tangent, toEye);
        if (side.lengthSq() < 1e-12) side.set(0, 1, 0);
        side.normalize().multiplyScalar((st.widths[k] ?? 0.1) / 2);
        const c = st.colors[k]!;
        for (let e = 0; e < 2; e++) {
          const sign = e === 0 ? 1 : -1;
          this.positions[v * 3] = p.x + side.x * sign;
          this.positions[v * 3 + 1] = p.y + side.y * sign;
          this.positions[v * 3 + 2] = p.z + side.z * sign;
          this.colors.set([c[0]!, c[1]!, c[2]!, c[3]!], v * 4);
          this.uvs[v * 2] = k / (n - 1);
          this.uvs[v * 2 + 1] = e;
          v += 1;
        }
      }
      for (let k = 0; k < n - 1; k++) {
        const a = first + k * 2;
        this.indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], idx);
        idx += 6;
      }
    }
    for (const name of ['position', 'color', 'uv']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, v * a.itemSize);
      a.needsUpdate = true;
    }
    const ix = this.geometry.getIndex()!;
    ix.clearUpdateRanges();
    ix.addUpdateRange(0, idx);
    ix.needsUpdate = true;
    this.geometry.setDrawRange(0, idx);
    this.object.visible = frame.visible && idx > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Engine limit: point lights all effects share (each costs shading time on every lit surface). */
export const EFFECT_LIGHT_LIMIT = 16;

/**
 * The shared point lights: created once (a change in the scene's light
 * count recompiles every lit material), placed each frame on the oldest
 * particles of the light renderers in play order; unused ones are dark.
 */
export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  private used = 0;
  constructor(private readonly scene: THREE.Object3D) {}
  begin(): void {
    this.used = 0;
  }
  take(): THREE.PointLight | null {
    if (this.used >= EFFECT_LIGHT_LIMIT) return null;
    let l = this.lights[this.used];
    if (l === undefined) {
      l = new THREE.PointLight(0xffffff, 0, 2, 2);
      l.name = 'effect light';
      this.lights.push(l);
      this.scene.add(l);
    }
    this.used += 1;
    return l;
  }
  end(): void {
    for (let i = this.used; i < this.lights.length; i++) this.lights[i]!.intensity = 0;
  }
  get active(): number {
    return this.used;
  }
  dispose(): void {
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.lights.length = 0;
  }
}

/** Lights (CPU particles): the oldest living particles, up to the block's max, coloured by the particle. */
class LightRenderer implements OutputRenderer {
  readonly object = null;
  readonly sorted = false;
  constructor(private readonly sys: SystemState, private readonly block: CompiledNode, private readonly pool: LightPool) {}
  update(frame: FrameInfo): void {
    if (!frame.visible) return;
    const s = this.sys;
    const max = Math.round(Number(this.block.fields['maxLights'] ?? 4));
    const intensity = frame.input(this.block, 'intensity')[0] ?? 1;
    const range = frame.input(this.block, 'range')[0] ?? 2;
    const M = s.program.space === 'local' ? frame.originMatrix : null;
    for (const i of lightParticles(s, max)) {
      const l = this.pool.take();
      if (l === null) return;
      l.position.set(s.position[i * 3]!, s.position[i * 3 + 1]!, s.position[i * 3 + 2]!);
      if (M !== null) l.position.applyMatrix4(M);
      l.color.setRGB(s.color[i * 4]!, s.color[i * 4 + 1]!, s.color[i * 4 + 2]!, THREE.LinearSRGBColorSpace);
      l.intensity = intensity * s.color[i * 4 + 3]!;
      l.distance = range;
    }
  }
  dispose(): void {}
}

/** The renderer of one Output block (null for a block this source cannot draw). */
export function createOutputRenderer(block: CompiledNode, src: ParticleSource, cpu: SystemState | null, ctx: DrawContext): OutputRenderer | null {
  switch (block.type) {
    case 'output.billboard':
      return new BillboardRenderer(src, block, ctx);
    case 'output.mesh':
      return new MeshParticleRenderer(src, block, ctx);
    case 'output.ribbon':
      return cpu !== null ? new RibbonRenderer(cpu, block, ctx) : null;
    case 'output.light':
      return cpu !== null ? new LightRenderer(cpu, block, ctx.lights) : null;
    default:
      return null;
  }
}

// Re-exported for tests: the output maths the renderers follow.
export { billboardAxes, flipbookFrame, flipbookRect };
