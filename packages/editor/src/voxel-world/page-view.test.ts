/**
 * The voxel world page's far field switches: the quality level's mode by
 * default (bricks on every tier), the mesh fallback and half resolution
 * still switchable, and the brick switches retired with the variants they
 * chose (one build, shading and march) refused clearly: the URL's ignored
 * with a warning, the hook's an error, nothing applied.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageFar, pageFarHooks, pageLevel, reliefParams } from './page-view';

const level = pageLevel('medium', reliefParams(new URLSearchParams()));

/** A far view and a far field recording what the hooks ask of them. */
function targets() {
  const calls: string[] = [];
  const view = { setBrickHalf: (on: boolean) => void calls.push(`half ${on}`), setVisible: (on: boolean) => void calls.push(`visible ${on}`) };
  const far = { setView: (o: object) => void calls.push(`view ${JSON.stringify(o)}`), settle: async () => undefined };
  return { calls, view, streamer: { far } };
}

describe('the page far field switches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws bricks by default, keeps the mesh fallback and the half-resolution march as switches', () => {
    expect(level.far.mode).toBe('bricks');
    expect(pageFar(new URLSearchParams(), level)).toEqual({ enabled: true, draw: 'bricks', errorPixels: 4, pinned: false, half: false });
    expect(pageFar(new URLSearchParams('farField=mesh&farRes=half'), level)).toEqual({ enabled: true, draw: 'mesh', errorPixels: 4, pinned: true, half: true });
    const t = targets();
    const hooks = pageFarHooks(t.streamer as never, t.view as never);
    hooks.setFar({ mode: 'mesh', res: 'half', errorPixels: 6 });
    expect(t.calls).toEqual(['half false', 'half true', 'view {"errorPixels":6,"enabled":true,"draw":"mesh"}']);
  });

  it('refuses the retired brick switches: the URL warns and ignores them, the hook throws and applies nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(pageFar(new URLSearchParams('farBricks=occupancy&farShade=fine&farMarch=raster'), level)).toEqual(pageFar(new URLSearchParams(), level));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/\?farBricks, \?farShade, \?farMarch ignored: the far bricks have one build/);
    const t = targets();
    const hooks = pageFarHooks(t.streamer as never, t.view as never);
    for (const o of [{ bricks: 'faces2' }, { shade: 'fine' }, { march: 'raster', mode: 'bricks' }]) expect(() => hooks.setFar(o as never)).toThrow(/retired: the far bricks have one build/);
    expect(t.calls).toEqual(['half false']);
  });
});
