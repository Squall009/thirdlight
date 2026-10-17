/**
 * The counting half of the occlusion oracle (occlusion-oracle.ts): every item
 * the view draws (a drawable, an instance copy, a merged cell's member) is
 * given an id, drawn with it into an id target, and the ids left with at
 * least one pixel are the items seen. What is drawn but never seen is the
 * most occlusion culling could save. Pure: no three.js, no GPU.
 *
 * An id is 24 bits in a pixel's red, green and blue bytes (alpha marks a
 * written pixel), so the shader can build it with float arithmetic, which is
 * exact up to 2^24.
 */

/** Ids run from 1 (0 is the cleared background) to below this. */
export const ORACLE_ID_LIMIT = 2 ** 24;

/** What an item is, as occlusion culling would test it. */
export type OracleKind = 'instanced' | 'merged' | 'single' | 'transparent';
export const ORACLE_KINDS: readonly OracleKind[] = ['instanced', 'merged', 'single', 'transparent'];

/** One drawable as the view drew it: its ids `base … base + count - 1`, one per item. */
export interface OracleEntry {
  readonly kind: OracleKind;
  readonly base: number;
  /** Items the view drew (copies, members, or 1). */
  readonly count: number;
  /** Triangles of each item: one number for all of them, or one per item (0: the item was not drawn). */
  readonly triangles: number | ArrayLike<number>;
  /** Draw calls the drawable issues (one per material group). */
  readonly draws: number;
}

export interface OracleShare {
  items: number;
  hiddenItems: number;
  draws: number;
  /** Draws none of whose items has a visible pixel. */
  hiddenDraws: number;
  triangles: number;
  hiddenTriangles: number;
}

export interface OracleCount {
  total: OracleShare;
  byKind: Record<OracleKind, OracleShare>;
  /** Written pixels whose id belongs to no entry (a sign the ids did not survive the target unchanged). */
  stray: number;
  /** Pixels written at all. */
  covered: number;
}

/** The id's colour bytes. */
export function oracleIdBytes(id: number): [number, number, number] {
  return [id % 256, Math.floor(id / 256) % 256, Math.floor(id / 65536) % 256];
}

/** The id an RGBA pixel at byte offset `o` holds (0: none written). */
export function oracleIdAt(px: ArrayLike<number>, o: number): number {
  if (px[o + 3] === 0) return 0;
  return px[o]! + px[o + 1]! * 256 + px[o + 2]! * 65536;
}

const emptyShare = (): OracleShare => ({ items: 0, hiddenItems: 0, draws: 0, hiddenDraws: 0, triangles: 0, hiddenTriangles: 0 });

/**
 * Count what is seen: `targets` are RGBA8 pictures of the same view (the
 * opaque items in one, the transparent ones over the opaque depth in
 * another); an id seen in any of them is visible.
 */
export function countOracle(entries: readonly OracleEntry[], targets: readonly ArrayLike<number>[]): OracleCount {
  let top = 1;
  for (const e of entries) top = Math.max(top, e.base + e.count);
  const seen = new Uint8Array(top);
  let stray = 0;
  let covered = 0;
  for (const px of targets) {
    for (let o = 0; o + 3 < px.length; o += 4) {
      const id = oracleIdAt(px, o);
      if (id === 0) continue;
      covered += 1;
      if (id < top) seen[id] = 1;
      else stray += 1;
    }
  }
  // An id inside the range but owned by no entry is stray too.
  const owned = new Uint8Array(top);
  for (const e of entries) owned.fill(1, e.base, e.base + e.count);
  for (let id = 1; id < top; id += 1) if (seen[id] === 1 && owned[id] === 0) stray += 1;

  const total = emptyShare();
  const byKind = Object.fromEntries(ORACLE_KINDS.map((k) => [k, emptyShare()])) as Record<OracleKind, OracleShare>;
  for (const e of entries) {
    if (e.count <= 0) continue;
    const share = byKind[e.kind];
    let anySeen = false;
    for (let i = 0; i < e.count; i += 1) {
      const tris = typeof e.triangles === 'number' ? e.triangles : (e.triangles[i] ?? 0);
      // An item given no triangles was not drawn (a merged member outside the view's range): neither seen nor hidden.
      if (typeof e.triangles !== 'number' && tris === 0) continue;
      const hidden = seen[e.base + i] !== 1;
      if (!hidden) anySeen = true;
      for (const s of [share, total]) {
        s.items += 1;
        s.triangles += tris;
        if (hidden) {
          s.hiddenItems += 1;
          s.hiddenTriangles += tris;
        }
      }
    }
    for (const s of [share, total]) {
      s.draws += e.draws;
      if (!anySeen) s.hiddenDraws += e.draws;
    }
  }
  return { total, byKind, stray, covered };
}

/** The entries none of whose drawn items has a pixel in `targets` (whole draws an ideal culling would skip). */
export function hiddenEntries(entries: readonly OracleEntry[], targets: readonly ArrayLike<number>[]): OracleEntry[] {
  const seen = new Set<number>();
  for (const px of targets) for (let o = 0; o + 3 < px.length; o += 4) seen.add(oracleIdAt(px, o));
  return entries.filter((e) => {
    for (let i = 0; i < e.count; i += 1) {
      if (typeof e.triangles !== 'number' && (e.triangles[i] ?? 0) === 0) continue;
      if (seen.has(e.base + i)) return false;
    }
    return e.count > 0;
  });
}

/**
 * Triangles per member of a merged draw: the drawn index range
 * `[start, start + count)` read three entries at a time, each triangle given
 * to the member whose vertex range holds its first vertex (`vStarts`
 * ascending, one per member; a member's vertices are its own).
 */
export function memberTriangles(index: ArrayLike<number>, start: number, count: number, vStarts: ArrayLike<number>): Float64Array {
  const out = new Float64Array(vStarts.length);
  const end = Math.min(index.length, start + count);
  for (let i = start; i + 2 < end; i += 3) {
    const v = index[i]!;
    let lo = 0;
    let hi = vStarts.length - 1;
    if (hi < 0 || v < vStarts[0]!) continue;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (vStarts[mid]! <= v) lo = mid;
      else hi = mid - 1;
    }
    out[lo]! += 1;
  }
  return out;
}

/** A share as fractions (0–1) of what was drawn: items, draws, triangles. */
export function hiddenFractions(s: OracleShare): { items: number; draws: number; triangles: number } {
  const f = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);
  return { items: f(s.hiddenItems, s.items), draws: f(s.hiddenDraws, s.draws), triangles: f(s.hiddenTriangles, s.triangles) };
}
