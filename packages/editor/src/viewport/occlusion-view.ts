/**
 * Occlusion culling in the Scene view: the same culler Play draws with (the
 * scene adapter's, on the project's `occlusion_culling` and the renderer's
 * path), with what the editor adds to it:
 *
 * - the View menu's switches: culling on (as Play culls) or off for this
 *   view, a tinted box round each draw culled now, and the depth pyramid
 *   drawn instead of the picture (WebGPU);
 * - what the user works on is never culled: the selection (with what is
 *   below it) and the objects an edit mode edits, whatever stands in front
 *   of them. The view's own drawing (grid, gizmo, outlines, handles, brush
 *   cursors) is never an occludee at all (`markHostDrawing`).
 *
 * The page flag `?occlusion=off|queries|hiz` pins the path "on" means (a
 * comparison, as in Play); without it "on" is the project's setting.
 *
 * While the culled boxes show, the view keeps drawing: the GPU's answers
 * arrive frames after the draw that asked, and an idle view would keep
 * stale boxes.
 *
 * Browser-only (the scene adapter).
 */
import type { OcclusionDiagnostics, SceneAdapter } from '@thirdlight/three-adapter';

/** What the View menu sets. */
export interface OcclusionViewState {
  /** Culling on, as Play culls (false: the view draws everything in view). */
  readonly culling: boolean;
  /** A tinted box round each draw culled now. */
  readonly culled: boolean;
  /** The depth pyramid drawn instead of the picture (WebGPU's path only). */
  readonly pyramid: boolean;
}

export const OCCLUSION_VIEW_DEFAULT: OcclusionViewState = Object.freeze({ culling: true, culled: false, pyramid: false });

type Path = 'off' | 'queries' | 'hiz';

export class SceneViewOcclusion {
  private state: OcclusionViewState = OCCLUSION_VIEW_DEFAULT;
  private keptKey = '';
  private mark = '';

  constructor(
    private readonly adapter: () => SceneAdapter,
    private readonly canvas: () => HTMLElement,
    /** The page flag's path (null: none). */
    private readonly pinned: Path | null,
  ) {}

  /** The View menu's switches; true when they changed. */
  set(state: OcclusionViewState): boolean {
    if (state.culling === this.state.culling && state.culled === this.state.culled && state.pyramid === this.state.pyramid) return false;
    this.state = { ...state };
    this.apply();
    return true;
  }

  /** The switches onto the adapter's culler (again for a new adapter: a renderer switch). */
  apply(): void {
    const sw = this.adapter().occlusion?.();
    if (sw === undefined) return;
    this.keptKey = '';
    sw.pin(this.state.culling ? this.pinned : 'off');
    sw.showCulled(this.state.culling && this.state.culled);
    sw.showPyramid(this.state.culling && this.state.pyramid ? 0 : null);
  }

  /** Never cull these objects (the selection's subtree, an edit mode's objects). */
  keep(ids: ReadonlySet<string>): void {
    const key = [...ids].sort().join('\u0000');
    if (key === this.keptKey) return;
    const sw = this.adapter().occlusion?.();
    if (sw === undefined) return;
    this.keptKey = key;
    sw.keep(ids);
  }

  /** Whether the view keeps drawing (the culled boxes follow the GPU's answers). */
  get animating(): boolean {
    return this.state.culling && this.state.culled;
  }

  /** After a frame: the switches and what the culler did, on the canvas (`data-occlusion-view`; tests read it). */
  afterFrame(): void {
    const d: OcclusionDiagnostics | undefined = this.adapter().occlusion?.().diagnostics();
    const m = JSON.stringify({ view: this.state, path: d?.path ?? 'off', kept: d?.kept ?? 0, tested: d?.tested ?? 0, culled: d?.culled ?? 0, boxes: d?.culledBoxes ?? null, whole: d?.instances?.whole ?? null, terrain: d?.instances?.terrain ?? null, queries: d?.queries === null || d?.queries === undefined ? null : { candidates: d.queries.candidates, hidden: d.queries.hidden, asked: d.queries.asked, answered: d.queries.answered, lost: d.queries.lost, cuts: d.queries.cuts } });
    if (m === this.mark) return;
    this.mark = m;
    this.canvas().setAttribute('data-occlusion-view', m);
  }
}
