/**
 * The material swap view: a swap goes on only after the textures of what
 * the object (or block type) will wear are decoded; a newer swap replaces
 * one still loading; a swap back to the authored materials loads those
 * first too; the hold is let go once the swap is on.
 */
import { describe, expect, it } from 'vitest';

import { MaterialSwapView, type MaterialMappingLike } from './material-swaps';

function harness() {
  const loads: { ids: readonly string[]; resolve: () => void; released: boolean }[] = [];
  const applied: string[] = [];
  const view = new MaterialSwapView({
    entityMapping: (id, swap) => ({ roof: 'mat-day', ...(swap ?? {}) }),
    blockMapping: (id, swap) => ({ '*': 'mat-grass', ...(swap ?? {}) }),
    textureRefs: (m) => [`tex-${m}`],
    preload: (ids) => {
      let resolve = (): void => undefined;
      const ready = new Promise<void>((r) => (resolve = r));
      const entry = { ids, resolve, released: false };
      loads.push(entry);
      return { ready, release: () => void (entry.released = true) };
    },
    applyEntity: (id) => void applied.push(`${id}:${JSON.stringify(view.swapOf(id))}`),
    applyBlockTypes: () => void applied.push(`blocks:${JSON.stringify([...view.appliedBlocks()])}`),
  });
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { view, loads, applied, tick };
}

const map = (entries: [string, MaterialMappingLike][]): ReadonlyMap<string, MaterialMappingLike> => new Map(entries);

describe('MaterialSwapView', () => {
  it('puts a swap on only once its textures are decoded, then lets the hold go', async () => {
    const h = harness();
    h.view.update(map([['house', { roof: 'mat-burnt' }]]), undefined);
    expect(h.loads.map((l) => l.ids)).toEqual([['tex-mat-burnt']]);
    await h.tick();
    expect(h.applied).toEqual([]);
    expect(h.view.swapOf('house')).toBeNull();
    expect(h.view.pending()).toBe(1);
    // The same list again starts nothing new.
    h.view.update(map([['house', { roof: 'mat-burnt' }]]), undefined);
    expect(h.loads).toHaveLength(1);
    h.loads[0]!.resolve();
    await h.tick();
    expect(h.applied).toEqual(['house:{"roof":"mat-burnt"}']);
    expect(h.loads[0]!.released).toBe(true);
    expect(h.view.pending()).toBe(0);
    // Back to the authored materials: what it will wear is loaded first too.
    h.view.update(map([]), undefined);
    expect(h.loads[1]!.ids).toEqual(['tex-mat-day']);
    expect(h.applied).toHaveLength(1);
    h.loads[1]!.resolve();
    await h.tick();
    expect(h.applied.at(-1)).toBe('house:null');
  });

  it('a newer swap replaces one still loading (the older load is let go and never put on)', async () => {
    const h = harness();
    h.view.update(map([['house', { roof: 'mat-burnt' }]]), undefined);
    h.view.update(map([['house', { roof: 'mat-night' }]]), undefined);
    expect(h.loads[0]!.released).toBe(true);
    h.loads[0]!.resolve();
    await h.tick();
    expect(h.applied).toEqual([]);
    h.loads[1]!.resolve();
    await h.tick();
    expect(h.applied).toEqual(['house:{"roof":"mat-night"}']);
  });

  it('block types: every changed type loads what it will wear, then all go on together', async () => {
    const h = harness();
    h.view.update(undefined, map([['grass', { '*': 'mat-ash' }]]));
    expect(h.loads[0]!.ids).toEqual(['tex-mat-ash']);
    expect(h.applied).toEqual([]);
    h.loads[0]!.resolve();
    await h.tick();
    expect(h.applied).toEqual(['blocks:[["grass",{"*":"mat-ash"}]]']);
    h.view.update(undefined, map([]));
    expect(h.loads[1]!.ids).toEqual(['tex-mat-grass']);
  });
});
