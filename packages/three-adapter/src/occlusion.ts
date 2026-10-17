/**
 * Occlusion culling in the adapter: which path a frame culls on, the draws
 * it may leave out (occludees.ts), what it left out, and the switch a page,
 * the perf harness and the occlusion oracle read.
 *
 * The path comes from the project's `occlusion_culling` (or its quality
 * level's, through the render control) and the renderer: auto culls with a
 * depth pyramid on WebGPU (`hiz`) and occlusion queries on WebGL 2
 * (`queries`); the runtime's `occlusionPathOf` decides. The page flag
 * `?occlusion=off|queries|hiz` pins one for a comparison (the perf harness's
 * `--switches occlusion=off`), as does the scene's switch at run time.
 *
 * A draw left out is hidden from the view for `HIDDEN_BY_OCCLUSION`
 * (view-hidden.ts): the shadow cameras and probe bakes still draw it, as a
 * caster hidden from the view still casts into it. Whatever the culler hid
 * comes back when its path changes or it is disposed.
 *
 * Runs once a frame after the frustum, the rooms and an edit mode's isolation
 * have had their say (what they hide is not tested again). Kept out of
 * `adapter.ts`, which gives it the scene, the setting and the renderer and
 * reads its diagnostics.
 */
import type * as THREE from 'three';
import { occlusionPathFrom, occlusionPathOf, type OccludeeKind, type OcclusionCulling, type OcclusionPath, type OcclusionRenderer } from '@thirdlight/runtime';

import { OccludeeRegistry } from './occludees';
import { HIDDEN_BY_OCCLUSION, hideFromView } from './view-hidden';

/** The page flag that pins a path (`?occlusion=off|queries|hiz`; a diagnostic comparison). */
export const OCCLUSION_URL_PARAM = 'occlusion';

/** The path a page's query string pins (null: none, or not a path). */
export function occlusionFromUrl(search: string): OcclusionPath | null {
  return occlusionPathFrom(new URLSearchParams(search).get(OCCLUSION_URL_PARAM));
}

/** `scene.userData[OCCLUSION_SWITCH_KEY]`: the scene's {@link OcclusionSwitch}. */
export const OCCLUSION_SWITCH_KEY = 'tlOcclusion';

/** What a page tool reads and pins of occlusion culling (the perf harness, the occlusion oracle, a test). */
export interface OcclusionSwitch {
  /** The path frames cull on now. */
  path(): OcclusionPath;
  /** Pin a path from now on (null: the setting's again); what was hidden for the old path is shown at once. */
  pin(path: OcclusionPath | null): void;
  diagnostics(): OcclusionDiagnostics;
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
  /** Draws tested and left out in the last frame. */
  readonly tested: number;
  readonly culled: number;
  /** On the two-pass path: draws left out of the first pass by last frame's answer, and of those, drawn in the second. */
  readonly pass1Culled: number;
  readonly pass2Drawn: number;
  /** The culling's own GPU time in the last frame (null: none measured). */
  readonly gpuMs: number | null;
  /** The culling's main-thread time in the last frame. */
  readonly ms: number;
}

export interface OcclusionCullerDeps {
  readonly scene: THREE.Scene;
  /** The setting as the render control resolves it now (project, quality level). */
  readonly setting: () => OcclusionCulling;
  /** The renderer frames are drawn with (null: none yet). */
  readonly renderer: () => OcclusionRenderer;
  /** The page flag's path (null: none). */
  readonly pinned: OcclusionPath | null;
  /** The page's canvas: `data-tl-occlusion` = "<path>|<occludees>|<tested>|<culled>" (an export's only diagnostics surface). */
  readonly canvas?: { setAttribute?(k: string, v: string): void } | null;
  /** Something drawn changed (a host drawing on demand draws again). */
  readonly changed?: () => void;
}

export class OcclusionCuller implements OcclusionSwitch {
  readonly registry = new OccludeeRegistry();
  private pinned: OcclusionPath | null;
  /** The path the last frame culled on (what is hidden belongs to it). */
  private applied: OcclusionPath = 'off';
  private choice: { path: OcclusionPath; source: 'page' | 'setting' } = { path: 'off', source: 'setting' };
  private readonly counts = { tested: 0, culled: 0, pass1Culled: 0, pass2Drawn: 0, gpuMs: null as number | null, ms: 0 };
  private mark = '';

  constructor(private readonly deps: OcclusionCullerDeps) {
    this.pinned = deps.pinned;
    deps.scene.userData[OCCLUSION_SWITCH_KEY] = this;
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
   * scene. No path tests anything yet: every draw in view is drawn.
   */
  update(): void {
    const t0 = performance.now();
    const { path } = this.choose();
    if (path !== this.applied) this.reset();
    if (path === 'off') {
      if (this.registry.size > 0) this.registry.clear();
    } else this.registry.sync(this.deps.scene.children);
    this.counts.tested = 0;
    this.counts.culled = 0;
    this.counts.pass1Culled = 0;
    this.counts.pass2Drawn = 0;
    this.counts.ms = performance.now() - t0;
    this.writeMark();
  }

  diagnostics(): OcclusionDiagnostics {
    const c = this.choose();
    return { setting: this.deps.setting(), path: c.path, source: c.source, pinned: this.pinned, occludees: this.registry.size, byKind: this.registry.counts(), tested: this.counts.tested, culled: this.counts.culled, pass1Culled: this.counts.pass1Culled, pass2Drawn: this.counts.pass2Drawn, gpuMs: this.counts.gpuMs, ms: Math.round(this.counts.ms * 1000) / 1000 };
  }

  /** Everything hidden is shown and the switch leaves the scene. */
  dispose(): void {
    this.reset();
    this.registry.clear();
    if (this.deps.scene.userData[OCCLUSION_SWITCH_KEY] === this) delete this.deps.scene.userData[OCCLUSION_SWITCH_KEY];
  }

  private choose(): { path: OcclusionPath; source: 'page' | 'setting' } {
    const next = occlusionPathOf(this.deps.setting(), this.deps.renderer(), this.pinned);
    if (next.path !== this.choice.path || next.source !== this.choice.source) this.choice = { path: next.path, source: next.source };
    return this.choice;
  }

  /** Show what the last path hid (shadow cameras never lost it); the next frame starts the new path from nothing hidden. */
  private reset(): void {
    let shown = false;
    for (const o of this.deps.scene.children) if (hideFromView(o, HIDDEN_BY_OCCLUSION, false)) shown = true;
    this.applied = this.choice.path;
    if (shown) this.deps.changed?.();
  }

  private writeMark(): void {
    const m = `${this.choice.path}|${this.registry.size}|${this.counts.tested}|${this.counts.culled}`;
    if (m === this.mark || typeof this.deps.canvas?.setAttribute !== 'function') return;
    this.mark = m;
    this.deps.canvas.setAttribute('data-tl-occlusion', m);
  }
}
