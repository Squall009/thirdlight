/**
 * The voxel world page's far field switches: the quality level's mode by
 * default (bricks on every tier), the mesh fallback and half resolution
 * still switchable, and the brick switches retired with the variants they
 * chose (one build, shading and march) refused clearly: the URL's ignored
 * with a warning, the hook's an error, nothing applied; fine far bricks
 * on from the URL or the hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageFar, pageFarHooks, pageLevel, reliefParams } from './page-view';

const level = pageLevel('medium', reliefParams(new URLSearchParams()));

/** A far view and a far field recording what the hooks ask of them. */
function targets() {
  const calls: string[] = [];
  const view = { setVisible: (on: boolean) => void calls.push(`visible ${on}`) };
  const fine = { wanted: false };
  const far = { setView: (o: { fine?: boolean }) => {
    calls.push(`view ${JSON.stringify(o)}`);
    if (o.fine !== undefined) fine.wanted = o.fine;
  }, settle: async () => undefined, fineNodes: fine, draw: 'bricks', cache: { source: {} } };
  const mips = { lod: { setNearOnly: (on: boolean) => void calls.push(`near only ${on}`) }, setDormant: (on: boolean) => void calls.push(`mips dormant ${on}`) };
  return { calls, view, streamer: { far, mips, detail: { setReach: () => undefined }, readReach: { setBaked: (l: number | null) => void calls.push(`read baked ${l}`) } } };
}

describe('the page far field switches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws bricks by default and keeps the mesh fallback as a switch', () => {
    expect(level.far.mode).toBe('bricks');
    expect(pageFar(new URLSearchParams(), level)).toEqual({ enabled: true, draw: 'bricks', errorPixels: 4, pinned: false, fine: false });
    expect(pageFar(new URLSearchParams('farField=mesh'), level)).toEqual({ enabled: true, draw: 'mesh', errorPixels: 4, pinned: true, fine: false });
    const t = targets();
    const hooks = pageFarHooks(t.streamer as never, t.view as never);
    hooks.setFar({ mode: 'mesh', errorPixels: 6 });
    expect(t.calls).toEqual(['view {"errorPixels":6,"enabled":true,"draw":"mesh"}']);
  });

  it('turns fine far bricks on from the URL and the hook, and the near field gives its levels 1 and 2 up with them', () => {
    expect(pageFar(new URLSearchParams('fineBricks=1'), level).fine).toBe(true);
    const t = targets();
    pageFarHooks(t.streamer as never, t.view as never).setFar({ fine: true });
    // No fine level baked in this far cache: the read ring stays as set.
    expect(t.calls).toEqual(['view {"fine":true}', 'near only true', 'mips dormant true', 'read baked null']);
    t.calls.length = 0;
    pageFarHooks(t.streamer as never, t.view as never).setFar({ fine: false });
    expect(t.calls).toEqual(['view {"fine":false}', 'near only false', 'mips dormant false', 'read baked null']);
  });

  it('refuses the retired brick switches: the URL warns and ignores them, the hook throws and applies nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(pageFar(new URLSearchParams('farBricks=occupancy&farShade=fine&farMarch=raster&farRes=half'), level)).toEqual(pageFar(new URLSearchParams(), level));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/\?farBricks, \?farShade, \?farMarch, \?farRes ignored: the far bricks have one build/);
    const t = targets();
    const hooks = pageFarHooks(t.streamer as never, t.view as never);
    for (const o of [{ bricks: 'faces2' }, { shade: 'fine' }, { march: 'raster', mode: 'bricks' }, { res: 'half' }]) expect(() => hooks.setFar(o as never)).toThrow(/retired: the far bricks have one build/);
    expect(t.calls).toEqual([]);
  });
});
