/**
 * What the page's GPU measurement (game-host gpu-measure.ts) drives on a
 * scene adapter: the GPU load's ballast and its GPU-clock frame times
 * (gpu-headroom.ts), the passes' hides by category (gpu-pass-hides.ts) and
 * the render control's hold on the scale (dynamic resolution would draw
 * smaller under the load). Only on WebGPU: the frame times are the GPU's own
 * completions, which WebGL 2 does not give.
 */
import type { GpuPassCategory } from '@thirdlight/project-model';

import { BALLAST_MAX, gpuDone, type GpuLoad } from './gpu-headroom';
import type { GpuPassHides } from './gpu-pass-hides';
import type { RenderControl } from './render-control';

export interface GpuMeasureTargetLike {
  unavailable(): string | null;
  present(): Partial<Record<GpuPassCategory, readonly string[]>>;
  hide(categories: readonly GpuPassCategory[]): void;
  ballast(n: number): void;
  readonly ballastMax: number;
  record(seconds: number): Promise<number[]>;
  hold(on: boolean): void;
}

export function gpuMeasureTarget(load: GpuLoad, hides: GpuPassHides, control: RenderControl, renderer: () => unknown, starting: () => boolean): GpuMeasureTargetLike {
  return {
    unavailable: () => (starting() ? 'the renderer is still starting' : gpuDone(renderer()) === null ? 'needs WebGPU (the GPU\'s own frame completions); this page draws with WebGL 2' : null),
    present: () => hides.present(),
    hide: (categories) => hides.set(categories),
    ballast: (n) => load.setBallast(n),
    ballastMax: BALLAST_MAX,
    record: (seconds) => load.record(seconds, 'gpu'),
    hold: (on) => {
      if (!on) {
        control.hold(null);
        return;
      }
      // The scale held where the layers put it (the most dynamic resolution draws at), drawn whole each frame.
      control.hold({ renderScale: control.diagnostics().renderScale, dynamicResolution: false });
    },
  };
}
