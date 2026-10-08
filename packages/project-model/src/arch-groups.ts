/**
 * An `architecture` object's outlines in groups that expand alone, and the
 * groups' expansions remembered across edits.
 *
 * Outlines meet only where rooms share walls (their outlines' ground boxes
 * touch) and where rooms stand in a building (their own, or its program's).
 * A group is a set of outlines closed under both, so expanding each group
 * alone makes exactly what expanding them together makes. An edit (one
 * building's seed, one wall dragged, a slider over one preset) changes the
 * inputs of the groups it reaches; every other group's expansion, and with
 * it every element object it made, is the one made before: the chunk keys
 * hash only elements they have not seen (`arch-generate.ts`).
 *
 * Pure apart from the memory (a cache's bound, never a project's).
 */
import type { ArchitectureStyles } from './arch-style';
import type { ArchitectureComponent, ArchitectureElement, ArchitectureOutline } from './architecture';

/** Box sides closer than this touch (metres): outlines are drawn on cells, so walls that meet share exact lines. */
const TOUCH = 1e-4;

/**
 * The groups of `outlines` (indices, each group in list order; groups in
 * the order of their first outline): outlines whose ground boxes touch
 * (closed ones, at any height) and rooms with the building they name
 * (`building`, an outline flagged in `buildings`) are in one group.
 */
export function architectureOutlineGroups(outlines: readonly ArchitectureOutline[], buildings: readonly boolean[]): number[][] {
  const n = outlines.length;
  const parent = Int32Array.from({ length: n }, (_v, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) parent[rb] = ra;
    else if (rb < ra) parent[ra] = rb;
  };
  // A building's rooms: the last building of an id is the one rooms name (as the expansion reads them).
  const byId = new Map<string, number>();
  outlines.forEach((o, i) => {
    if (buildings[i] === true) byId.set(o.id, i);
  });
  outlines.forEach((o, i) => {
    if (buildings[i] === true || o.building === undefined) return;
    const b = byId.get(o.building);
    if (b !== undefined) union(i, b);
  });
  // Closed outlines whose ground boxes touch, found by a sweep along x.
  const boxes: [number, number, number, number, number][] = [];
  outlines.forEach((o, i) => {
    if (o.path.closed !== true || o.path.points.length < 3) return;
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of o.path.points) [x0, z0, x1, z1] = [Math.min(x0, q[0]), Math.min(z0, q[2]), Math.max(x1, q[0]), Math.max(z1, q[2])];
    boxes.push([x0 - TOUCH, z0 - TOUCH, x1 + TOUCH, z1 + TOUCH, i]);
  });
  boxes.sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  for (let k = 0; k < boxes.length; k++) {
    const a = boxes[k]!;
    for (let m = k + 1; m < boxes.length && boxes[m]![0] <= a[2]; m++) {
      const b = boxes[m]!;
      if (a[1] > b[3] || b[1] > a[3]) continue;
      union(a[4], b[4]);
    }
  }
  const groups: number[][] = [];
  const at = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = at.get(r);
    if (g === undefined) {
      at.set(r, (g = []));
      groups.push(g);
    }
    g.push(i);
  }
  return groups;
}

/** Group expansions remembered per style table (a table read again is new: nothing it made is found), by key. */
const kept = new WeakMap<ArchitectureStyles, Map<string, unknown>>();
/** Group expansions remembered per table at least (more while one object has more groups: its own edits must find theirs). */
const GROUPS_KEPT = 4096;

/** The group expansions remembered for `table`: `get` marks one used; `set` keeps at least twice `groups` (the asking object's count). */
export function rememberedGroups<T>(table: ArchitectureStyles): { get(key: string): T | undefined; set(key: string, value: T, groups: number): void } {
  let memo = kept.get(table);
  if (memo === undefined) kept.set(table, (memo = new Map()));
  const m = memo;
  return {
    get(key: string): T | undefined {
      const hit = m.get(key) as T | undefined;
      if (hit !== undefined) {
        // Most recently used last.
        m.delete(key);
        m.set(key, hit);
      }
      return hit;
    },
    set(key: string, value: T, groups: number): void {
      m.set(key, value);
      const bound = Math.max(GROUPS_KEPT, groups * 2);
      while (m.size > bound) m.delete(m.keys().next().value!);
    },
  };
}

/** What of the component besides its outlines a group's expansion reads: masks (by the object's place), floors on cells, the interior part, its own profiles, swaps. */
export function groupContextText(c: ArchitectureComponent, origin: readonly number[], swaps: Readonly<Record<string, string>> | null | undefined): string {
  return JSON.stringify([origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0, c.layer !== undefined, c.interiorOf !== undefined, swaps ?? null, c.profiles ?? null, c.masks ?? null]);
}

/** Elements made before, by their text, per style table: a group expanded again hands back the ones that came out the same. */
const interned = new WeakMap<ArchitectureStyles, Map<string, ArchitectureElement>>();
/** Elements remembered per table at least (more while one object makes more: its own must find theirs). */
const ELEMENTS_KEPT = 16384;

/**
 * The elements a group made, each that is the same as one made before (by
 * its text) replaced by that one: a wall dragged in a block of rooms that
 * share walls re-expands the block, and its unchanged walls and floors stay
 * the objects the chunk keys have hashed. `elements`: how many the object
 * makes in all.
 */
export function internElements(table: ArchitectureStyles, made: readonly ArchitectureElement[], elements: number): ArchitectureElement[] {
  let memo = interned.get(table);
  if (memo === undefined) interned.set(table, (memo = new Map()));
  const out = made.map((e) => {
    const text = JSON.stringify(e);
    const known = memo.get(text);
    if (known !== undefined) {
      // Most recently used last.
      memo.delete(text);
      memo.set(text, known);
      return known;
    }
    memo.set(text, e);
    return e;
  });
  const bound = Math.max(ELEMENTS_KEPT, elements * 2);
  while (memo.size > bound) memo.delete(memo.keys().next().value!);
  return out;
}
