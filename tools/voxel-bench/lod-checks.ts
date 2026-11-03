/**
 * Brute-force checks of a set of drawn level nodes, independent of how the
 * level choice works: every node expanded to the level-0 chunks it covers.
 * - doubled: chunks covered by more than one drawn node;
 * - unbalanced: node faces with a node more than one level apart across them
 *   (the seams join only neighbouring levels);
 * - covered: chunk key → the level of the node drawn over it.
 */
import type { LevelNode } from '@thirdlight/voxel';

export interface LevelCheck {
  readonly doubled: number;
  readonly unbalanced: number;
  readonly covered: Map<string, number>;
}

export const chunkId = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

/** The level-0 chunks a node covers. */
export function* nodeChunks(n: LevelNode): IterableIterator<[number, number, number]> {
  const s = 2 ** n.level;
  for (let x = 0; x < s; x++) for (let y = 0; y < s; y++) for (let z = 0; z < s; z++) yield [n.nx * s + x, n.ny * s + y, n.nz * s + z];
}

export function checkLevels(nodes: Iterable<LevelNode>): LevelCheck {
  const covered = new Map<string, number>();
  const list = [...nodes];
  let doubled = 0;
  for (const n of list) {
    for (const [x, y, z] of nodeChunks(n)) {
      const id = chunkId(x, y, z);
      if (covered.has(id)) doubled++;
      covered.set(id, n.level);
    }
  }
  let unbalanced = 0;
  for (const n of list) {
    const s = 2 ** n.level;
    const base = [n.nx * s, n.ny * s, n.nz * s];
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const inPlane = [0, 1, 2].filter((a) => a !== axis);
      let bad = false;
      for (let i = 0; i < s && !bad; i++) for (let j = 0; j < s && !bad; j++) {
        const c = [0, 0, 0];
        c[axis] = f & 1 ? base[axis]! + s : base[axis]! - 1;
        c[inPlane[0]!] = base[inPlane[0]!]! + i;
        c[inPlane[1]!] = base[inPlane[1]!]! + j;
        const l = covered.get(chunkId(c[0]!, c[1]!, c[2]!));
        if (l !== undefined && Math.abs(l - n.level) > 1) bad = true;
      }
      if (bad) unbalanced++;
    }
  }
  return { doubled, unbalanced, covered };
}
