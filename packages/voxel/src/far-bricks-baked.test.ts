/**
 * Baked far bricks: the encoding gives back the builder's arrays exactly
 * (and refuses other bytes), and an edit's stale brick nodes are the node
 * over the change at each level with the neighbours across the sides its
 * build reads, no more.
 */
import { describe, expect, it } from 'vitest';
import { decodeFarBricks, encodeFarBricks, farBrickDirty, farBrickJobCells, FAR_BRICKS_BLOB_VERSION } from './far-bricks-baked';
import { farBricksFromFaces } from './far-bricks-faces';
import { FAR_BRICK_BUILD, type FarBricks } from './far-bricks';
import { farBrickOcclusion } from './far-bricks-shade';
import { chunkGrid } from './coords';
import { createWorldStore } from './palette-store';
import { readValue, recordValue, VOXEL_ROLE, SHAPE_FULL } from './record';
import { mipNodeKey } from './voxel-mips';

const g = chunkGrid(32);

function hill(): FarBricks {
  const store = createWorldStore(g);
  const rock = readValue(recordValue(3, VOXEL_ROLE.terrain, SHAPE_FULL, 2), { material: 0, role: 0, shape: 0, wetness: 0 });
  for (let x = -4; x < 40; x++) for (let z = -4; z < 40; z++) {
    const top = 6 + Math.round(4 * Math.sin(x / 5) + 3 * Math.cos(z / 7));
    for (let y = -4; y < top; y++) store.setVoxel(x, y, z, rock);
  }
  const b = farBricksFromFaces(g, store, [0, 0, 0], 1);
  return { ...b, occlusion: farBrickOcclusion(b) };
}

describe('baked far bricks', () => {
  it('encode to bytes that decode to the same arrays, and refuse other bytes', () => {
    const b = hill();
    expect(b.samples.length).toBeGreaterThan(0);
    const bytes = encodeFarBricks(b);
    expect(bytes[4]).toBe(FAR_BRICKS_BLOB_VERSION);
    const d = decodeFarBricks(bytes);
    expect(d).toEqual(b);
    expect(encodeFarBricks(d)).toEqual(bytes);
    const { occlusion: _none, ...plain } = b;
    expect(decodeFarBricks(encodeFarBricks(plain)).occlusion).toBeUndefined();
    const other = bytes.slice();
    other[4] = FAR_BRICKS_BLOB_VERSION + 1;
    expect(() => decodeFarBricks(other)).toThrow(/version/);
    expect(() => decodeFarBricks(bytes.slice(0, bytes.length - 1))).toThrow();
  });

  it('read the cells the far field sends: finer nodes above the lowest level, the node and its neighbours at it', () => {
    const asked: string[] = [];
    const j = farBrickJobCells({ level: 3, nx: 1, ny: 0, nz: -1 }, FAR_BRICK_BUILD, 2, (m) => (asked.push(mipNodeKey(m)), null));
    expect(j.fine).toMatchObject({ level: 2, scale: 2 });
    expect(asked).toHaveLength(64);
    expect(asked).toContain('2:1,-1,-3');
    expect(asked).toContain('2:4,2,0');
    asked.length = 0;
    const low = farBrickJobCells({ level: 2, nx: 0, ny: 0, nz: 0 }, FAR_BRICK_BUILD, 2, (m) => (asked.push(mipNodeKey(m)), null));
    expect(low.fine).toBeUndefined();
    expect(asked).toHaveLength(27);
  });

  it('make stale the node over an edit at each level and the neighbours across the sides its build reads', () => {
    // A chunk in the middle of level-2 node (1, 1, 1) (chunks 4–7 an axis): its level-2 node and the 26 round it at
    // level 2 (built from their own cells, read one node out); at level 3 the parent and the parents across the side
    // the level-2 node lies on (it is always on one: a level-3 build reads 2 × 2 level-2 nodes and one round them).
    const dirty = farBrickDirty([{ cx: 5, cy: 5, cz: 5 }], 32, FAR_BRICK_BUILD, 2, 5);
    const at = (l: number) => dirty.filter((n) => n.level === l).map(mipNodeKey).sort();
    expect(at(2)).toHaveLength(27);
    expect(at(2)).toContain('2:0,0,0');
    expect(at(2)).toContain('2:2,2,2');
    // Level-2 node 1 is the upper of level-3 node 0's two, so level-3 nodes 0 and 1 read it an axis.
    expect(at(3)).toEqual(['3:0,0,0', '3:0,0,1', '3:0,1,0', '3:0,1,1', '3:1,0,0', '3:1,0,1', '3:1,1,0', '3:1,1,1']);
    expect(at(4)).toHaveLength(8);
    expect(at(5)).toHaveLength(8);
    // Never a node whose read box misses the change: level-3 node 2 reads level-2 nodes 3 … 6 an axis.
    expect(at(3)).not.toContain('3:2,0,0');
  });
});
