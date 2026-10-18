/**
 * The Scene view's occlusion switches onto the adapter's culler: "on" culls
 * as Play does (the project's setting, or the page's `?occlusion=` pin),
 * "off" pins culling off; the culled boxes and the pyramid only while it
 * culls; what is kept is sent when it changes, and again to a new adapter.
 */
import { describe, expect, it } from 'vitest';

import type { SceneAdapter } from '@thirdlight/three-adapter';

import { OCCLUSION_VIEW_DEFAULT, SceneViewOcclusion } from './occlusion-view';

function fakeAdapter() {
  const calls: string[] = [];
  const sw = {
    pin: (p: string | null) => void calls.push(`pin ${p}`),
    showCulled: (on: boolean) => void calls.push(`boxes ${on}`),
    showPyramid: (l: number | null) => void calls.push(`pyramid ${l}`),
    keep: (ids: ReadonlySet<string>) => void calls.push(`keep ${[...ids].join(',')}`),
    diagnostics: () => ({ path: 'hiz', kept: 2, tested: 5, culled: 3, culledBoxes: 1, instances: null }),
  };
  return { calls, adapter: { occlusion: () => sw } as unknown as SceneAdapter };
}

describe('the Scene view occlusion switches', () => {
  it('culls as Play does when on, pins it off when off, and shows its overlays only while culling', () => {
    const { calls, adapter } = fakeAdapter();
    const canvas = { attrs: new Map<string, string>(), setAttribute(k: string, v: string) { this.attrs.set(k, v); } };
    const view = new SceneViewOcclusion(() => adapter, () => canvas as unknown as HTMLElement, null);
    expect(view.set(OCCLUSION_VIEW_DEFAULT)).toBe(false);
    expect(view.set({ culling: true, culled: true, pyramid: false })).toBe(true);
    expect(calls.splice(0)).toEqual(['pin null', 'boxes true', 'pyramid null']);
    expect(view.animating).toBe(true);
    // Off: nothing culled, no boxes, no pyramid (whatever the menu's other switches say).
    view.set({ culling: false, culled: true, pyramid: true });
    expect(calls.splice(0)).toEqual(['pin off', 'boxes false', 'pyramid null']);
    expect(view.animating).toBe(false);
    view.afterFrame();
    expect(JSON.parse(canvas.attrs.get('data-occlusion-view')!)).toMatchObject({ view: { culling: false }, path: 'hiz', kept: 2, culled: 3, boxes: 1 });
  });

  it('keeps drawing while the queries path hides something (its answers come frames later)', () => {
    const { adapter } = fakeAdapter();
    const sw = (adapter.occlusion as () => { diagnostics: () => unknown })();
    let hidden = 2;
    sw.diagnostics = () => ({ path: 'queries', kept: 0, tested: 4, culled: hidden, culledBoxes: null, instances: null, queries: { candidates: 4, hidden, asked: 4, answered: 4, lost: 0, cuts: 0 } });
    const view = new SceneViewOcclusion(() => adapter, () => ({ setAttribute() {} }) as unknown as HTMLElement, null);
    view.afterFrame();
    expect(view.animating).toBe(true);
    hidden = 0;
    view.afterFrame();
    expect(view.animating).toBe(false);
  });

  it("pins the page flag's path when on", () => {
    const { calls, adapter } = fakeAdapter();
    const view = new SceneViewOcclusion(() => adapter, () => ({ setAttribute() {} }) as unknown as HTMLElement, 'queries');
    view.set({ culling: true, culled: false, pyramid: true });
    expect(calls).toEqual(['pin queries', 'boxes false', 'pyramid 0']);
  });

  it('sends what is kept when it changes, and again after the adapter was made again', () => {
    const { calls, adapter } = fakeAdapter();
    const view = new SceneViewOcclusion(() => adapter, () => ({ setAttribute() {} }) as unknown as HTMLElement, null);
    view.keep(new Set(['a', 'b']));
    view.keep(new Set(['b', 'a']));
    expect(calls.splice(0)).toEqual(['keep a,b']);
    view.apply();
    calls.splice(0);
    view.keep(new Set(['b', 'a']));
    expect(calls).toEqual(['keep b,a']);
  });
});
