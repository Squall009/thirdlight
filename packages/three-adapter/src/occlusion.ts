/**
 * Occlusion culling in the adapter: which path a frame culls on, the draws
 * it may leave out (occludees.ts), what it left out, and the switch a page,
 * the perf harness and the occlusion oracle read.
 *
 * The path comes from the project's `occlusion_culling` (or its quality
 * level's, through the render control) and the renderer: on culls with a
 * depth pyramid on WebGPU (`hiz`) and nothing on WebGL 2; auto culls nothing
 * for now; the runtime's `occlusionPathOf` decides. The page flag
 * `?occlusion=off|hiz` pins one for a comparison (the perf harness's
 * `--switches occlusion=off`), as does the scene's switch at run time.
 *
 * A draw left out is hidden from the view for `HIDDEN_BY_OCCLUSION`
 * (view-hidden.ts): the shadow cameras and probe bakes still draw it, as a
 * caster hidden from the view still casts into it. Whatever the culler hid
 * comes back when its path changes or it is disposed.
 *
 * While a path is on, models' `_OCC` stand-ins (occluders.ts) draw for the
 * view: the culler answers, per camera, whether they draw (the view's camera
 * only) and counts what they drew. On the depth pyramid path (`hiz`, WebGPU)
 * the frame draws in two passes with the pyramid between them
 * (occlusion-passes.ts); the stand-ins draw in the first pass only, into the
 * pyramid (never into the scene's depth, which ambient occlusion, fog and
 * transparent draws read), and the copies of instanced draws are culled on
 * the GPU against it (occlusion-instances.ts; the diagnostics' tested and
 * culled count copies, read back a few frames late), as are block and
 * architecture chunks, merged cells and models drawn alone, each as a whole
 * (occlusion-whole.ts; counted with the copies).
 *
 * Runs once a frame after the frustum, the rooms and an edit mode's isolation
 * have had their say (what they hide is not tested again). Kept out of
 * `adapter.ts`, which gives it the scene, the setting and the renderer and
 * reads its diagnostics.
 */
import * as THREE from 'three';
import { occlusionPathFrom, occlusionPathOf, type OccludeeKind, type OccluderRole, type OcclusionCulling, type OcclusionPath, type OcclusionRenderer } from '@thirdlight/runtime';

import { OccludeeRegistry, occludeeWorldBounds, type Occludee } from './occludees';
import { isOccluderStandin, STANDIN_VIEW_KEY, standinFollowsSurfaces, standinMaterialOf } from './occluders';
import { TwoPassFrame, type ScenePasses } from './occlusion-passes';
import type { InstanceOcclusionDiagnostics } from './occlusion-instances';
import { OcclusionKeep, type OcclusionKeepHost } from './occlusion-keep';
import { OcclusionOverlay } from './occlusion-overlay';
import { culledWhole } from './occlusion-whole';
import type { PyramidReadback } from './occlusion-pyramid';
import { HIDDEN_BY_OCCLUSION, hideFromView } from './view-hidden';

/** The page flag that pins a path (`?occlusion=off|hiz`; a diagnostic comparison). */
export const OCCLUSION_URL_PARAM = 'occlusion';

/** The flag's value that shows the depth pyramid over the frame (`?occlusion=pyramid`, or `pyramid:<level>`); it pins `hiz`. */
const PYRAMID_FLAG = /^pyramid(?::(\d{1,2}))?$/;

/** The path a page's query string pins (null: none, or not a path). */
export function occlusionFromUrl(search: string): OcclusionPath | null {
  const v = new URLSearchParams(search).get(OCCLUSION_URL_PARAM);
  return v !== null && PYRAMID_FLAG.test(v) ? 'hiz' : occlusionPathFrom(v);
}

/** The pyramid level a page's query string shows (`?occlusion=pyramid`: level 0; null: the picture). */
export function occlusionPyramidFromUrl(search: string): number | null {
  const m = PYRAMID_FLAG.exec(new URLSearchParams(search).get(OCCLUSION_URL_PARAM) ?? '');
  return m === null ? null : Number(m[1] ?? 0);
}

/** The problem code of an `on` setting on a renderer without a culling path (WebGL 2). */
export const OCCLUSION_NO_PATH_PROBLEM = 'occlusion_culling_unavailable';

/** `scene.userData[OCCLUSION_SWITCH_KEY]`: the scene's {@link OcclusionSwitch}. */
export const OCCLUSION_SWITCH_KEY = 'tlOcclusion';

/** What a page tool reads and pins of occlusion culling (the perf harness, the occlusion oracle, a test). */
export interface OcclusionSwitch {
  /** The path frames cull on now. */
  path(): OcclusionPath;
  /** Pin a path from now on (null: the setting's again); what was hidden for the old path is shown at once. */
  pin(path: OcclusionPath | null): void;
  diagnostics(): OcclusionDiagnostics;
  /** Show the depth pyramid's level `level` over the frame (null: the picture again); WebGPU's `hiz` path only. */
  showPyramid(level: number | null): void;
  /** The depth pyramid as last built, read back from the GPU (null: no pyramid). */
  readPyramid(): Promise<PyramidReadback | null>;
  /** Draw a tinted box round each draw culled now (occlusion-overlay.ts), or stop. */
  showCulled(on: boolean): void;
  /** Never cull these objects' draws (an editor's selection, the object an edit mode edits; empty: none). */
  keep(entityIds: ReadonlySet<string>): void;
}

export interface OcclusionDiagnostics {
  /** The project's (or the quality level's) setting. */
  readonly setting: OcclusionCulling;
  /** The path frames cull on, and whether the page (its flag, or the scene's switch) or the setting chose it. */
  readonly path: OcclusionPath;
  readonly source: 'page' | 'setting';
  /** The path pinned (null: none). */
  readonly pinned: OcclusionPath | null;
  /** Draws that could be left out, all and by kind. */
  readonly occludees: number;
  readonly byKind: Readonly<Record<OccludeeKind, number>>;
  /** The occludees by occluder role (what fills the depth the tests read, and in which order). */
  readonly byRole: Readonly<Record<OccluderRole, number>>;
  /** `_OCC` stand-in draws the view drew into its depth in the last frame. */
  readonly standins: number;
  /** Items tested and left out (instanced copies and draws culled whole; read back from the GPU on `hiz`, a few frames late). */
  readonly tested: number;
  readonly culled: number;
  /** On the two-pass path: items left out of the first pass by the last answer (copies, and draws culled whole moved to the second), and items drawn in the second. */
  readonly pass1Culled: number;
  readonly pass2Drawn: number;
  /** Instanced copies culled on the GPU (`hiz`; null: none). */
  readonly instances: InstanceOcclusionDiagnostics | null;
  /** The culling's own GPU time a frame, recently (its compute passes: the depth pyramid; null: none measured). */
  readonly gpuMs: number | null;
  /** The depth pyramid (`hiz`): its level 0's size, its levels, its GPU memory (with the stand-ins' records) and the frames drawn in two passes; null: none. */
  readonly pyramid: { readonly size: readonly [number, number]; readonly levels: number; readonly bytes: number; readonly frames: number } | null;
  /** The culling's main-thread time in the last frame. */
  readonly ms: number;
  /** Draws kept from culling (`keep`) in the last frame, and the culled draws' boxes drawn (`showCulled`; null: off). */
  readonly kept: number;
  readonly culledBoxes: number | null;
}

export interface OcclusionCullerDeps {
  readonly scene: THREE.Scene;
  /** The setting as the render control resolves it now (project, quality level). */
  readonly setting: () => OcclusionCulling;
  /** The renderer frames are drawn with (null: none yet). */
  readonly renderer: () => OcclusionRenderer;
  /** The page flag's path (null: none). */
  readonly pinned: OcclusionPath | null;
  /** The frame's view (`view-cull.ts`): only its camera draws the stand-ins and has instanced copies culled (absent: none). */
  readonly view?: { is(camera: THREE.Camera): boolean; readonly camera?: THREE.Camera | null };
  /** The WebGPU renderer frames are drawn with (null: none, or WebGL 2): the depth pyramid's. */
  readonly gpu?: () => unknown;
  /** The GPU time of the frame's compute passes, recently (null: not measured). */
  readonly computeMs?: () => number | null;
  /** The pyramid level the page shows over the frame (`?occlusion=pyramid`; absent or null: none). */
  readonly showPyramid?: number | null;
  /** The page's canvas: `data-tl-occlusion` = "<path>|<occludees>|<tested>|<culled>|<stand-ins drawn>" (an export's only diagnostics surface). */
  readonly canvas?: { setAttribute?(k: string, v: string): void } | null;
  /** Something drawn changed (a host drawing on demand draws again). */
  readonly changed?: () => void;
  /** A problem for the game's author (the setting asks for culling the renderer does not have), once. */
  readonly onProblem?: (code: string, message: string) => void;
  /** Where the objects `keep` names are drawn (absent: nothing can be kept). */
  readonly keep?: OcclusionKeepHost;
  /**
   * Whether see-through may thin `standin` in this draw for `camera` (absent: never). Such a stand-in fills no
   * depth: what stays visible through the dither behind it (the subject too) must not be culled.
   */
  readonly fades?: (standin: THREE.Object3D, camera: THREE.Camera) => boolean;
}

export class OcclusionCuller implements OcclusionSwitch {
  readonly registry = new OccludeeRegistry();
  private pinned: OcclusionPath | null;
  /** The path the last frame culled on (what is hidden belongs to it). */
  private applied: OcclusionPath = 'off';
  private choice: { path: OcclusionPath; source: 'page' | 'setting' } = { path: 'off', source: 'setting' };
  private readonly counts = { tested: 0, culled: 0, pass1Culled: 0, pass2Drawn: 0, gpuMs: null as number | null, ms: 0, standins: 0 };
  /** Stand-in draws so far in this frame (the last frame's when `update` starts the next). */
  private standinDraws = 0;
  /** The occludees culled copy by copy (instanced draws, terrain pages' nodes), and those culled whole (null: to be listed). */
  private instancedDraws: THREE.Object3D[] | null = null;
  private wholeDraws: Occludee[] = [];
  private mark = '';
  /** The setting's culling on a renderer without a path was reported. */
  private reportedNoPath = false;
  /** The frame in two passes and its pyramid (`hiz` on WebGPU), and the renderer it was made for. */
  private frame: TwoPassFrame | null = null;
  private frameRenderer: unknown = null;
  private shownLevel: number | null;
  private readonly kept: OcclusionKeep | null;
  private readonly overlay: OcclusionOverlay;
  /** Whether a draw is in the scene now (the registry follows its children once a frame). */
  private readonly inScene = (o: THREE.Object3D): boolean => this.registry.get(o) !== undefined;

  constructor(private readonly deps: OcclusionCullerDeps) {
    this.pinned = deps.pinned;
    this.shownLevel = deps.showPyramid ?? null;
    this.kept = deps.keep !== undefined ? new OcclusionKeep(deps.keep) : null;
    this.overlay = new OcclusionOverlay(deps.scene);
    deps.scene.userData[OCCLUSION_SWITCH_KEY] = this;
    deps.scene.userData[STANDIN_VIEW_KEY] = (camera: THREE.Camera, standin: THREE.Mesh): boolean => this.drawsStandins(camera, standin);
  }

  /**
   * Whether `standin` draws for `camera`: the view's, while the frame culls
   * on a path; on the pyramid path in the first pass only and with the
   * pyramid's material (so never into the scene's depth).
   */
  drawsStandins(camera: THREE.Camera, standin?: THREE.Mesh): boolean {
    if (this.applied === 'off' || this.deps.view?.is(camera) !== true) return false;
    // What it stands in for is hidden from the view (a cut-away, the rooms, isolation): so is it from the depth.
    if (standin !== undefined && !standinFollowsSurfaces(standin, this.inScene)) return false;
    // What it stands in for may be dithered round a see-through subject: the depth must not hold it whole.
    if (standin !== undefined && this.deps.fades?.(standin, camera) === true) return false;
    if (this.applied === 'hiz' && (this.frame === null || this.frame.drawing !== 1 || standin === undefined || standin.material !== this.frame.pyramid.standinMaterial())) return false;
    this.standinDraws += 1;
    return true;
  }

  /**
   * The two-pass frame the environment renderer draws (null: one pass): on
   * the `hiz` path with a WebGPU renderer. Made for the renderer the frames
   * are drawn with; a new renderer gets a new one.
   */
  scenePasses(): ScenePasses | null {
    if (this.applied !== 'hiz') return null;
    const gpu = this.deps.gpu?.() ?? null;
    if (gpu === null) return null;
    if (this.frame !== null && this.frameRenderer !== gpu) this.dropFrame();
    if (this.frame === null) {
      this.frame = new TwoPassFrame(gpu as ConstructorParameters<typeof TwoPassFrame>[0], this.registry);
      this.frame.shown = this.shownLevel;
      this.frameRenderer = gpu;
    }
    return this.frame;
  }

  /** Whether frames must draw through the environment renderer's scene pass (the two-pass frame's). */
  needsEnvironment(): boolean {
    return this.choose().path === 'hiz' && (this.deps.gpu?.() ?? null) !== null;
  }

  showPyramid(level: number | null): void {
    this.shownLevel = level === null ? null : Math.max(0, Math.floor(level));
    if (this.frame !== null) this.frame.shown = this.shownLevel;
    this.deps.changed?.();
  }

  readPyramid(): Promise<PyramidReadback | null> {
    return this.frame?.pyramid.read() ?? Promise.resolve(null);
  }

  showCulled(on: boolean): void {
    this.overlay.set(on);
    this.deps.changed?.();
  }

  keep(entityIds: ReadonlySet<string>): void {
    this.kept?.set(entityIds);
  }

  path(): OcclusionPath {
    return this.choose().path;
  }

  pin(path: OcclusionPath | null): void {
    this.pinned = path;
    if (this.choose().path !== this.applied) this.reset();
    this.deps.changed?.();
  }

  /**
   * Once a frame, after the frustum, the rooms and isolation: the path is chosen and the occludees follow the
   * scene. On `hiz` the instanced draws' copies in view are listed for the GPU's tests (occlusion-instances.ts);
   * other draws are not tested yet.
   */
  update(): void {
    const t0 = performance.now();
    const { path } = this.choose();
    if (path !== this.applied) this.reset();
    // What a host works on is marked first: no path tests it.
    this.kept?.update(path !== 'off');
    if (path === 'off') {
      if (this.registry.size > 0) this.registry.clear();
      this.instancedDraws = null;
      this.wholeDraws = [];
    } else if (this.registry.sync(this.deps.scene.children) || this.instancedDraws === null) {
      // The instanced draws the GPU may cull, listed again only when the scene's draws changed.
      this.instancedDraws = [];
      this.wholeDraws = [];
      for (const o of this.registry.values()) {
        if (o.kind === 'instanced' || o.kind === 'terrain') this.instancedDraws.push(o.object);
        else if (culledWhole(o.kind)) this.wholeDraws.push(o);
      }
    }
    if (path === 'hiz') this.dressStandins();
    const instances = path === 'hiz' ? (this.frame?.instances ?? null) : null;
    if (instances !== null) {
      instances.attach(this.deps.scene);
      const camera = this.deps.view?.camera ?? null;
      instances.update(this.instancedDraws ?? [], camera, this.frame!.wholes.update(this.wholeDraws, camera, (o) => o.role !== 'none'));
      const d = instances.diagnostics();
      const w = d.whole;
      this.counts.tested = d.tested + w.tested;
      this.counts.culled = Math.max(0, d.tested - d.drawn1 - d.drawn2) + w.culled;
      this.counts.pass1Culled = d.pass1Left + w.second;
      this.counts.pass2Drawn = d.drawn2 + w.second - w.culled;
    } else {
      this.counts.tested = 0;
      this.counts.culled = 0;
      this.counts.pass1Culled = 0;
      this.counts.pass2Drawn = 0;
    }
    if (this.overlay.on) this.overlay.update(this.culledBoxes(path));
    this.counts.standins = this.standinDraws;
    this.standinDraws = 0;
    this.counts.ms = performance.now() - t0;
    this.writeMark();
  }

  diagnostics(): OcclusionDiagnostics {
    const c = this.choose();
    const p = this.frame?.pyramid.layout() ?? null;
    const pyramid = p === null || this.frame === null ? null : { size: [p.levels[0]!.width, p.levels[0]!.height] as const, levels: p.levels.length, bytes: this.frame.pyramid.bytes(), frames: this.frame.frames };
    const gpuMs = this.applied === 'hiz' ? (this.deps.computeMs?.() ?? null) : null;
    const instances = this.applied === 'hiz' ? (this.frame?.instances.diagnostics() ?? null) : null;
    return { setting: this.deps.setting(), path: c.path, source: c.source, pinned: this.pinned, occludees: this.registry.size, byKind: this.registry.counts(), byRole: this.registry.roleCounts(), standins: this.counts.standins, tested: this.counts.tested, culled: this.counts.culled, pass1Culled: this.counts.pass1Culled, pass2Drawn: this.counts.pass2Drawn, instances, gpuMs: gpuMs === null ? null : Math.round(gpuMs * 1000) / 1000, pyramid, ms: Math.round(this.counts.ms * 1000) / 1000, kept: this.kept?.size ?? 0, culledBoxes: this.overlay.on ? this.overlay.boxes : null };
  }

  /** The world boxes of the draws the path culls whole now. */
  private culledBoxes(path: OcclusionPath): THREE.Box3[] {
    const hidden = path === 'hiz' ? (this.frame?.wholes.hidden() ?? null) : null;
    const out: THREE.Box3[] = [];
    if (hidden === null) return out;
    for (const mesh of hidden) {
      const o = this.registry.get(mesh);
      if (o !== undefined) out.push(occludeeWorldBounds(o, new THREE.Box3()));
    }
    return out;
  }

  /** Everything hidden is shown and the switch leaves the scene. */
  dispose(): void {
    this.kept?.dispose();
    this.overlay.dispose();
    this.reset();
    this.dropFrame();
    this.registry.clear();
    if (this.deps.scene.userData[OCCLUSION_SWITCH_KEY] === this) {
      delete this.deps.scene.userData[OCCLUSION_SWITCH_KEY];
      delete this.deps.scene.userData[STANDIN_VIEW_KEY];
    }
  }

  private choose(): { path: OcclusionPath; source: 'page' | 'setting' } {
    const setting = this.deps.setting();
    const renderer = this.deps.renderer();
    const next = occlusionPathOf(setting, renderer, this.pinned);
    // WebGL 2 has no culling path (its occlusion queries answered frames late and saved too little): `on` draws
    // everything there, and the author hears it once rather than measuring a path that is not taken.
    if (setting === 'on' && renderer === 'webgl2' && !this.reportedNoPath) {
      this.reportedNoPath = true;
      this.deps.onProblem?.(OCCLUSION_NO_PATH_PROBLEM, 'occlusion_culling is on, but only WebGPU culls (its depth pyramid): on WebGL 2 everything in view is drawn.');
    }
    if (next.path !== this.choice.path || next.source !== this.choice.source) this.choice = { path: next.path, source: next.source };
    return this.choice;
  }

  /** Show what the last path hid (shadow cameras never lost it); the next frame starts the new path from nothing hidden. */
  private reset(): void {
    let shown = false;
    for (const o of this.deps.scene.children) if (hideFromView(o, HIDDEN_BY_OCCLUSION, false)) shown = true;
    // Off the pyramid path the stand-ins draw not at all, and the instanced draws draw every copy in view with the
    // programs they had.
    // Off the pyramid path its pyramid, pools and kernels are let go too (megabytes at 1080p; made again if it comes back).
    if (this.applied === 'hiz' && this.choice.path !== 'hiz') {
      this.frame?.wholes.clear();
      this.frame?.instances.clear();
      this.dropFrame();
    }
    this.applied = this.choice.path;
    if (shown) this.deps.changed?.();
  }

  /** On the pyramid path the stand-ins wear its material (made once the pyramid knows its size; made again when it grows). */
  private dressStandins(): void {
    if (this.frame === null) return;
    let material: THREE.Material | null = null;
    for (const o of this.deps.scene.children) {
      if (!isOccluderStandin(o)) continue;
      // Asked only once a stand-in is there: a scene without one holds no stand-in records.
      material ??= this.frame.pyramid.standinMaterial();
      if (material === null) return;
      if ((o as THREE.Mesh).material !== material) (o as THREE.Mesh).material = material;
    }
  }

  private undressStandins(): void {
    const depthOnly = standinMaterialOf();
    for (const o of this.deps.scene.children) if (isOccluderStandin(o) && (o as THREE.Mesh).material !== depthOnly) (o as THREE.Mesh).material = depthOnly;
  }

  private dropFrame(): void {
    if (this.frame === null) return;
    this.undressStandins();
    this.frame.instances.detach(this.deps.scene);
    this.frame.dispose();
    this.frame = null;
    this.frameRenderer = null;
  }

  private writeMark(): void {
    const m = `${this.choice.path}|${this.registry.size}|${this.counts.tested}|${this.counts.culled}|${this.counts.standins}`;
    if (m === this.mark || typeof this.deps.canvas?.setAttribute !== 'function') return;
    this.mark = m;
    this.deps.canvas.setAttribute('data-tl-occlusion', m);
  }
}
