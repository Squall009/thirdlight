/**
 * The Scene view's lighting preview and debug views: the same lighting Play
 * draws (the scene adapter's live light or saved light), with what the
 * editor adds to it:
 *
 * - the View menu's debug views: the surface cache's lit texels, the probes,
 *   the rooms and portals, the stale pages, the light clusters' heat map
 *   (the adapter's own views, as the page flags `?surfaceCacheView=1`,
 *   `?probesView=1` and `?clusterView=1` draw them);
 * - the pass-time overlay: what each lighting pass costs now, read from the
 *   adapter's lighting report (the cache's re-lighting, the probes' update,
 *   the reflections' traced rays, whether TAAU draws, settled);
 * - the Lighting window's preview: the quality level the view draws at (null:
 *   the project's, else the device's, as Play picks it), and live lighting
 *   held to the saved light. Nothing of it is saved: the level's settings
 *   are the project's (the Lighting window edits them through
 *   `setEnvironment`).
 *
 * Browser-only (the scene adapter).
 */
import { LIGHTING_VIEW_OFF, type LightingReport, type LightingViewState, type SceneAdapter } from '@thirdlight/three-adapter';

/** What the View menu and the Lighting window set. */
export interface SceneLightingState extends LightingViewState {
  /** The pass-time overlay over the view. */
  readonly passes: boolean;
  /** The quality level previewed (null: the one Play would draw here). */
  readonly level: string | null;
  /** The light runs live where the level lets it (false: the saved light only). */
  readonly live: boolean;
}

export const SCENE_LIGHTING_DEFAULT: SceneLightingState = Object.freeze({ ...LIGHTING_VIEW_OFF, passes: false, level: null, live: true });

/** Shortest time (ms) between two readings of the report while nothing but its numbers changed. */
const REPORT_MS = 250;

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(2)} ms`);

/** The overlay's lines for a report. */
export function lightingPassLines(r: LightingReport): string[] {
  const why = r.off === 'no-budget' ? 'saved light: the level gives live light no time' : r.off === 'no-webgpu' ? 'saved light: WebGL 2' : r.off === 'failed' ? 'saved light: the live light could not start' : r.off === 'starting' ? 'starting' : 'saved light';
  return [
    `Lighting: ${r.tier} tier (level ${r.level}) · ${r.live ? 'live' : why}`,
    r.relight !== null ? `Relight ${ms(r.relight.msUsed)} of ${ms(r.relight.budgetMs)} · ${r.relight.stalePages} stale pages` : 'Relight: not live',
    r.probes !== null ? `Probes ${ms(r.probes.msUsed)} · ${r.probes.stale} of ${r.probes.count} stale` : 'Probes: not live',
    r.reflections !== null ? `Reflections (traced) ${ms(r.reflections.ms)} · ${r.reflections.rays} rays` : 'Reflections: none traced',
    r.taau ? 'TAAU: drawn' : 'TAAU: not drawn here (the Scene view draws SMAA)',
    r.settled ? 'Settled' : 'Settling…',
  ];
}

export class SceneViewLighting {
  private state: SceneLightingState = SCENE_LIGHTING_DEFAULT;
  private last: LightingReport | null = null;
  private readAt = -Infinity;
  private mark = '';
  private key = '';
  /** A reading skipped by the throttle: one more frame is asked for. */
  private pending = false;
  private overlay: HTMLDivElement | null = null;

  constructor(
    private readonly adapter: () => SceneAdapter,
    private readonly canvas: () => HTMLCanvasElement,
    /** The view draws again (a switch changed). */
    private readonly changed: () => void,
  ) {}

  get value(): SceneLightingState {
    return this.state;
  }

  /** The View menu's and the Lighting window's switches; true when they changed. */
  set(state: SceneLightingState): boolean {
    const s = this.state;
    if (s.cache === state.cache && s.probes === state.probes && s.rooms === state.rooms && s.stale === state.stale && s.clusters === state.clusters && s.passes === state.passes && s.level === state.level && s.live === state.live) return false;
    this.state = { ...state };
    this.apply();
    this.changed();
    return true;
  }

  /** The switches onto the adapter (again for a new adapter: a renderer switch). */
  apply(): void {
    const a = this.adapter();
    const s = this.state;
    a.setLightingView?.({ cache: s.cache, probes: s.probes, rooms: s.rooms, stale: s.stale, clusters: s.clusters === true });
    a.setLiveLighting?.(s.live);
    // A level the project no longer has falls back to the one Play would draw.
    if (a.setQuality?.(s.level) === false) a.setQuality(null);
    // Read and drawn again at the next frame (the overlay may have been switched on with nothing else changed).
    this.readAt = -Infinity;
    this.key = '';
    this.mark = '';
  }

  /** The last report read (null: none yet, or no surface cache). */
  report(): LightingReport | null {
    return this.last;
  }

  /** Whether the view keeps drawing: a reading the throttle held back. */
  get animating(): boolean {
    return this.pending;
  }

  /** After a drawn frame: the report on the canvas (`data-lighting-view`, tests read it) and in the overlay. */
  afterFrame(now = performance.now()): void {
    const r = this.adapter().lightingReport?.() ?? null;
    // The state, the views and settling at once; the passes' numbers at most every REPORT_MS.
    const key = r === null ? '' : JSON.stringify([r.level, r.tier, r.live, r.off, r.settled, r.view]);
    if (key === this.key && now - this.readAt < REPORT_MS) {
      this.pending = r !== null && JSON.stringify(r) !== this.mark;
      return;
    }
    this.pending = false;
    this.key = key;
    this.readAt = now;
    this.last = r;
    const m = r === null ? '' : JSON.stringify(r);
    if (m === this.mark) return;
    this.mark = m;
    const c = this.canvas();
    if (r === null) c.removeAttribute('data-lighting-view');
    else c.setAttribute('data-lighting-view', m);
    // Probes drawn, and of those the ones inside geometry (moved or filled).
    c.setAttribute('data-probe-spheres', `${r?.view.probeSpheres ?? 0} ${r?.view.invalidProbes ?? 0}`);
    this.drawOverlay(c, r);
  }

  private drawOverlay(c: HTMLCanvasElement, r: LightingReport | null): void {
    if (!this.state.passes || r === null) {
      this.overlay?.remove();
      this.overlay = null;
      return;
    }
    const host = c.parentElement;
    if (host === null) return;
    if (this.overlay === null) {
      this.overlay = document.createElement('div');
      this.overlay.className = 'tl-lighting-passes';
      this.overlay.setAttribute('aria-label', 'lighting pass times');
    }
    // The canvas may be lent to another view or replaced: the overlay goes where it is.
    if (this.overlay.parentElement !== host) host.appendChild(this.overlay);
    this.overlay.textContent = lightingPassLines(r).join('\n');
  }

  dispose(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}
