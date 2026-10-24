/**
 * The slot table the batched GPU passes read (no GPU): how many plays a
 * batch holds, where each play's values sit, what a step writes and clears,
 * and which slots are handed out.
 */
import { describe, expect, it } from 'vitest';

import { MAX_RUNS } from './effects-gpu';
import { batchSlots, clearSlotSteps, GPU_BATCH_PARTICLES, GPU_BATCH_SLOTS, SLOT_ROW, SlotPool, slotLayout, slotTable, writeSlotConstants, writeSlotSpawn, writeSlotStep } from './effects-gpu-batch';

const row = (t: ReturnType<typeof slotTable>, slot: number, r: number): number[] => [...t.floats.subarray((slot * t.layout.rows + r) * 4, (slot * t.layout.rows + r) * 4 + 4)];

describe('GPU effect batches: the slot table', () => {
  it('sizes a batch by its plays\' particles, within the slot ceiling', () => {
    expect(batchSlots(160)).toBe(GPU_BATCH_SLOTS);
    expect(batchSlots(2500)).toBe(Math.floor(GPU_BATCH_PARTICLES / 2500));
    expect(batchSlots(GPU_BATCH_PARTICLES)).toBe(1);
    expect(batchSlots(262_144)).toBe(1);
    expect(batchSlots(0)).toBe(GPU_BATCH_SLOTS);
  });

  it('lays out a slot: fixed rows, then one row a parameter, then births and runs per GPU system', () => {
    const l = slotLayout([{ key: 'heat', type: 'float' }, { key: 'tint', type: 'color' }], 2);
    expect(l.params.get('heat')).toEqual({ row: SLOT_ROW.params, type: 'float' });
    expect(l.params.get('tint')).toEqual({ row: SLOT_ROW.params + 1, type: 'color' });
    expect(l.spawn).toEqual([SLOT_ROW.params + 2, SLOT_ROW.params + 2 + 1 + MAX_RUNS]);
    expect(l.rows).toBe(SLOT_ROW.params + 2 + 2 * (1 + MAX_RUNS));
  });

  it('writes a step into its own slot only, births capped at the capacity, serial numbers with all 32 bits', () => {
    const t = slotTable(slotLayout([], 2), 3);
    const origin = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [2, 2, 2] as [number, number, number] };
    writeSlotStep(t, 1, { dt: 0.5, time: 0.25, worldTime: 9, flags: 1, current: origin, previousPosition: [0, 1, 2] });
    writeSlotSpawn(t, 1, 0, 64, { serialBase: 0xfffffff0, count: 100, runs: [{ count: 30, distance: true }, { count: 70, distance: false }] });
    writeSlotSpawn(t, 1, 1, 48, { serialBase: 7, count: 3, runs: [{ count: 3, distance: false }] });
    expect(row(t, 1, SLOT_ROW.time)).toEqual([0.5, 0.25, 9, 1]);
    expect(row(t, 1, SLOT_ROW.position).slice(0, 3)).toEqual([1, 2, 3]);
    expect(row(t, 1, SLOT_ROW.scale).slice(0, 3)).toEqual([2, 2, 2]);
    expect(row(t, 1, SLOT_ROW.previous).slice(0, 3)).toEqual([0, 1, 2]);
    const s0 = t.layout.spawn[0]!;
    expect(row(t, 1, s0)[0]).toBe(64);
    expect(t.bits[(1 * t.layout.rows + s0) * 4 + 1]).toBe(0xfffffff0);
    // Runs: start, count, distance — in spawn order, each starting where the last ended.
    expect(row(t, 1, s0 + 1).slice(0, 3)).toEqual([0, 30, 1]);
    expect(row(t, 1, s0 + 2).slice(0, 3)).toEqual([30, 70, 0]);
    expect(row(t, 1, s0 + 3).slice(0, 3)).toEqual([100, 0, 0]);
    expect(t.bits[(1 * t.layout.rows + t.layout.spawn[1]!) * 4 + 1]).toBe(7);
    // The neighbours are untouched.
    for (const slot of [0, 2]) expect([...t.floats.subarray(slot * t.layout.rows * 4, (slot + 1) * t.layout.rows * 4)].every((v) => v === 0)).toBe(true);
    // After the dispatch the slot idles (no flags, no births) but keeps where it is.
    clearSlotSteps(t, [1]);
    expect(row(t, 1, SLOT_ROW.time)[3]).toBe(0);
    expect(row(t, 1, s0)[0]).toBe(0);
    expect(row(t, 1, t.layout.spawn[1]!)[0]).toBe(0);
    expect(row(t, 1, SLOT_ROW.position).slice(0, 3)).toEqual([1, 2, 3]);
    // No plan: no births.
    writeSlotSpawn(t, 1, 0, 64, undefined);
    expect(row(t, 1, s0)[0]).toBe(0);
  });

  it('writes a play\'s parameters (colour alpha 1 by default) and its wind (direction on the ground plane, normalised)', () => {
    const t = slotTable(slotLayout([{ key: 'heat', type: 'float' }, { key: 'tint', type: 'color' }, { key: 'push', type: 'vec3' }], 0), 2);
    const values: Record<string, number[]> = { heat: [3], tint: [0.5, 0.25, 1], push: [1, 2, 3] };
    writeSlotConstants(t, 1, (k) => values[k] ?? null, { direction: [3, 4], strength: 2, gust: 0.5, gustFrequency: 0.25, turbulence: 0.1 });
    expect(row(t, 1, SLOT_ROW.params)).toEqual([3, 0, 0, 0]);
    expect(row(t, 1, SLOT_ROW.params + 1)).toEqual([0.5, 0.25, 1, 1]);
    expect(row(t, 1, SLOT_ROW.params + 2)).toEqual([1, 2, 3, 0]);
    const w = row(t, 1, SLOT_ROW.wind);
    expect(w[0]).toBeCloseTo(0.6);
    expect(w[1]).toBe(0);
    expect(w[2]).toBeCloseTo(0.8);
    expect(w[3]).toBe(2);
    expect(row(t, 1, SLOT_ROW.gust)).toEqual([0.5, 0.25, expect.closeTo(0.1), 0]);
  });

  it('hands out the lowest free slot; the uploaded extent ends after the highest slot in use', () => {
    const pool = new SlotPool(4);
    expect(pool.extent).toBe(0);
    expect([pool.acquire(), pool.acquire(), pool.acquire()]).toEqual([0, 1, 2]);
    expect(pool.extent).toBe(3);
    pool.release(1);
    expect(pool.used).toBe(2);
    expect(pool.extent).toBe(3);
    pool.release(2);
    expect(pool.extent).toBe(1);
    expect(pool.acquire()).toBe(1);
    expect(pool.acquire()).toBe(2);
    expect(pool.acquire()).toBe(3);
    expect(pool.acquire()).toBeNull();
  });
});
