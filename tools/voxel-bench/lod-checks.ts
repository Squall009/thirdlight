/**
 * Brute-force checks of a set of drawn level nodes, independent of how the
 * level choice works: every node expanded to the level-0 chunks it covers.
 * - doubled: chunks covered by more than one drawn node;
 * - unbalanced: node faces with a node more than one level apart across
 *   them (the seams join only neighbouring levels);
 * - unbalancedAround: the same across node edges and corners (a seam's rim
 *   reads those neighbours);
 * - covered: chunk key → the level of the node drawn over it.
 */
import type { LevelNode } from '@thirdlight/voxel';

export interface LevelCheck {
  readonly doubled: number;
  readonly unbalanced: number;
  readonly unbalancedAround: number;
  readonly covered: Map<string, number>;
}

/** The 26 directions to a node's face, edge and corner neighbours. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [-1, 0, 1].flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => [x, y, z] as const))).filter(([x, y, z]) => x !== 0 || y !== 0 || z !== 0);

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
  let unbalancedAround = 0;
  for (const n of list) {
    const s = 2 ** n.level;
    const base = [n.nx * s, n.ny * s, n.nz * s];
    for (const d of NEIGHBOURS) {
      // The chunks beside the node in direction d: one layer past it on each axis d moves along, all of it on the others.
      const span = d.map((v, a) => (v === 1 ? [base[a]! + s] : v === -1 ? [base[a]! - 1] : Array.from({ length: s }, (_, i) => base[a]! + i)));
      let bad = false;
      for (const x of span[0]!) for (const y of span[1]!) for (const z of span[2]!) {
        const l = covered.get(chunkId(x, y, z));
        if (l !== undefined && Math.abs(l - n.level) > 1) bad = true;
      }
      if (!bad) continue;
      if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) === 1) unbalanced++;
      else unbalancedAround++;
    }
  }
  return { doubled, unbalanced, unbalancedAround, covered };
}
