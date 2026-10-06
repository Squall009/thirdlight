/**
 * What three.js itself is handed, read from any page that draws with
 * three's `WebGPURenderer` (the export, Play, a plain three.js page) with
 * no hook in the product: three announces every renderer it makes on
 * `__THREE_DEVTOOLS__` (the browser devtools' channel), which this init
 * script defines before any page script runs.
 *
 * - The scene graph three walks every frame: Object3Ds by kind (groups, LOD
 *   nodes, meshes drawn and hidden, bones, lights).
 * - GPU time per render pass from three's own timestamp queries
 *   (`trackTimestamp`, WebGPU's `timestamp-query`), switched on only while a
 *   GPU window is measured, so the frame-time window runs without the
 *   queries. Passes are named from what three renders (the scene, a shadow
 *   map, a post quad) and its target's size. WebGL 2 is not timed (see
 *   `probeGpuPasses`).
 *
 * The functions are serialized into the page: they must not close over anything.
 */

export interface SceneCounts {
  /** Every Object3D under the scenes drawn last frame (scene roots included). */
  objects: number;
  groups: number;
  lods: number;
  meshes: number;
  /** Meshes hidden by themselves or an ancestor (LOD levels not drawn, switched-off parts). */
  hiddenMeshes: number;
  instancedMeshes: number;
  batchedMeshes: number;
  skinnedMeshes: number;
  bones: number;
  lights: number;
  pointLights: number;
  /** Distinct materials on the meshes drawn. */
  materials: number;
  /** three's own counters (the last frame). */
  info: { calls: number; triangles: number; geometries: number; textures: number } | null;
  /** Draw calls of the last frame by pass: the view's scene, shadow maps (a scene drawn from an orthographic light camera), post quads. */
  passDraws: { scene: number; shadow: number; post: number };
  /** Shadow-map draws per drawn frame over the last 1,500 frames (a cached map drawn again shows in the mean and the tail). */
  shadowDraws: { frames: number; mean: number; p50: number; p95: number; max: number };
  /** The engine's merged static cells (meshes named `tl-merged:`): how many, how many drawn now, their GPU bytes. */
  merged: { meshes: number; shown: number; vertexBytes: number; indexBytes: number };
  /** Levels of detail in the last frame: placed models' and instance-set copies' level switches, and the instance-set copies the view drew. */
  lod: { switches: number; copySwitches: number; copiesInView: number };
}

export interface GpuPassTiming {
  /** What was rendered: `scene`, `shadow`, `post:<material>`, … and the target's size. */
  label: string;
  /** Mean GPU ms per frame the pass ran in, and in how many of the resolved frames it ran. */
  msPerFrame: number;
  frames: number;
}

export interface GpuTimings {
  /** Whether the renderer records timestamps here (the device has the queries). */
  available: boolean;
  /** Why not, when not. */
  note?: string;
  /** Frames resolved in the window and the mean GPU ms per frame over every pass. */
  frames: number;
  msPerFrame: number;
  passes: GpuPassTiming[];
}

interface ProbeRenderer {
  render(scene: unknown, camera: unknown): unknown;
  resolveTimestampsAsync?(type?: string): Promise<number | undefined>;
  backend?: { trackTimestamp?: boolean; disjoint?: unknown; timestampQueryPool?: Record<string, { timestamps?: Map<string, number> } | null> };
  inspector?: { beginRender?: (uid: string, scene: unknown, camera: unknown, target: unknown) => void };
  info?: { render?: { calls?: number; triangles?: number }; memory?: { geometries?: number; textures?: number } };
}

interface ProbeState {
  renderers: ProbeRenderer[];
  /** Scenes rendered in the current and the last frame, each with its view camera (a post quad counts too; counts pick real scenes). */
  frameScenes: Map<unknown, unknown>;
  lastScenes: Map<unknown, unknown>;
  /** Timestamps requested at construction (so the WebGPU device asks for the feature). */
  timestamps: boolean;
  /** Pass labels by render-context id (the timestamp uid's part before `:f<frame>`). */
  labels: Map<string, string>;
  /** Draw calls by pass in the current and the last frame (three's `info.render.drawCalls`, nested renders apart). */
  framePasses: { scene: number; shadow: number; post: number };
  lastPasses: { scene: number; shadow: number; post: number };
  /** The last frames' shadow-map draws. */
  shadowFrames: number[];
}

/** Install with `addInitScript(installFrameProbe, { timestamps })` before the page's scripts. */
export function installFrameProbe(opts: { timestamps: boolean }): void {
  const w = window as unknown as { __tlProbe?: ProbeState; __THREE_DEVTOOLS__?: EventTarget };
  if (w.__tlProbe !== undefined) return;
  const P: ProbeState = { renderers: [], frameScenes: new Map(), lastScenes: new Map(), timestamps: opts.timestamps, labels: new Map(), framePasses: { scene: 0, shadow: 0, post: 0 }, lastPasses: { scene: 0, shadow: 0, post: 0 }, shadowFrames: [] };
  w.__tlProbe = P;
  const roll = (): void => {
    if (P.frameScenes.size > 0) {
      P.lastScenes = P.frameScenes;
      P.frameScenes = new Map();
      P.lastPasses = P.framePasses;
      P.framePasses = { scene: 0, shadow: 0, post: 0 };
      P.shadowFrames.push(P.lastPasses.shadow);
      // About the measured window at 100–150 fps.
      if (P.shadowFrames.length > 1500) P.shadowFrames.shift();
    }
    requestAnimationFrame(roll);
  };
  requestAnimationFrame(roll);
  const hub = w.__THREE_DEVTOOLS__ ?? new EventTarget();
  w.__THREE_DEVTOOLS__ = hub;
  hub.addEventListener('observe', (ev) => {
    const r = (ev as CustomEvent).detail as ProbeRenderer & { isRenderer?: boolean };
    if (r === null || typeof r !== 'object' || typeof r.render !== 'function' || r.backend === undefined) return;
    P.renderers.push(r);
    // Asked for at construction: WebGPU then requests the device feature; the frame window turns the queries off.
    if (P.timestamps && r.backend !== undefined) r.backend.trackTimestamp = true;
    const render = r.render;
    /** Draws of the renders running now (outermost first): a nested render's draws are not its parent's. */
    const nested: number[] = [];
    r.render = function (this: ProbeRenderer & { info?: { render?: { drawCalls?: number } } }, scene: unknown, camera: unknown) {
      const ortho = (camera as { isOrthographicCamera?: boolean } | null)?.isOrthographicCamera === true;
      // The view camera, not a shadow map's (a scene is also rendered from its lights).
      if (!P.frameScenes.has(scene) || !ortho) P.frameScenes.set(scene, camera);
      const counter = (): number => this.info?.render?.drawCalls ?? 0;
      const before = counter();
      nested.push(0);
      try {
        return render.call(this, scene, camera);
      } finally {
        const inner = nested.pop()!;
        const total = Math.max(0, counter() - before);
        if (nested.length > 0) nested[nested.length - 1]! += total;
        const s = scene as { isScene?: boolean; isQuadMesh?: boolean } | null;
        const kind = s?.isScene === true ? (ortho ? 'shadow' : 'scene') : 'post';
        P.framePasses[kind] += Math.max(0, total - inner);
      }
    };
    const ins = r.inspector;
    if (ins !== undefined && typeof ins.beginRender === 'function') {
      const begin = ins.beginRender;
      ins.beginRender = function (this: unknown, uid: string, scene: unknown, camera: unknown, target: unknown) {
        const ctx = String(uid).replace(/:f\d+$/, '');
        if (!P.labels.has(ctx)) {
          const s = scene as { isScene?: boolean; isQuadMesh?: boolean; type?: string; material?: { name?: string; type?: string } } | null;
          const c = camera as { isOrthographicCamera?: boolean } | null;
          const t = target as { width?: number; height?: number; depthTexture?: unknown; textures?: unknown[] } | null;
          const size = t !== null && t !== undefined ? `${t.width}x${t.height}` : 'canvas';
          const kind = s?.isQuadMesh === true ? `post:${s.material?.name || s.material?.type || 'quad'}` : s?.isScene === true ? (c?.isOrthographicCamera === true && t !== null && t !== undefined ? 'shadow' : 'scene') : (s?.type ?? 'object');
          P.labels.set(ctx, `${kind} ${size}`);
        }
        return begin.call(this, uid, scene, camera, target);
      };
    }
  });
}

/** In the page: turn three's timestamp queries on or off (answers whether a renderer records them). */
export function probeSetGpuTiming(on: boolean): boolean {
  const P = (window as unknown as { __tlProbe?: ProbeState }).__tlProbe;
  let any = false;
  for (const r of P?.renderers ?? []) {
    const b = r.backend;
    if (b === undefined) continue;
    // WebGL 2 without the timer extension has no `disjoint`: nothing to record.
    const can = P!.timestamps && (b.disjoint === undefined || b.disjoint !== null);
    b.trackTimestamp = on && can;
    any = any || b.trackTimestamp === true;
  }
  return any;
}

/** In the page: what the scenes drawn last frame hold. */
export function probeSceneCounts(): SceneCounts {
  const P = (window as unknown as { __tlProbe?: ProbeState }).__tlProbe;
  const out: SceneCounts = { objects: 0, groups: 0, lods: 0, meshes: 0, hiddenMeshes: 0, instancedMeshes: 0, batchedMeshes: 0, skinnedMeshes: 0, bones: 0, lights: 0, pointLights: 0, materials: 0, info: null, passDraws: { scene: 0, shadow: 0, post: 0 }, shadowDraws: { frames: 0, mean: 0, p50: 0, p95: 0, max: 0 }, merged: { meshes: 0, shown: 0, vertexBytes: 0, indexBytes: 0 }, lod: { switches: 0, copySwitches: 0, copiesInView: 0 } };
  if (P === undefined) return out;
  out.passDraws = { ...P.lastPasses };
  if (P.shadowFrames.length > 0) {
    const s = [...P.shadowFrames].sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
    out.shadowDraws = { frames: s.length, mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! };
  }
  type O = { isScene?: boolean; isGroup?: boolean; isLOD?: boolean; isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; isBone?: boolean; isLight?: boolean; isPointLight?: boolean; visible: boolean; children: O[]; material?: unknown; name?: string; geometry?: { attributes: Record<string, { array: { byteLength: number } }>; index: { array: { byteLength: number } } | null } };
  const mats = new Set<unknown>();
  const walk = (o: O, shown: boolean): void => {
    out.objects += 1;
    const vis = shown && o.visible;
    if (o.isGroup === true) out.groups += 1;
    if (o.isLOD === true) out.lods += 1;
    if (o.isMesh === true) {
      out.meshes += 1;
      if (!vis) out.hiddenMeshes += 1;
      else for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
    }
    if (o.isMesh === true && o.name?.startsWith('tl-merged:') === true && o.geometry !== undefined) {
      out.merged.meshes += 1;
      if (vis) out.merged.shown += 1;
      for (const a of Object.values(o.geometry.attributes)) out.merged.vertexBytes += a.array.byteLength;
      out.merged.indexBytes += o.geometry.index?.array.byteLength ?? 0;
    }
    // The engine's instance-set chunk draws (three-adapter INSTANCE_SET_KEY) and what the view drew of them.
    const ud = (o as { userData?: Record<string, unknown> }).userData;
    if (ud?.['tlInstanceSet'] === true) out.lod.copiesInView += (ud['__tlViewCull'] as { inView?: number } | undefined)?.inView ?? 0;
    // The adapter's LOD tuning on its scene (three-adapter LOD_TUNING_KEY): the frame's switches.
    const t = o.isScene === true ? (ud?.['tlLodTuning'] as { switches?: number; copySwitches?: number } | undefined) : undefined;
    if (t !== undefined) {
      out.lod.switches += t.switches ?? 0;
      out.lod.copySwitches += t.copySwitches ?? 0;
    }
    if (o.isInstancedMesh === true) out.instancedMeshes += 1;
    if (o.isBatchedMesh === true) out.batchedMeshes += 1;
    if (o.isSkinnedMesh === true) out.skinnedMeshes += 1;
    if (o.isBone === true) out.bones += 1;
    if (o.isLight === true) out.lights += 1;
    if (o.isPointLight === true) out.pointLights += 1;
    for (const c of o.children) walk(c, vis);
  };
  for (const s of P.lastScenes.keys()) if ((s as O | null)?.isScene === true) walk(s as O, true);
  out.materials = mats.size;
  const r = P.renderers[P.renderers.length - 1];
  if (r?.info !== undefined) out.info = { calls: r.info.render?.calls ?? 0, triangles: r.info.render?.triangles ?? 0, geometries: r.info.memory?.geometries ?? 0, textures: r.info.memory?.textures ?? 0 };
  return out;
}

/** In the page: GPU time per pass over `ms` (resolves three's queries after every frame). */
export async function probeGpuPasses(ms: number): Promise<GpuTimings> {
  const P = (window as unknown as { __tlProbe?: ProbeState }).__tlProbe;
  const out: GpuTimings = { available: false, frames: 0, msPerFrame: 0, passes: [] };
  const r = P?.renderers[P.renderers.length - 1];
  if (P === undefined || r === undefined || typeof r.resolveTimestampsAsync !== 'function') return { ...out, note: 'no three renderer seen' };
  // WebGL 2 has one timer query at a time: three times only the outermost render, and a post stack draws its
  // passes inside the final one, so that timer spans the CPU's gaps too. Only WebGPU times every pass.
  if (r.backend?.disjoint !== undefined) return { ...out, note: 'WebGL 2: three times only the outermost pass (the post passes run inside it), not GPU work' };
  const byLabel = new Map<string, { ms: number; frames: Set<string> }>();
  const frames = new Set<string>();
  let total = 0;
  // Compute passes (GPU particles, …) are timed in their own pool and count in the frame's GPU time too.
  const read = (type: 'render' | 'compute'): void => {
    const pool = r.backend?.timestampQueryPool?.[type];
    for (const [uid, d] of pool?.timestamps ?? []) {
      const m = /^(.*):f(\d+)$/.exec(uid);
      if (m === null || !Number.isFinite(d) || d < 0) continue;
      const label = type === 'compute' ? 'compute' : (P.labels.get(m[1]!) ?? `context ${m[1]}`);
      const row = byLabel.get(label) ?? { ms: 0, frames: new Set<string>() };
      row.ms += d;
      row.frames.add(m[2]!);
      byLabel.set(label, row);
      frames.add(m[2]!);
      total += d;
    }
  };
  // Let the frame drawn when the queries came on be the first one resolved.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try {
      await r.resolveTimestampsAsync('render');
      read('render');
      if (r.backend?.timestampQueryPool?.['compute'] !== undefined && r.backend.timestampQueryPool['compute'] !== null) {
        await r.resolveTimestampsAsync('compute');
        read('compute');
      }
    } catch {
      break;
    }
    await new Promise((res) => requestAnimationFrame(res));
  }
  out.available = frames.size > 0;
  out.frames = frames.size;
  out.msPerFrame = frames.size > 0 ? Math.round((total / frames.size) * 1000) / 1000 : 0;
  out.passes = [...byLabel.entries()]
    .map(([label, v]) => ({ label, msPerFrame: Math.round((v.ms / Math.max(1, v.frames.size)) * 1000) / 1000, frames: v.frames.size }))
    .sort((a, b) => b.msPerFrame * b.frames - a.msPerFrame * a.frames);
  return out;
}
