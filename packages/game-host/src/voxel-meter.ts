/**
 * The GPU headroom meter's knobs on a game page with voxel worlds
 * (`__tlVoxelPlay.meter`): a measuring run (`tools/voxel-bench`, the
 * `headroom` bench) loads the GPU through the scene adapter's load
 * (three-adapter gpu-headroom.ts) until the frames at the display's cap start
 * to miss, and hides the near or far field for a picture without it. The
 * GPU time per pass category is the page's GPU measurement (gpu-measure.ts),
 * not this.
 *
 * Each `set` replaces the whole setting: what it leaves out goes back to the
 * page's own (no ballast, no copies, everything shown, the post stack drawn).
 * The render scale and dynamic resolution are the player's layer of the
 * render settings: a run pins them (dynamic resolution would hide the load
 * by drawing smaller), and they stay pinned until set again.
 */

/** What of the voxel worlds' draws the meter drives (three-adapter's VoxelWorldDraws, its roots three objects; this module stays free of three). */
interface MeterDraws<R> {
  showNear(on: boolean): void;
  showFar(on: boolean): void;
  roots(): { readonly near: readonly R[]; readonly far: readonly R[] };
}

/** What of the scene adapter the meter drives (its GPU load and the player's render settings). */
interface MeterAdapter<R> {
  gpuLoad?(): { set(s: { ballast: number; copies: number; copyOf: () => readonly R[] }): void; state(): object; record(seconds: number, clock?: 'presented' | 'gpu'): Promise<number[]> };
  setRenderSettings?(settings: { renderScale?: number; dynamicResolution?: boolean }, layer?: 'project' | 'player'): void;
}

/** A voxel world's passes a run can draw again or hide. */
export type VoxelMeterPass = 'near' | 'far';

export interface VoxelMeterSettings {
  /** Ballast copies a frame (the meter's unit of load). */
  readonly ballast?: number;
  /** Extra draws a frame of one pass's drawables. */
  readonly copies?: number;
  readonly copy?: VoxelMeterPass;
  readonly hide?: { readonly near?: boolean; readonly far?: boolean };
  /** The render scale (0.5–1) the player's layer pins, with dynamic resolution as given (default off). */
  readonly renderScale?: number;
  readonly dynamicResolution?: boolean;
}

export interface VoxelMeter {
  set(s: VoxelMeterSettings): boolean;
  /** The load's state (three-adapter's GpuLoadState) with the settings given; null without a load. */
  state(): (object & { readonly settings: VoxelMeterSettings }) | null;
  /** The intervals (ms) between the frames the page presents (`clock` 'gpu': the GPU finished) over the next `seconds` (a capped page skips animation frames); empty without a load. */
  record(seconds: number, clock?: 'presented' | 'gpu'): Promise<number[]>;
}

export function voxelMeter<R>(draws: MeterDraws<R>, adapter: () => MeterAdapter<R> | null): VoxelMeter {
  let settings: VoxelMeterSettings = {};
  return {
    set(s) {
      const a = adapter();
      const load = a?.gpuLoad?.() ?? null;
      if (a === null || load === null) return false;
      settings = s;
      draws.showNear(s.hide?.near !== true);
      draws.showFar(s.hide?.far !== true);
      load.set({
        ballast: s.ballast ?? 0,
        copies: s.copy === undefined ? 0 : (s.copies ?? 0),
        copyOf: s.copy === 'far' ? () => draws.roots().far : () => draws.roots().near,
      });
      if (s.renderScale !== undefined || s.dynamicResolution !== undefined) a.setRenderSettings?.({ ...(s.renderScale !== undefined ? { renderScale: s.renderScale } : {}), dynamicResolution: s.dynamicResolution === true }, 'player');
      return true;
    },
    state() {
      const load = adapter()?.gpuLoad?.() ?? null;
      return load === null ? null : { ...load.state(), settings };
    },
    record(seconds, clock) {
      return adapter()?.gpuLoad?.()?.record(seconds, clock) ?? Promise.resolve([]);
    },
  };
}
