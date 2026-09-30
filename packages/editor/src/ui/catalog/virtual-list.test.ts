/**
 * The virtual list's arithmetic: the columns a CSS auto-fill grid makes in a
 * width, and the rows drawn for a scroll position (with rows either side) —
 * a list of any length draws a screenful.
 */
import { describe, expect, it } from 'vitest';

import { gridColumns, visibleRange } from './VirtualList';

describe('the virtual list', () => {
  it('lays out as many columns as an auto-fill grid does', () => {
    // 112 px tiles, 8 px gaps, 8 px padding: 8 + 7 × 120 − 8 + 8 = 848 px fits 7.
    expect(gridColumns(848, 112, 8, 8)).toBe(7);
    expect(gridColumns(847, 112, 8, 8)).toBe(6);
    expect(gridColumns(50, 112, 8, 8)).toBe(1);
  });

  it('draws the rows in view and a few either side, however long the list', () => {
    const r = visibleRange({ count: 18_000, columns: 6, stride: 120, padding: 8, scrollTop: 120 * 1000 + 8, height: 600, overscan: 3 });
    expect(r.rows).toBe(3000);
    expect([r.firstRow, r.lastRow]).toEqual([997, 1008]);
    // The end of the list clamps.
    const end = visibleRange({ count: 10, columns: 3, stride: 50, padding: 0, scrollTop: 0, height: 1000, overscan: 2 });
    expect([end.firstRow, end.lastRow, end.rows]).toEqual([0, 4, 4]);
  });
});
