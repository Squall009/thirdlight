/**
 * The bench's speck count on made pictures: a grey wall with a white, a green and a black speck counts one of each in
 * three clusters; a speck of two touching pixels is one cluster; a black pixel in a dark area (a window's inside, a
 * shadow) is no speck, nor is a dark pixel at the picture's edge; a picture of plain wall counts none.
 */
import { describe, expect, it } from 'vitest';
import { speckCounts } from './specks';
import type { Picture } from './lighting-cameras';

function picture(w: number, h: number, fill: [number, number, number], set: Array<[number, number, [number, number, number]]> = []): Picture {
  const px = new Map(set.map(([x, y, c]) => [y * w + x, c] as const));
  return { width: w, height: h, pixel: (x, y) => [...(px.get(y * w + x) ?? fill), 255] as [number, number, number, number] };
}

describe('speckCounts', () => {
  it('counts white, green and black specks on a grey wall, each in its own cluster', () => {
    const img = picture(20, 12, [120, 110, 100], [[3, 3, [250, 248, 240]], [10, 5, [60, 200, 70]], [15, 8, [4, 3, 6]]]);
    expect(speckCounts(img)).toEqual({ white: 1, green: 1, black: 1, clusters: 3 });
  });

  it('joins touching speck pixels into one cluster, whatever their kind', () => {
    const img = picture(20, 12, [120, 110, 100], [[5, 5, [250, 250, 250]], [6, 6, [60, 200, 70]], [7, 6, [250, 250, 250]]]);
    expect(speckCounts(img)).toEqual({ white: 2, green: 1, black: 0, clusters: 1 });
  });

  it('does not count black where it is dark round the pixel, nor at the picture\'s edge', () => {
    const dark: Array<[number, number, [number, number, number]]> = [];
    for (let y = 2; y < 9; y++) for (let x = 2; x < 9; x++) dark.push([x, y, [5, 5, 5]]);
    const img = picture(20, 12, [120, 110, 100], [...dark, [0, 6, [2, 2, 2]], [19, 0, [1, 1, 1]]]);
    expect(speckCounts(img).black).toBe(0);
  });

  it('counts nothing on a plain wall or plain grass', () => {
    expect(speckCounts(picture(16, 16, [120, 110, 100]))).toEqual({ white: 0, green: 0, black: 0, clusters: 0 });
    expect(speckCounts(picture(16, 16, [70, 140, 60]))).toEqual({ white: 0, green: 0, black: 0, clusters: 0 });
  });
});
