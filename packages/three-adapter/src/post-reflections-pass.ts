/**
 * The reflections' passes each frame (`post-reflections.ts` says what they
 * do and how materials take the result), in one node the post stack draws
 * after its scene pass:
 *
 * 1. trace: a quad at the trace's size marches each glossy pixel's ray
 *    through the frame's depth (rgb of the hit, its confidence; -1 where the
 *    pixel reflects nothing of its own: background or rough), and one pixel
 *    a square writes its ray, where the screen had no full answer, into a
 *    storage buffer;
 * 2. traced rays: the surface light's tracer (`ReflectionTracer`) traces
 *    them on the same device and writes their light into another;
 * 3. resolve: the screen's answer, the traced squares' light where it
 *    lacked one (taken from the up to four nearest traced pixels that share
 *    the pixel's depth and facing), blended into the reprojected history;
 * 4. the resolve and the trace's view depth (its second target, which the
 *    next frame's reads test) are copied into the light's history and depth
 *    (the targets lit programs bound stay the same).
 *
 * The history is found where the pixel's surface was on the last frame: by
 * the scene pass's motion vectors under the temporal upscale (a moving
 * object's reflection follows it), else by the camera's last matrices.
 *
 * The march has a fixed step count and no data-dependent loop bounds
 * (Intel GPUs lose most of their speed to divergent loops).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { releaseStorage } from './dispose';
import { HISTORY_DEPTH_TOLERANCE } from './screen-history';
import {
  REFLECTION_HISTORY_BLEND,
  REFLECTION_RESOLUTION_SCALE,
  REFLECTION_ROUGHNESS_MAX,
  REFLECTION_SCREEN_METRES,
  REFLECTION_SPACING_FRAMES,
  REFLECTION_STILL_BLEND,
  REFLECTION_STILL_FRAMES,
  REFLECTION_STILL_TRACE_FRAMES,
  REFLECTION_TRACE_INTERVAL_MAX,
  REFLECTION_TRACE_METRES,
  REFLECTION_TRACER_KEY,
  traceOffset,
  traceSpacing,
  traceTiles,
  type ReflectionLevel,
  type ReflectionsLight,
  type ReflectionTracer,
} from './post-reflections';

const TSL: N = TSLTyped;
const { Break, If, Fn, Loop, abs, cos, cross, dot, float, floor, getViewPosition, int, interleavedGradientNoise, luminance, max, min, mix, normalize, perspectiveDepthToViewZ, reflect, select, sin, smoothstep, sqrt, storage, texture, uniform, uv, vec2, vec3, vec4 } = TSL;

/** A hit within this share of the screen's edge fades out (the ray may have gone on past it). */
const EDGE_FADE = 0.06;
/** The last part of a ray's length over which its hit fades out. */
const FAR_FADE_FROM = 0.7;
/** How far behind the depth (m, and a share of the distance) a step may be and still count as meeting it: deeper it passed behind an object. */
const THICKNESS_M = 0.25;
const THICKNESS_SHARE = 0.02;
/** How far in front of a step the depth must be to count (m, and a share of the distance): a surface's own pixels never do. */
const HIT_BIAS_M = 0.02;
const HIT_BIAS_SHARE = 0.002;
/** A ray's lobe narrowed by this (squared roughness × it): fewer stray rays, a little sharper than GGX. */
const LOBE_SHRINK = 0.7;
/** How far (m) a traced ray starts off its surface. */
const TRACE_LIFT_M = 0.02;
/** A screen answer at least this sure casts no traced ray. */
const SURE = 0.98;
/** The brightest a reflected colour may be (luminance): one very bright pixel would flicker as a ray finds it now and then. */
const MAX_LUMINANCE = 16;
/** How alike a traced pixel's view depth (a share, plus metres) and facing (cosine) must be to a pixel's to lend it its light. */
const SPREAD_DEPTH_SHARE = 0.08;
const SPREAD_DEPTH_M = 0.05;
const SPREAD_FACING = 0.85;
/** A neighbour's weight in the screen answer's average (the pixel's own is 1). */
const SPREAD_NEIGHBOUR = 0.5;

/** A pixel's roughness for the scene pass's MRT: a physical material's own, 1 (reflects nothing traced) for every other kind. */
class ReflectionRoughnessNode extends (THREE.Node as unknown as new (type?: string) => { [k: string]: unknown }) {
  static get type(): string {
    return 'ReflectionRoughnessNode';
  }

  constructor() {
    super('float');
  }

  setup(builder: N): N {
    // Other kinds leave three's roughness unset (0 in WGSL: a mirror). A build keeps the material it was given (a
    // standard material three converts for itself, or a node material).
    const m = builder.material as { isMeshStandardNodeMaterial?: boolean; isMeshStandardMaterial?: boolean } | null;
    return m?.isMeshStandardNodeMaterial === true || m?.isMeshStandardMaterial === true ? TSL.roughness : float(1);
  }
}

/**
 * The scene pass's MRT `normal` the reflections read: the view normal and the
 * pixel's roughness (`ReflectionRoughnessNode`), packed into 8 bits a channel
 * where nothing else reads it (`packed`: half the bandwidth of the half-float
 * target ambient occlusion reads).
 */
export function reflectionNormal(packed: boolean): N {
  const r = TSL.nodeObject(new ReflectionRoughnessNode());
  return packed ? vec4(TSL.directionToColor(TSL.normalView), r) : vec4(TSL.normalView, r);
}

/** What the trace's program reads: the scene pass's targets and the passes' uniforms. */
interface TraceInputs {
  depth: N;
  normalAt(at: N): N;
  color: N;
  viewZAt(at: N): N;
  toUv(c: N): N;
  inside(q: N): N;
  near: N;
  proj: N;
  invProj: N;
  camWorld: N;
  size: N;
  frameU: N;
  spacing: N;
  offset: N;
  tiles: N;
  traceOn: N;
  level: ReflectionLevel;
}

/** The trace: the screen's answer per pixel, and the traced pixels' rays into `raysNode`. */
function traceNode(i: TraceInputs, raysNode: N): N {
  const { depth, normalAt, color, viewZAt, toUv, inside, near, proj, invProj, camWorld, size, frameU, spacing, offset, tiles, traceOn, level } = i;
  return Fn(() => {
    const at = uv();
    const res = vec4(0, 0, 0, -1).toVar();
    const rayO = vec3(0).toVar();
    const rayD = vec3(0, 1, 0).toVar();
    const rayMax = float(0).toVar();
    const d = depth.sample(at).x.toVar();
    If(d.lessThan(1), () => {
      const nr = normalAt(at).toVar();
      If(nr.w.lessThanEqual(REFLECTION_ROUGHNESS_MAX), () => {
        res.assign(vec4(0));
        const p = getViewPosition(at, d, invProj).toVar();
        const n = normalize(nr.xyz).toVar();
        const inc = normalize(p).toVar();
        // One direction of the roughness's lobe (GGX), turned per pixel and frame.
        const px = at.mul(size);
        const u1 = interleavedGradientNoise(px.add(frameU.mul(5.588238)));
        const u2 = interleavedGradientNoise(px.yx.add(vec2(17.3, 41.7)).add(frameU.mul(3.31)));
        const a = nr.w.mul(nr.w).mul(LOBE_SHRINK);
        const phi = u1.mul(Math.PI * 2);
        const cosT = sqrt(float(1).sub(u2).div(float(1).add(a.mul(a).sub(1).mul(u2))));
        const sinT = sqrt(max(float(0), float(1).sub(cosT.mul(cosT))));
        const up = select(abs(n.z).lessThan(0.999), vec3(0, 0, 1), vec3(1, 0, 0));
        const t = normalize(cross(up, n));
        const b = cross(n, t);
        const h = t.mul(sinT.mul(cos(phi))).add(b.mul(sinT.mul(sin(phi)))).add(n.mul(cosT));
        const dir = reflect(inc, h).toVar();
        If(dot(dir, n).lessThanEqual(0.01), () => {
          dir.assign(reflect(inc, n));
        });
        // The march in clip space: a step's view depth is the same blend of the ends' as its clip position.
        const e = p.add(dir.mul(REFLECTION_SCREEN_METRES)).toVar();
        If(e.z.greaterThan(near.negate().mul(1.01)), () => {
          e.assign(p.add(dir.mul(near.negate().mul(1.01).sub(p.z).div(dir.z))));
        });
        const c0 = proj.mul(vec4(p, 1)).toVar();
        const c1 = proj.mul(vec4(e, 1)).toVar();
        const jitter = interleavedGradientNoise(px.add(frameU.mul(7.13)).add(13.1));
        const found = float(0).toVar();
        const tLo = float(0).toVar();
        const tHi = float(0).toVar();
        const prev = float(0).toVar();
        const steps = level.steps;
        Loop(steps, ({ i }: { i: N }) => {
          const f = float(i).add(jitter).add(0.5).div(steps);
          const s = f.mul(f).toVar();
          const q = toUv(mix(c0, c1, s)).toVar();
          If(inside(q).not(), () => {
            Break();
          });
          const rz = mix(p.z, e.z, s);
          const behind = viewZAt(q).sub(rz);
          const thick = max(abs(rz.sub(mix(p.z, e.z, prev))), abs(rz).mul(THICKNESS_SHARE).add(THICKNESS_M));
          If(behind.greaterThan(abs(rz).mul(HIT_BIAS_SHARE).add(HIT_BIAS_M)).and(behind.lessThan(thick)), () => {
            found.assign(1);
            tLo.assign(prev);
            tHi.assign(s);
            Break();
          });
          prev.assign(s);
        });
        If(found.greaterThan(0.5), () => {
          for (let k = 0; k < level.refine; k += 1) {
            const m = tLo.add(tHi).mul(0.5);
            If(viewZAt(toUv(mix(c0, c1, m))).sub(mix(p.z, e.z, m)).greaterThan(0), () => {
              tHi.assign(m);
            }).Else(() => {
              tLo.assign(m);
            });
          }
          const q = toUv(mix(c0, c1, tHi)).toVar();
          // A hit on a surface's back (the ray slipped behind it) is no answer.
          const facing = dot(normalize(normalAt(q).xyz), dir).lessThan(0);
          const edge = min(min(q.x, float(1).sub(q.x)), min(q.y, float(1).sub(q.y)));
          const conf = smoothstep(0, EDGE_FADE, edge).mul(float(1).sub(smoothstep(FAR_FADE_FROM, 1, tHi)));
          const c = color.sample(q).rgb.toVar();
          c.mulAssign(min(float(1), float(MAX_LUMINANCE).div(max(luminance(c), 1e-4))));
          res.assign(vec4(c, select(facing, conf, float(0))));
        });
        If(res.w.lessThan(SURE), () => {
          rayO.assign(camWorld.mul(vec4(p.add(n.mul(TRACE_LIFT_M)), 1)).xyz);
          rayD.assign(normalize(camWorld.mul(vec4(dir, 0)).xyz));
          rayMax.assign(REFLECTION_TRACE_METRES);
        });
      });
    });
    // One pixel a square writes its ray (tmax 0: none needed).
    const rel = floor(at.mul(size)).sub(offset);
    const tile = floor(rel.div(spacing));
    const mine = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.sub(tile.mul(spacing)).length().lessThan(0.5)).and(tile.x.lessThan(tiles.x)).and(tile.y.lessThan(tiles.y)).and(traceOn.greaterThan(0.5));
    If(mine, () => {
      // Word by word through atomics: the only storage writes three allows outside compute.
      const at0 = int(tile.y.mul(tiles.x).add(tile.x)).mul(8);
      const words = [rayO.x, rayO.y, rayO.z, float(0), rayD.x, rayD.y, rayD.z, rayMax];
      words.forEach((v, j) => TSL.atomicStore(raysNode.element(at0.add(j)), TSL.floatBitsToUint(v)));
    });
    return res;
  })();
}

export interface ReflectionsStage {
  /** The node that draws the passes each frame (built into the pipeline's output). */
  readonly passes: N;
  setScale(sceneScale: number): void;
  beforeFrame(camera: THREE.Camera): void;
  afterFrame(camera: THREE.Camera): void;
  dispose(): void;
}

type Renderer = THREE.WebGPURenderer & { backend: { get(o: unknown): { buffer?: unknown } | undefined } };

/** Light of `traced` over `level`, drawn from `scenePass` (MRT `normal`: view normal and roughness) into `light`; `scene` may hold the tracer. */
export function buildReflections(renderer: THREE.WebGPURenderer, scenePass: N, scene: THREE.Scene, light: ReflectionsLight, level: ReflectionLevel, traced: boolean, packedNormal: boolean, motion: N | null): ReflectionsStage {
  const depth: N = scenePass.getTextureNode('depth');
  const normalTex: N = scenePass.getTextureNode('normal');
  // The view normal (and roughness in w) at `at`: as written, or packed into 8 bits a channel (`reflectionNormal`).
  const normalAt = (at: N): N => {
    const v = normalTex.sample(at);
    return packedNormal ? vec4(TSL.colorToDirection(v.xyz), v.w) : v;
  };
  const color: N = scenePass.getTextureNode('output');
  const near: N = scenePass._cameraNear;
  const far: N = scenePass._cameraFar;
  const proj = uniform(new THREE.Matrix4());
  const invProj = uniform(new THREE.Matrix4());
  const camWorld = uniform(new THREE.Matrix4());
  const size = uniform(new THREE.Vector2(1, 1));
  const frameU = uniform(0);
  const spacing = uniform(1);
  const offset = uniform(new THREE.Vector2());
  const tiles = uniform(new THREE.Vector2());
  const traceOn = uniform(0);
  // The traced rays the light buffer holds: their frame's spacing, place and squares (the resolve reads them by those).
  const heldSpacing = uniform(1);
  const heldOffset = uniform(new THREE.Vector2());
  const heldTiles = uniform(new THREE.Vector2());
  const tracedNow = uniform(0);
  // A new frame's share: while the rays hold still a new frame repeats the last, so the history only smooths a change.
  const blend = uniform(REFLECTION_HISTORY_BLEND);
  const traceTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  // The resolve and the view depth beside it (copied into the light's depth: the next frame's reads test it).
  const resolveTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, count: 2 });
  const traceTex: N = texture(traceTarget.texture);
  const viewZAt = (at: N): N => perspectiveDepthToViewZ(depth.sample(at).x, near, far);
  const toUv = (c: N): N => {
    const ndc = c.xy.div(c.w);
    return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
  };
  const inside = (q: N): N => q.x.greaterThanEqual(0).and(q.x.lessThanEqual(1)).and(q.y.greaterThanEqual(0)).and(q.y.lessThanEqual(1));

  let capacity = 0;
  let rays: THREE.StorageBufferAttribute | null = null;
  let out: THREE.StorageBufferAttribute | null = null;
  let traceMat: THREE.NodeMaterial | null = null;
  let resolveMat: THREE.NodeMaterial | null = null;
  const quad = new THREE.QuadMesh(new THREE.NodeMaterial());

  const resolvedOut = TSL.property('vec4');
  const depthOut = TSL.property('vec4');
  /** The resolve: this frame's answer (the screen's, the traced squares' where it fell short) into the history, and the view depth. */
  const resolveNode = (outNode: N): N =>
    Fn(() => {
      const at = uv();
      depthOut.assign(vec4(viewZAt(at), 0, 0, 1));
      const res = vec4(0).toVar();
      const d = depth.sample(at).x.toVar();
      const s = traceTex.sample(at).toVar();
      If(d.lessThan(1).and(s.w.greaterThanEqual(0)), () => {
        const p = getViewPosition(at, d, invProj).toVar();
        // The screen's answer here and at the four diagonal neighbours on the same surface: a glossy surface's
        // scattered rays averaged over a few pixels before the history averages them over frames.
        const c = s.w.toVar();
        const rgb = s.rgb.mul(c).toVar();
        const n0 = float(1).toVar();
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          const q = at.add(vec2(dx, dy).div(size));
          const sn = traceTex.sample(q);
          const alike = inside(q).and(sn.w.greaterThanEqual(0)).and(abs(viewZAt(q).sub(p.z)).lessThan(abs(p.z).mul(SPREAD_DEPTH_SHARE).add(SPREAD_DEPTH_M)));
          const w = select(alike, float(SPREAD_NEIGHBOUR), float(0));
          rgb.addAssign(sn.rgb.mul(sn.w.mul(w)));
          c.addAssign(sn.w.mul(w));
          n0.addAssign(w);
        }
        rgb.divAssign(n0);
        c.divAssign(n0);
        If(tracedNow.greaterThan(0.5).and(c.lessThan(1)), () => {
          const nq = normalize(normalAt(at).xyz).toVar();
          const f = floor(at.mul(size)).sub(heldOffset).div(heldSpacing).toVar();
          const t0 = floor(f).toVar();
          const fr = f.sub(t0).toVar();
          const sumW = float(0).toVar();
          const sumWC = float(0).toVar();
          const sumL = vec3(0).toVar();
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            const tt = t0.add(vec2(dx, dy));
            const bil = (dx === 0 ? float(1).sub(fr.x) : fr.x).mul(dy === 0 ? float(1).sub(fr.y) : fr.y);
            const ok = tt.x.greaterThanEqual(0).and(tt.y.greaterThanEqual(0)).and(tt.x.lessThan(heldTiles.x)).and(tt.y.lessThan(heldTiles.y));
            If(ok, () => {
              const tuv = tt.mul(heldSpacing).add(heldOffset).add(0.5).div(size);
              const o = outNode.element(int(tt.y.mul(heldTiles.x).add(tt.x))).toVar();
              const zt = viewZAt(tuv);
              const alike = abs(zt.sub(p.z)).lessThan(abs(p.z).mul(SPREAD_DEPTH_SHARE).add(SPREAD_DEPTH_M)).and(dot(normalize(normalAt(tuv).xyz), nq).greaterThan(SPREAD_FACING)).and(o.w.greaterThanEqual(0));
              const w = select(alike, bil.add(1e-3), float(0));
              sumW.addAssign(w);
              sumWC.addAssign(w.mul(o.w));
              sumL.addAssign(o.rgb.mul(w.mul(o.w)));
            });
          }
          If(sumW.greaterThan(0), () => {
            const tc = sumWC.div(sumW);
            const tl = sumL.div(max(sumWC, 1e-4));
            const share = float(1).sub(c).mul(tc);
            rgb.addAssign(tl.mul(share));
            c.addAssign(share);
          });
        });
        // The history where this surface was on the last frame, if the depth there is its own.
        const l = light;
        const view = l.toLastView.mul(vec4(p, 1)).xyz.toVar();
        const hu = (motion !== null ? at.sub(motion.sample(at).xy.mul(vec2(0.5, -0.5))) : toUv(l.toLastClip.mul(vec4(p, 1)))).toVar();
        const h = l.history.sample(hu).toVar();
        const hz = l.depth.sample(hu).x;
        const kept = inside(hu).and(abs(hz.sub(view.z)).lessThan(abs(view.z).mul(HISTORY_DEPTH_TOLERANCE).add(SPREAD_DEPTH_M))).and(l.active.greaterThan(0.5));
        If(kept, () => {
          rgb.assign(mix(h.rgb.mul(h.a), rgb, blend));
          c.assign(mix(h.a, c, blend));
        });
        res.assign(vec4(rgb.div(max(c, 1e-4)), c));
      });
      resolvedOut.assign(res);
      return vec4(0);
    })();

  /** Storage for the traced rays and their light (`count` rays), and the two materials that use them. */
  const make = (count: number): void => {
    // The old buffers go with their materials (three would keep their GPU buffers otherwise).
    releaseStorage(renderer, [rays, out]);
    held = false;
    capacity = count;
    rays = new THREE.StorageBufferAttribute(new Uint32Array(count * 8), 1);
    out = new THREE.StorageBufferAttribute(new Float32Array(count * 4), 4);
    traceMat?.dispose();
    resolveMat?.dispose();
    traceMat = new THREE.NodeMaterial();
    traceMat.name = 'reflections trace';
    traceMat.fragmentNode = traceNode({ depth, normalAt, color, viewZAt, toUv, inside, near, proj, invProj, camWorld, size, frameU, spacing, offset, tiles, traceOn, level }, storage(rays, 'uint', count * 8).toAtomic());
    resolveMat = new THREE.NodeMaterial();
    resolveMat.name = 'reflections resolve';
    resolveMat.colorNode = resolveNode(storage(out, 'vec4', count).toReadOnly());
    (resolveMat as unknown as { outputNode: N }).outputNode = TSL.outputStruct(resolvedOut, depthOut);
  };

  let frames = 0;
  let all = 0;
  let every = 1;
  let held = false;
  let heldW = 0;
  let heldH = 0;
  let heldRays = 0;
  let still = 0;
  const lastCam = new THREE.Matrix4();
  const lastProj = new THREE.Matrix4();
  let k = level.minSpacing;
  let drawn = false;
  let state: unknown;
  const lastView = new THREE.Matrix4();
  const lastViewProjection = new THREE.Matrix4();
  const buf = new THREE.Vector2();
  let share = REFLECTION_RESOLUTION_SCALE;

  /** The passes, run once a frame after the scene pass (its depth, normals and colour are this frame's). */
  class ReflectionPassNode extends (THREE.TempNode as unknown as new (type: string) => { updateBeforeType: string; [k: string]: unknown }) {
    static get type(): string {
      return 'ReflectionPassNode';
    }

    constructor() {
      super('vec4');
      this.updateBeforeType = TSL.NodeUpdateType.FRAME;
    }

    setup(): N {
      return vec4(0);
    }

    updateBefore(frame: { renderer: Renderer; camera?: THREE.Camera }): void {
      const r = frame.renderer;
      const w = light.historyTarget.width;
      const h = light.historyTarget.height;
      if (!light.initialized || w < 2 || h < 2) return;
      const cam = camera;
      proj.value.copy(cam.projectionMatrix);
      invProj.value.copy(cam.projectionMatrixInverse);
      camWorld.value.copy(cam.matrixWorld);
      size.value.set(w, h);
      // The rays turn (and the traced pixels move) only while the view moves and a few frames after: a still view
      // of a still scene then settles to one picture, and a moving object's reflection still follows it.
      const moved = !lastCam.equals(cam.matrixWorld) || !lastProj.equals(cam.projectionMatrix);
      lastCam.copy(cam.matrixWorld);
      lastProj.copy(cam.projectionMatrix);
      still = moved ? 0 : still + 1;
      const turning = still < REFLECTION_STILL_FRAMES;
      const tracer = traced ? ((scene.userData[REFLECTION_TRACER_KEY] as ReflectionTracer | undefined) ?? null) : null;
      if (turning) {
        frames += 1;
        if (frames % REFLECTION_SPACING_FRAMES === 1) k = traceSpacing(w, h, tracer?.msPerRay() ?? null, level.traceMs, level.minSpacing);
      }
      // A run costs at least the GPU's latency floor (a few thousand rays cost about what tens of thousands do): one
      // that costs more than the budget even at the coarsest spacing is run every few frames instead (the light
      // buffer holds its rays' light meanwhile); a still view's rays are the same each frame, so they are traced
      // again only now and then (a light's change still shows).
      all += 1;
      if (all % REFLECTION_SPACING_FRAMES === 1) {
        const ms = tracer?.last().ms ?? null;
        every = ms === null ? 1 : Math.min(REFLECTION_TRACE_INTERVAL_MAX, Math.max(1, Math.ceil(ms / level.traceMs)));
      }
      const interval = turning ? every : Math.max(every, REFLECTION_STILL_TRACE_FRAMES);
      frameU.value = frames % 4096;
      blend.value = turning ? REFLECTION_HISTORY_BLEND : REFLECTION_STILL_BLEND;
      const [ox, oy] = traceOffset(frames, k);
      const t = traceTiles(w, h, k, ox, oy);
      const need = traceTiles(w, h, level.minSpacing, 0, 0).count;
      if (need > capacity) make(Math.ceil(need * 1.25));
      spacing.value = k;
      offset.value.set(ox, oy);
      tiles.value.set(t.x, t.y);
      if (w !== heldW || h !== heldH) held = false;
      const tracing = tracer !== null && t.count > 0 && (!held || all % interval === 0);
      traceOn.value = tracing ? 1 : 0;
      traceTarget.setSize(w, h);
      resolveTarget.setSize(w, h);
      state = THREE.RendererUtils.resetRendererState(r, state as never);
      try {
        r.setMRT(null);
        r.setClearColor(0x000000, 0);
        quad.material = traceMat!;
        r.setRenderTarget(traceTarget);
        quad.render(r);
        let didTrace = false;
        if (tracing) {
          const raysBuf = r.backend.get(rays!)?.buffer;
          const outBuf = r.backend.get(out!)?.buffer;
          // The light's buffer exists once the resolve bound it (the frame after the storage was made).
          if (raysBuf !== undefined && outBuf !== undefined) didTrace = tracer!.trace(raysBuf, outBuf, t.count);
        }
        if (didTrace) {
          held = true;
          heldW = w;
          heldH = h;
          heldSpacing.value = k;
          heldOffset.value.set(ox, oy);
          heldTiles.value.set(t.x, t.y);
          heldRays = t.count;
        }
        tracedNow.value = held && tracer !== null ? 1 : 0;
        quad.material = resolveMat!;
        r.setRenderTarget(resolveTarget);
        quad.render(r);
        r.copyTextureToTexture(resolveTarget.textures[0]!, light.historyTarget.texture);
        r.copyTextureToTexture(resolveTarget.textures[1]!, light.depthTarget.texture);
        drawn = true;
        const last = tracer?.last();
        light.stats = { width: w, height: h, spacing: held ? heldSpacing.value : 0, rays: held ? heldRays : 0, every: interval, traceMs: held ? (last?.ms ?? null) : null };
      } finally {
        THREE.RendererUtils.restoreRendererState(r, state as never);
      }
    }
  }
  let camera: THREE.Camera = new THREE.PerspectiveCamera();
  const node: N = TSL.nodeObject(new ReflectionPassNode());

  return {
    passes: node,
    setScale(sceneScale) {
      share = REFLECTION_RESOLUTION_SCALE * sceneScale;
    },
    beforeFrame(cam) {
      camera = cam;
      // The history at this frame's size before the scene pass binds it.
      renderer.getDrawingBufferSize(buf);
      const w = Math.max(1, Math.floor(buf.x * share));
      const h = Math.max(1, Math.floor(buf.y * share));
      if (light.historyTarget.width !== w || light.historyTarget.height !== h || !light.initialized) {
        light.historyTarget.setSize(w, h);
        light.depthTarget.setSize(w, h);
        light.shadow.mapSize.set(w, h);
        // Made as render targets now, before the lit programs bind them (see `buildScreenHistory`).
        renderer.initRenderTarget(light.historyTarget);
        renderer.initRenderTarget(light.depthTarget);
        light.initialized = true;
        drawn = false;
      }
      light.toLastView.value.multiplyMatrices(lastView, cam.matrixWorld);
      light.toLastClip.value.multiplyMatrices(lastViewProjection, cam.matrixWorld);
      light.active.value = drawn ? 1 : 0;
    },
    afterFrame(cam) {
      light.active.value = 0;
      lastView.copy(cam.matrixWorldInverse);
      lastViewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    },
    dispose() {
      light.active.value = 0;
      traceTarget.dispose();
      resolveTarget.dispose();
      traceMat?.dispose();
      resolveMat?.dispose();
      releaseStorage(renderer, [rays, out]);
      node.dispose?.();
    },
  };
}
